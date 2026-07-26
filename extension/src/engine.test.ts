/**
 * Тесты движка на реальных фикстурах.
 *
 * Фикстуры — настоящие модалки с сайта, снятые 26.07.2026, очищенные от всего лишнего.
 * Ожидаемые значения не выдуманы: они посчитаны вручную и сверены с линией букмекера
 * (например, реконструированный кэф соперника 2.006 против реального 2.028).
 *
 * Главный тест здесь — `знак форы берётся из текста, а не из data-type`. На этом
 * движок один раз уже сломался: `fora` и `fora2` означают РАЗНЫЕ знаки на разных
 * вкладках, и чтение знака из data-type давало зеркально неверную картину.
 */

import { describe, expect, test } from 'bun:test';
import {
  analyze,
  edgeOf,
  mergeSides,
  nameOf,
  parseOne,
  requiredP,
  seriesShape,
  stakeFor,
  type Match,
} from './engine';

const load = (name: string) => Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).text();
const fx = async (name: string): Promise<Match> => parseOne(await load(name), name);

/** Обе стороны одного матча, склеенные как это делает расширение. */
const both = async (a: string, b: string) => mergeSides(await fx(a), await fx(b));

const near = (actual: number | null | undefined, expected: number, tolerance = 0.005) =>
{
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(tolerance);
};

