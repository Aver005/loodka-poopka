/**
 * Тесты детектора расписания.
 *
 * Сценарии взяты из реальных листингов 26–27 июля, включая тот, на котором
 * я один раз ошибся в рассуждении: круговой турнир Urban Riga выглядел как
 * сильнейший случай усталости, хотя там устают все одинаково.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildListingBrief, fairP1, findAsymmetries, formatDuration, LISTING_CONTAINERS,
  mergeListings, parseCountdown, parseListingHtml, publicBias, sortByStart, teamLoads,
  type ListingMatch,
} from './listing';

const H = 60 * 60_000;

const listingHtml = () =>
  Bun.file(new URL('./__fixtures__/listing.html', import.meta.url)).text();

let seq = 0;
const match = (p: Partial<ListingMatch> & Pick<ListingMatch, 'team1' | 'team2' | 'startsInMs'>): ListingMatch => ({
  id: `m${++seq}`,
  teamId1: null,
  teamId2: null,
  odds1: null,
  odds2: null,
  publicPct1: null,
  publicPct2: null,
  tournament: 'CCT EU',
  format: 'BO3',
  startsAt: null,
  liveBetting: false,
  ...p,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('разбор листинга', () => {
  test('снимает все страницы за один заход', async () => {
    // Слайдер держит все страницы в DOM сразу, а не подгружает по клику.
    // Значит листать не нужно и лишних запросов к сайту не будет.
    const ms = parseListingHtml(await listingHtml());
    expect(ms.length).toBe(43);
    expect(ms.every((m) => m.team1 && m.team2)).toBe(true);
    expect(ms.every((m) => m.id)).toBe(true);
  });

  test('вытаскивает все поля строки', async () => {
    const ms = parseListingHtml(await listingHtml());
    const m = ms.find((x) => x.team1 === 'ex-RUSTEC' && x.team2 === 'Entropy Gaming')!;
    expect(m.odds1).toBe(1.469);
    expect(m.odds2).toBe(2.435);
    expect(m.publicPct1).toBe(63);
    expect(m.publicPct2).toBe(37);
    expect(m.tournament).toBe('Thunderpick');
    expect(m.format).toBe('BO3');
    expect(m.teamId1).toBe('14993');
    expect(m.startsAt).toBe('07/27/2026 11:00:00');
    expect(m.startsInMs).toBeGreaterThan(0);
  });

  test('различает матчи с доступными live-ставками', async () => {
    const ms = parseListingHtml(await listingHtml());
    expect(ms.some((m) => m.liveBetting)).toBe(true);
    expect(ms.some((m) => !m.liveBetting)).toBe(true);
  });

  test('разбирает таймер с днями и без', () => {
    expect(parseCountdown('00:55:43')).toBe((55 * 60 + 43) * 1000);
    expect(parseCountdown('1д 00:45:15')).toBe((24 * 3600 + 45 * 60 + 15) * 1000);
    expect(parseCountdown('какая-то ерунда')).toBeNull();
  });

  test('«Скоро начнется» — это ноль, а не неизвестность', () => {
    // Раньше отдавалось null, и матч выпадал из `teamLoads`, то есть перестрадал
    // создавать усталость сопернику. Ноль означает «уже начинается»: ставить нечего,
    // но как предыдущая игра команды он учитывается.
    expect(parseCountdown('Скоро начнется')).toBe(0);
    expect(parseCountdown('скоро начинается')).toBe(0);
  });
});

describe('два блока с матчами на странице', () => {
  // Сбор читал только #upcoming и терял блок «ТЕКУЩИЕ МАТЧИ» целиком —
  // а это матчи на старте, самая срочная часть листинга.
  const twoBlocks = () =>
    Bun.file(new URL('./__fixtures__/listing-two-blocks.html', import.meta.url)).text();

  test('перечисляет оба контейнера и текущие идут первыми', () => {
    expect(LISTING_CONTAINERS).toEqual(['#current_matches_block', '#upcoming']);
  });

  test('читает матчи из обоих блоков', async () => {
    const ms = parseListingHtml(await twoBlocks());
    // 33 из четырёх страниц #upcoming + 2 из блока текущих.
    expect(ms.length).toBe(35);
    expect(ms.find((m) => m.team1 === 'Imperial Esports')?.team2).toBe('BESTIA');
    expect(ms.find((m) => m.team1 === 'LAG Gaming')?.team2).toBe('Marsborne');
  });

  test('матч из блока текущих не теряет времени старта', async () => {
    const ms = parseListingHtml(await twoBlocks());
    const m = ms.find((x) => x.team1 === 'Imperial Esports')!;
    expect(m.startsInMs).toBe((42 * 60 + 44) * 1000);
  });

  test('завершённые матчи в разбор не попадают', async () => {
    // У них класс начинается с `finished_event`, поэтому сплит их не видит.
    const ms = parseListingHtml(
      '<div class="finished_event event won_1 csgo_event" data-id="1">' +
        '<a data-raw_id="1" class="left"><span class="team_name">A</span></a>' +
        '<a data-raw_id="2" class="right"><span class="team_name">B</span></a></div>' +
        (await twoBlocks()),
    );
    expect(ms.length).toBe(35);
  });
});

describe('порядок и слияние', () => {
  test('матч с нечитаемым таймером уходит в конец, а не в начало', () => {
    // Наивное `(a.startsInMs ?? 0) - (b.startsInMs ?? 0)` ставило его первым,
    // впереди матча, до которого 40 минут. Отсюда и «листинг не в том порядке».
    const ms = [
      match({ team1: 'C', team2: 'D', startsInMs: null }),
      match({ team1: 'E', team2: 'F', startsInMs: 3 * H }),
      match({ team1: 'A', team2: 'B', startsInMs: 40 * 60_000 }),
    ];
    expect(sortByStart(ms).map((m) => m.team1)).toEqual(['A', 'E', 'C']);
  });

  test('слияние не теряет матчи, которых нет в новом снимке', () => {
    // Слайдер отдаёт то, что сейчас в DOM. Замена превращала полный сбор в огрызок.
    const prev = [
      match({ team1: 'A', team2: 'B', startsInMs: H }),
      match({ team1: 'C', team2: 'D', startsInMs: 2 * H }),
    ];
    const next = [match({ team1: 'E', team2: 'F', startsInMs: 3 * H })];
    expect(mergeListings(prev, next)).toHaveLength(3);
  });

  test('свежие данные по тому же матчу выигрывают', () => {
    const before = match({ id: 'x', team1: 'A', team2: 'B', startsInMs: 2 * H, odds1: 1.5 });
    const after = { ...before, odds1: 1.9, startsInMs: H };
    const merged = mergeListings([before], [after]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.odds1).toBe(1.9);
  });

  test('результат слияния отсортирован по времени старта', () => {
    const merged = mergeListings(
      [match({ team1: 'late', team2: 'x', startsInMs: 5 * H })],
      [match({ team1: 'soon', team2: 'y', startsInMs: H })],
    );
    expect(merged.map((m) => m.team1)).toEqual(['soon', 'late']);
  });
});

describe('деньги публики', () => {
  test('процент — это не пересчитанный кэф', async () => {
    // Честная вероятность алгебраически равна o2/(o1+o2). Если бы процент выводился
    // из цены, отклонение было бы нулевым везде. Оно не нулевое — значит это
    // настоящее распределение ставок.
    const ms = parseListingHtml(await listingHtml()).filter((m) => m.odds1 && m.publicPct1 != null);
    const biases = ms.map((m) => publicBias(m)!).filter((b) => b != null);
    const maxAbs = Math.max(...biases.map(Math.abs));
    expect(maxAbs).toBeGreaterThan(5); // на живых данных доходило до 7.5 п.п.
  });

  test('публика перегружает тяжёлых фаворитов', async () => {
    const ms = parseListingHtml(await listingHtml());
    // Берём матчи с явным фаворитом и смотрим, куда смещена публика.
    const lopsided = ms
      .map((m) => ({ m, fair: fairP1(m), bias: publicBias(m) }))
      .filter((x) => x.fair != null && x.bias != null && x.fair > 0.75);

    expect(lopsided.length).toBeGreaterThan(3);
    // Смещение в сторону фаворита систематическое, а не случайное.
    const towardFavorite = lopsided.filter((x) => x.bias! > 0).length;
    expect(towardFavorite / lopsided.length).toBeGreaterThan(0.7);
  });
});

describe('загрузка команд', () => {
  test('собирает матчи каждой команды по порядку', () => {
    const loads = teamLoads([
      match({ team1: 'ex-RUSTEC', team2: 'Entropy', startsInMs: 1 * H }),
      match({ team1: 'ex-RUBY', team2: 'ex-RUSTEC', startsInMs: 4 * H }),
      match({ team1: 'ex-RUSTEC', team2: 'ICA', startsInMs: 7 * H }),
    ]);
    expect(loads.get('ex-RUSTEC')!.matches).toHaveLength(3);
    expect(loads.get('Entropy')!.matches).toHaveLength(1);
    expect(loads.get('ex-RUSTEC')!.matches.map((m) => m.startsInMs)).toEqual([1 * H, 4 * H, 7 * H]);
  });
});

describe('поиск асимметрии', () => {
  test('находит третий матч подряд против свежего соперника', () => {
    // Реальный случай 27.07: ex-RUSTEC играет три BO3 в трёх турнирах.
    const list = [
      match({ team1: 'ex-RUSTEC', team2: 'Entropy', startsInMs: 1 * H, tournament: 'Thunderpick' }),
      match({ team1: 'ex-RUBY', team2: 'ex-RUSTEC', startsInMs: 4 * H, tournament: 'NODWIN' }),
      match({ team1: 'ex-RUSTEC', team2: 'ICA', startsInMs: 7 * H, odds1: 1.378, odds2: 2.712 }),
    ];

    const found = findAsymmetries(list);
    const third = found.find((a) => a.match.team2 === 'ICA')!;

    expect(third.tired).toBe('ex-RUSTEC');
    expect(third.fresh).toBe('ICA');
    expect(third.priorMatches).toBe(2);
    expect(third.tiredIsFavorite).toBe(true);      // ← вот это и есть перекос
    expect(third.tiredFairP).toBeCloseTo(0.663, 2); // рынок держит их фаворитом
  });

  test('круговой турнир не считается перекосом', () => {
    // Urban Riga: четыре команды играют друг с другом с интервалом в час.
    // Устают одинаково — преимущества нет ни у кого.
    const list = [
      match({ team1: 'Brute', team2: 'Navi Junior', startsInMs: 1 * H, format: 'BO1' }),
      match({ team1: 'mouz NXT', team2: 'LEO', startsInMs: 1 * H, format: 'BO1' }),
      match({ team1: 'Brute', team2: 'mouz NXT', startsInMs: 2 * H, format: 'BO1' }),
      match({ team1: 'Navi Junior', team2: 'LEO', startsInMs: 2 * H, format: 'BO1' }),
      match({ team1: 'Navi Junior', team2: 'mouz NXT', startsInMs: 3 * H, format: 'BO1' }),
      match({ team1: 'Brute', team2: 'LEO', startsInMs: 3 * H, format: 'BO1' }),
    ];
    expect(findAsymmetries(list)).toHaveLength(0);
  });

  test('успевшая отдохнуть команда не считается уставшей', () => {
    // Butterfly 26.07: первый матч в 13:45, второй в 20:00 — это отдых, а не стык.
    const list = [
      match({ team1: 'Butterfly', team2: 'SAW', startsInMs: 1 * H }),
      match({ team1: 'Lavked', team2: 'Butterfly', startsInMs: 9 * H }),
    ];
    expect(findAsymmetries(list)).toHaveLength(0);
  });

  test('наложение серий даёт отрицательный отдых', () => {
    // INOX 26.07: BO3 в 13:45 ушёл на три карты, следующий в 16:51 — встык.
    const list = [
      match({ team1: 'INOX', team2: 'Phantom', startsInMs: 0 }),
      match({ team1: 'INOX', team2: 'G2 Ares', startsInMs: 2 * H, odds1: 1.327, odds2: 2.916 }),
    ];
    const a = findAsymmetries(list)[0]!;
    expect(a.tired).toBe('INOX');
    expect(a.restMs).toBeLessThan(0);        // BO3 длиннее, чем разрыв
    expect(a.tiredIsFavorite).toBe(true);
  });

  test('сортировка ставит самый грубый случай первым', () => {
    const list = [
      match({ team1: 'A', team2: 'B', startsInMs: 0 }),
      match({ team1: 'A', team2: 'C', startsInMs: 3 * H, odds1: 1.35, odds2: 2.9 }),  // 2-й матч, фаворит
      match({ team1: 'D', team2: 'E', startsInMs: 0 }),
      match({ team1: 'D', team2: 'F', startsInMs: 3 * H, odds1: 2.9, odds2: 1.35 }),  // 2-й матч, андердог
    ];
    const found = findAsymmetries(list);
    // Случай, где рынок НЕ заметил графика, должен быть выше.
    expect(found[0]!.tiredIsFavorite).toBe(true);
    expect(found[0]!.match.team1).toBe('A');
  });

  test('доступность live-ставок не исключает матч из анализа', () => {
    // Регресс. Флаг live_betting_upcoming означает «можно ставить в лайве»,
    // а не «матч идёт». Первая версия фильтровала по нему — и из анализа молча
    // выпали главные случаи дня, потому что у них была красная точка в интерфейсе.
    const list = [
      match({ team1: 'ex-RUSTEC', team2: 'Entropy', startsInMs: 0 }),
      match({ team1: 'ex-RUSTEC', team2: 'ICA', startsInMs: 2 * H, liveBetting: true }),
    ];
    const found = findAsymmetries(list);
    expect(found).toHaveLength(1);
    expect(found[0]!.tired).toBe('ex-RUSTEC');
  });

  test('разница в один матч при общей загрузке перекосом не считается', () => {
    // Круговой турнир с неровным числом игр: у Brute на матч больше, чем у соперника,
    // но там перемалывает всех — свежести это сопернику не даёт.
    const list = [
      match({ team1: 'Brute', team2: 'X', startsInMs: 0, format: 'BO1' }),
      match({ team1: 'Brute', team2: 'Y', startsInMs: 1 * H, format: 'BO1' }),
      match({ team1: 'mouz NXT', team2: 'Z', startsInMs: 1 * H, format: 'BO1' }),
      match({ team1: 'Brute', team2: 'mouz NXT', startsInMs: 2 * H, format: 'BO1' }),
    ];
    // Brute: 2 матча позади, mouz NXT: 1. Разрыв в один матч, соперник тоже не свежий.
    expect(findAsymmetries(list).some((a) => a.match.team2 === 'mouz NXT')).toBe(false);
  });
});

describe('бриф листинга', () => {
  test('не содержит коэффициентов', () => {
    const brief = buildListingBrief([
      match({ team1: 'ex-RUSTEC', team2: 'ICA', startsInMs: 7 * H, odds1: 1.378, odds2: 2.712 }),
    ]);
    // Правило слепой оценки: цена не должна попасть в промпт ни в каком виде.
    expect(brief).not.toContain('1.378');
    expect(brief).not.toContain('2.712');
    expect(brief).toContain('ex-RUSTEC');
    expect(brief).toContain('BO3');
  });

  test('выносит перекос расписания отдельным блоком', () => {
    const brief = buildListingBrief([
      match({ team1: 'ex-RUSTEC', team2: 'Entropy', startsInMs: 1 * H }),
      match({ team1: 'ex-RUSTEC', team2: 'ICA', startsInMs: 4 * H }),
    ]);
    expect(brief).toContain('Перекос расписания');
    expect(brief).toContain('**ex-RUSTEC**');
  });
});

describe('формат длительности', () => {
  test('часы, минуты и наложение', () => {
    expect(formatDuration(2.5 * H)).toBe('2 ч 30 мин');
    expect(formatDuration(45 * 60_000)).toBe('45 мин');
    expect(formatDuration(-30 * 60_000)).toBe('−30 мин');
    expect(formatDuration(Infinity)).toBe('—');
  });

  test('никогда не показывает 60 минут', () => {
    // Живой баг: в брифе стояло «2 ч 60 мин» вместо «3 ч 0 мин». Часы брались
    // через floor, минуты округлялись отдельно, и остаток 59.7 мин давал 60.
    expect(formatDuration(2 * 3_600_000 + 59.7 * 60_000)).toBe('3 ч 0 мин');
    expect(formatDuration(59.7 * 60_000)).toBe('1 ч 0 мин');
    expect(formatDuration(2 * 3_600_000 + 59.4 * 60_000)).toBe('2 ч 59 мин');
    for (let ms = 0; ms < 6 * 3_600_000; ms += 7_000) {
      expect(formatDuration(ms)).not.toContain('60 мин');
    }
  });
});

