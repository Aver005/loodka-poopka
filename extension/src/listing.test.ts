/**
 * Тесты детектора расписания.
 *
 * Сценарии взяты из реальных листингов 26–27 июля, включая тот, на котором
 * я один раз ошибся в рассуждении: круговой турнир Urban Riga выглядел как
 * сильнейший случай усталости, хотя там устают все одинаково.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildListingBrief, fairP1, findAsymmetries, formatDuration, parseCountdown,
  parseListingHtml, publicBias, teamLoads,
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
    expect(parseCountdown('скоро')).toBeNull();
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
});