// ─────────────────────────────────────────────────────────────────────────────
describe('разбор разметки', () =>
{
  test('вытаскивает шапку, команды и все офферы', async () =>
  {
    const m = await fx('bo3-two-fora-books.html');
    expect(m.tournament).toBe('StarLadder');
    expect(m.format).toBe('BO3');
    expect(m.teams['1']?.name).toBe('Magic');
    expect(m.teams['2']?.name).toBe('Ninjas in Pyjamas');
    expect(m.active).toBe('2');
    expect(m.offers).toHaveLength(28);
  });

  test('каждому офферу достаётся свой коэффициент', async () =>
  {
    const m = await fx('bo3-two-fora-books.html');
    expect(m.offers.every((o) => o.odds > 1)).toBe(true);
    expect(m.offers.find((o) => o.market === 'series')?.odds).toBe(1.69);
    expect(m.offers.find((o) => o.market === 'map_win')?.odds).toBe(1.62);
    expect(m.offers.find((o) => o.market === 'overtime')?.odds).toBe(5.7);
  });

  test('разбирает лестницу тотала раундов и чёт/нечёт', async () =>
  {
    const m = await fx('bo3-two-fora-books.html');
    const rt = m.offers.filter((o) => o.market === 'rounds_total');
    expect(rt).toHaveLength(8); // 4 линии × 2 стороны
    expect(rt.find((o) => o.line === 21.5 && o.side === 'over')?.odds).toBe(1.963);
    expect(m.offers.filter((o) => o.market === 'oddeven')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('знак форы — регресс на реальном баге', () =>
{
  test('data-type "fora_2" на вкладке второй команды это МИНУС', async () =>
  {
    const m = await fx('bo3-two-fora-books.html');
    const minus = m.offers.find((o) => o.market === 'maps_fora' && o.type.startsWith('fora_'));
    expect(minus?.text).toBe('Фора по картам -1.5');
    expect(minus?.hcap).toBe(-1.5);
    expect(minus?.odds).toBe(2.684);
  });

  test('тот же "fora_1" на вкладке первой команды это уже ПЛЮС', async () =>
  {
    const m = await fx('bo3-two-fora-books-side-b.html');
    const same = m.offers.find((o) => o.market === 'maps_fora' && o.type.startsWith('fora_'));
    expect(same?.text).toBe('Фора по картам +1.5');
    expect(same?.hcap).toBe(1.5); // ← старый код вернул бы −1.5 и всё перевернул
    expect(same?.odds).toBe(1.377);
  });

  test('работает и во второй разметке — плоский div без подписи <b>', async () =>
  {
    const m = await fx('bo3-one-fora-book.html');
    const fora = m.offers.filter((o) => o.market === 'maps_fora');
    expect(fora).toHaveLength(1);
    expect(fora[0]!.teamLabel).toBeNull(); // подписи с командой тут нет
    expect(fora[0]!.hcap).toBe(1.5); // знак взят из data-bet_text
    expect(fora[0]!.odds).toBe(1.877);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('сетка исходов: три книги', () =>
{
  test('вероятности исходов складываются ровно в единицу', async () =>
  {
    const m = await both('bo3-two-fora-books.html', 'bo3-two-fora-books-side-b.html');
    const s = seriesShape(m)!;
    const { a20, a21, b21, b20 } = s.fair!;
    near(a20 + a21 + b21 + b20, 1, 1e-9);
    near(s.pA + s.pB, 1, 1e-9);
  });

  test('совпадает с ручным расчётом по линии', async () =>
  {
    const m = await both('bo3-two-fora-books.html', 'bo3-two-fora-books-side-b.html');
    const s = seriesShape(m)!;
    expect(s.bookCount).toBe(3);
    expect(s.solidHandicaps).toBe(true);
    expect(s.clamped).toBe(false);
    near(s.pA, 0.545); // Ninjas in Pyjamas
    near(s.pB, 0.455); // Magic
    near(s.fair!.a20, 0.312);
    near(s.fair!.b20, 0.255);
    near(s.p3maps, 0.434);
  });

  test('ловит расхождение книг по вероятности трёх карт', async () =>
  {
    const m = await both('bo3-two-fora-books.html', 'bo3-two-fora-books-side-b.html');
    const { divergence } = analyze(m);
    // Форы дают 38.6%, тотал карт 47.9%. Маржа внутри книг уже снята,
    // значит это расхождение самих оценок букмекера, а не её след.
    near(divergence!, 0.093, 0.01);
  });
});

describe('сетка исходов: две книги из трёх', () =>
{
  test('недостающее событие достраивается как остаток', async () =>
  {
    const m = await both('bo3-one-fora-book.html', 'bo3-one-fora-book-side-b.html');
    const s = seriesShape(m)!;
    expect(s.bookCount).toBe(2);
    near(s.pA, 0.28); // 3DMAX
    near(s.pB, 0.72); // FUT Esports
    near(s.fair!.a20, 0.095); // разгром 3DMAX никем не котируется — выведен
    near(s.fair!.b20, 0.508);
    near(s.fair!.a20 + s.fair!.a21 + s.fair!.b21 + s.fair!.b20, 1, 1e-9);
  });
});

describe('сокращённый режим: форы в линии нет вообще', () =>
{
  test('по одной стороне посчитать нечего', async () =>
  {
    expect(seriesShape(await fx('bo3-no-fora.html'))).toBeNull();
  });

  test('по двум сторонам считаются шансы, но не разбивка', async () =>
  {
    const m = await both('bo3-no-fora.html', 'bo3-no-fora-side-b.html');
    const s = seriesShape(m)!;
    expect(s.reduced).toBe(true);
    expect(s.fair).toBeNull();
    near(s.pA, 0.687); // INOX Division
    near(s.pB, 0.313); // G2 Ares
    near(s.p3maps, 0.452);
  });

  test('сверка через карту #1 подтверждает цельность модели букмекера', async () =>
  {
    const m = await both('bo3-no-fora.html', 'bo3-no-fora-side-b.html');
    const s = seriesShape(m)!;
    near(s.mapCheck!.q, 0.626);
    // q²(3−2q) — шанс серии, выведенный из одной карты
    near(s.mapCheck!.seriesFromMap, 0.686);
    expect(Math.abs(s.mapCheck!.seriesFromMap - s.pA)).toBeLessThan(0.02);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('реконструкция соперника по одной стороне', () =>
{
  test('выводит кэф второй команды с точностью до процента', async () =>
  {
    const s = seriesShape(await fx('bo3-two-fora-books.html'))!;
    expect(s.bSeriesActual).toBeNull(); // кэфа Magic в этой вкладке нет
    near(s.bSeriesOdds!, 2.006, 0.01); // а реальный на сайте — 2.028
  });

  test('но оценка разгрома по одной стороне занижена — за этим и нужен второй заход', async () =>
  {
    const one = seriesShape(await fx('bo3-two-fora-books.html'))!;
    const two = seriesShape(
      await both('bo3-two-fora-books.html', 'bo3-two-fora-books-side-b.html'),
    )!;
    // P(Magic 2:0): ~18.9% по одной стороне против ~25.2% по двум.
    // По одной стороне значение выводится из «+1.5», а там своя маржа,
    // и вычитанием она не убирается — оценка разгрома выходит заниженной.
    expect(one.books.b20!.solid).toBe(false);
    expect(two.books.b20!.solid).toBe(true);
    near(one.fair!.b20, 0.189);
    near(two.fair!.b20, 0.252);
    expect(two.fair!.b20).toBeGreaterThan(one.fair!.b20 + 0.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('маржа по книгам', () =>
{
  test('тотал карт дешевле форы — это и определяет, куда смотреть', async () =>
  {
    const { books, cheapest } = analyze(
      await both('bo3-two-fora-books.html', 'bo3-two-fora-books-side-b.html'),
    );
    const maps = books.find((b) => b.market === 'maps_total')!;
    const fora = books.filter((b) => b.market === 'maps_fora');
    near(maps.margin, 0.084, 0.002);
    expect(fora.every((f) => f.margin > maps.margin)).toBe(true);
    expect(cheapest!.market).toBe('maps_total');
  });

  test('центральная линия тотала раундов дешевле крайних', async () =>
  {
    const { books } = analyze(await fx('bo3-two-fora-books.html'));
    const byLine = (l: number) =>
      books.find((b) => b.market === 'rounds_total' && b.label.endsWith(String(l)))!;
    expect(byLine(21.5).margin).toBeLessThan(byLine(19.5).margin);
    expect(byLine(21.5).margin).toBeLessThan(byLine(22.5).margin);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('расчёт ставки', () =>
{
  test('Edge и требуемая вероятность', () =>
  {
    near(edgeOf(0.52, 2.028), 0.0546, 1e-4); // П1 magic — реальная ставка 26.07
    near(edgeOf(0.32, 3.255), 0.0416, 1e-4); // П1 3DMAX
    near(requiredP(2.028), 0.5079, 1e-4);
  });

  test('шкала размера соответствует README', () =>
  {
    expect(stakeFor(0.02).units).toBe(0); // ниже порога
    expect(stakeFor(0.055).units).toBe(0.5); // монетка с наклоном
    expect(stakeFor(0.1).units).toBe(1);
    expect(stakeFor(0.2).units).toBe(1.5);
    expect(stakeFor(0.3).units).toBe(2);
    expect(stakeFor(0.5).units).toBe(1); // подозрительно высокий — режем, а не задираем
    expect(stakeFor(0.5).flag).toBe('🟡');
    expect(stakeFor(0.055, 250).sum).toBe(125);
  });
});

describe('склейка сторон', () =>
{
  test('свежие кэфы побеждают запомненные, недостающие — дополняются', async () =>
  {
    const fresh = await fx('bo3-two-fora-books.html'); // вкладка NiP
    const stored = await fx('bo3-two-fora-books-side-b.html'); // вкладка Magic, снята раньше

    const merged = mergeSides(fresh, stored);

    // Оффер, который есть в обеих сторонах, берётся из свежей.
    const series = merged.offers.filter((o) => o.market === 'series');
    expect(series.find((o) => o.team === '2')?.odds).toBe(1.69); // из fresh
    expect(series.find((o) => o.team === '1')?.odds).toBe(2.028); // дополнено из stored

    // Ничего не потеряно и не задвоено.
    expect(merged.offers.length).toBeGreaterThan(fresh.offers.length);
    expect(new Set(merged.offers.map((o) => o.type)).size).toBe(merged.offers.length);
    expect(merged.sides).toBe(2);
  });

  test('после склейки строится полная сетка исходов', async () =>
  {
    const merged = mergeSides(
      await fx('bo3-two-fora-books.html'),
      await fx('bo3-two-fora-books-side-b.html'),
    );
    const s = seriesShape(merged)!;
    // Именно этого не хватало, когда «Обновить» откатывал разбор к одной стороне.
    expect(s.solidHandicaps).toBe(true);
    expect(s.bookCount).toBe(3);
  });
});

describe('имена команд', () =>
{
  test('берутся из разметки, а при её отсутствии из подсказки', async () =>
  {
    const m = await fx('bo3-two-fora-books.html');
    expect(nameOf(m, '1')).toBe('Magic');
    expect(nameOf(m, '2')).toBe('Ninjas in Pyjamas');
    const noTeams: Match = { ...m, teams: {}, hint: 'A vs B [CCT EU BO3]' };
    expect(nameOf(noTeams, '1')).toBe('A');
    expect(nameOf(noTeams, '2')).toBe('B');
  });
});
