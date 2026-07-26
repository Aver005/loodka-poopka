/**
 * engine.ts — вся математика линии. Единственный источник правды.
 *
 * Модуль используют И расширение (в браузере), И tools/parse-bets.ts (в Bun).
 * Поэтому здесь нет ни DOM, ни файловой системы — только чистые функции над строкой HTML.
 * Расширение скармливает сюда `root.outerHTML`, скрипт — содержимое файла. Путь один,
 * а значит формулы в «подсказке на сайте» и в «отчёте в репозитории» не могут разойтись.
 */

// ── Типы ──────────────────────────────────────────────────────────────────────
export type TeamSlot = '1' | '2';
export type Tier = 'A' | 'B' | 'C';
export type MarketKey =
  | 'series' | 'map_win' | 'maps_fora' | 'maps_total'
  | 'round_fora' | 'rounds_total' | 'pistol' | 'first_n' | 'oddeven' | 'overtime';

export interface Offer {
  market: MarketKey;
  odds: number;
  text: string;
  type: string;
  max: number | null;
  teamLabel: string | null;
  team?: TeamSlot;
  map?: number;
  pistol?: number;
  n?: number | null;
  line?: number | null;
  hcap?: number;
  side?: 'over' | 'under' | 'even' | 'odd';
}

export interface TeamInfo {
  slot: TeamSlot;
  active: boolean;
  name: string | null;
  alt: string | null;
}

export interface Match {
  tournament: string | null;
  format: string | null;
  timer: string | null;
  teams: Partial<Record<TeamSlot, TeamInfo>>;
  active: TeamSlot | null;
  offers: Offer[];
  hint: string | null;
  sources: string[];
  sides?: number;
}

/** Книга — два взаимодополняющих исхода. Внутри книги маржа снимается корректно. */
export interface Book {
  p: number;
  margin: number | null;
  /** true — обе стороны известны, значение очищено от маржи. */
  solid: boolean;
}

export interface SeriesShape {
  reduced?: boolean;
  fair: { a20: number; a21: number; b21: number; b20: number } | null;
  books: { a20: Book | null; b20: Book | null; p3: Book | null };
  bookCount: number;
  solidHandicaps?: boolean;
  clamped?: boolean;
  mapCheck: { q: number; seriesFromMap: number } | null;
  pA: number;
  pB: number;
  p3maps: number;
  bSeriesOdds?: number | null;
  bSeriesActual: number | null;
  p3FromHandicaps: number | null;
  p3FromTotals: number | null;
}

export interface MarketPair {
  label: string;
  market: MarketKey;
  a: Offer & { implied: number; fair: number };
  b: Offer & { implied: number; fair: number };
  margin: number;
  /** Маржа вне правдоподобного диапазона — почти наверняка книга собрана неверно. */
  suspicious: boolean;
}

/**
 * Границы правдоподобной маржи двусторонней книги.
 *
 * Отрицательная маржа означала бы вилку внутри одного букмекера — такого не бывает.
 * Слишком большая означает, что в пару попали кэфы разных рынков. И то и другое —
 * признак сбоя разбора, а не находки. Однажды из-за этого «дешевле всего» оказался
 * рынок с маржой −31.4%, куда затесался кэф овертайма.
 */
const MARGIN_MIN = 0.01;
const MARGIN_MAX = 0.25;

export interface Analysis {
  match: Match;
  shape: SeriesShape | null;
  books: MarketPair[];
  cheapest: MarketPair | null;
  /** Расхождение книг по P(три карты): тотал карт минус форы. Маржа уже снята. */
  divergence: number | null;
}

// ── Тиры рынков (см. MARKETS.md) ──────────────────────────────────────────────
export const TIER: Record<MarketKey, { tier: Tier; label: string; order: number }> = {
  maps_total:   { tier: 'A', label: 'Тотал карт',         order: 1 },
  maps_fora:    { tier: 'A', label: 'Фора по картам',     order: 2 },
  map_win:      { tier: 'A', label: 'Победа на карте',    order: 3 },
  series:       { tier: 'B', label: 'Исход серии',        order: 4 },
  round_fora:   { tier: 'B', label: 'Фора по раундам',    order: 5 },
  rounds_total: { tier: 'C', label: 'Тотал раундов',      order: 6 },
  pistol:       { tier: 'C', label: 'Пистолетные раунды', order: 7 },
  first_n:      { tier: 'C', label: 'Первыми N раундов',  order: 8 },
  oddeven:      { tier: 'C', label: 'Чёт / нечёт',        order: 9 },
  overtime:     { tier: 'C', label: 'Овертайм',           order: 10 },
};
export const TIER_MARK: Record<Tier, string> = { A: '🅰️', B: '🅱️', C: '🅾️' };

export const EDGE_FLOOR = 0.03;
export const DEFAULT_UNIT = 250;

// ── Утилиты ───────────────────────────────────────────────────────────────────
const ENT: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&nbsp;': ' ',
};
export const decode = (s = ''): string => s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] ?? m);
export const stripTags = (s = ''): string => decode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
export const pct = (x: number | null | undefined, d = 1): string =>
  x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`;
export const oddsFmt = (x: number | null | undefined): string =>
  x == null || !isFinite(x) ? '—' : x.toFixed(3);
export const imp = (o: number | null | undefined): number | null => (o && o > 0 ? 1 / o : null);

/** Минимальная вероятность, при которой ставка проходит порог входа. */
export const requiredP = (odds: number, floor = EDGE_FLOOR): number => (1 + floor) / odds;

/** Edge = моя вероятность × кэф − 1. */
export const edgeOf = (p: number, odds: number): number => p * odds - 1;

export interface StakeAdvice { units: number; sum: number; note: string; flag: '🟢' | '🟡' | '🔴' }

/** Размер ставки по шкале из README.md. */
export function stakeFor(edge: number, unit = DEFAULT_UNIT): StakeAdvice {
  if (edge < EDGE_FLOOR) return { units: 0, sum: 0, note: 'ниже порога — пас', flag: '🔴' };
  if (edge > 0.35) return { units: 1, sum: unit, note: 'подозрительно высокий Edge — перепроверить состав', flag: '🟡' };
  if (edge >= 0.25) return { units: 2, sum: unit * 2, note: 'очень высокая уверенность', flag: '🟢' };
  if (edge >= 0.15) return { units: 1.5, sum: unit * 1.5, note: 'высокая уверенность', flag: '🟢' };
  if (edge >= 0.08) return { units: 1, sum: unit, note: 'средняя уверенность', flag: '🟢' };
  return { units: 0.5, sum: unit * 0.5, note: 'монетка с наклоном — минимальный размер', flag: '🟡' };
}

// ── Разбор HTML ───────────────────────────────────────────────────────────────
function parseHeader(html: string) {
  const timer = /<div class="bet_timer[^"]*">([^<]*)<\/div>/.exec(html)?.[1]?.trim() ?? null;
  const raw = /<div class="bet_event">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const format = /<b>([^<]*)<\/b>/.exec(raw)?.[1]?.trim() ?? null;
  const tournament = stripTags(raw.replace(/<b>[\s\S]*?<\/b>/, ''));
  return { tournament: tournament || null, format, timer };
}

function parseTeams(html: string): Partial<Record<TeamSlot, TeamInfo>> {
  const teams: Partial<Record<TeamSlot, TeamInfo>> = {};
  for (const slot of ['1', '2'] as const) {
    const m = new RegExp(`<div class="team_${slot}([^"]*)">`).exec(html);
    if (!m) continue;
    const rest = html.slice(m.index + m[0].length);
    teams[slot] = {
      slot,
      active: /\bactive\b/.test(m[1] ?? ''),
      name: stripTags(/<span class="team_name">([\s\S]*?)<\/span>/.exec(rest)?.[1] ?? '') || null,
      alt: /alt="([^"]*)"/.exec(rest)?.[1] ?? null,
    };
  }
  return teams;
}

interface RawAnchor {
  type: string; text: string; max: number | null; gem: string | null;
  descTeam: string | null; descSign: string | null;
  start: number; end: number; odds?: number;
}

/** Каждый <a class="m_next"> получает ближайший незанятый <span class="koef">. */
function parseOffers(html: string): Offer[] {
  const koefs: { value: number; start: number; end: number; used: boolean }[] = [];
  const kRe = /<span class="koef">\s*([\d.]+)\s*<\/span>/g;
  for (let m: RegExpExecArray | null; (m = kRe.exec(html)); ) {
    koefs.push({ value: parseFloat(m[1] ?? '0'), start: m.index, end: kRe.lastIndex, used: false });
  }

  const descs: { team: string | null; sign: string | null; end: number }[] = [];
  const dRe = /<span class="select_two_desc[^"]*">([\s\S]*?)<\/span>/g;
  for (let m: RegExpExecArray | null; (m = dRe.exec(html)); ) {
    const inner = m[1] ?? '';
    descs.push({
      team: stripTags(/<b>([\s\S]*?)<\/b>/.exec(inner)?.[1] ?? '') || null,
      sign: /<i>\s*([+-]?[\d.]+)\s*<\/i>/.exec(inner)?.[1] ?? null,
      end: dRe.lastIndex,
    });
  }
  const descBefore = (pos: number) => {
    let best: (typeof descs)[number] | null = null;
    for (const d of descs) if (d.end <= pos && pos - d.end < 500) best = d;
    return best;
  };

  const anchors: RawAnchor[] = [];
  const aRe = /<a\s[^>]*>/g;
  for (let m: RegExpExecArray | null; (m = aRe.exec(html)); ) {
    const tag = m[0];
    if (!/m_next/.test(tag)) continue;
    const type = /data-type="([^"]*)"/.exec(tag)?.[1];
    if (!type) continue;
    const d = descBefore(m.index);
    anchors.push({
      type,
      text: decode(/data-bet_text="([^"]*)"/.exec(tag)?.[1] ?? ''),
      max: Number(/data-max="([^"]*)"/.exec(tag)?.[1] ?? 0) || null,
      gem: /data-gem="([^"]*)"/.exec(tag)?.[1] ?? null,
      descTeam: d?.team ?? null,
      descSign: d?.sign ?? null,
      start: m.index,
      end: aRe.lastIndex,
    });
  }

  for (const a of anchors) {
    let best: (typeof koefs)[number] | null = null;
    let bestD = Infinity;
    for (const k of koefs) {
      if (k.used) continue;
      const d = k.end <= a.start ? a.start - k.end : k.start >= a.end ? k.start - a.end : 0;
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best && bestD < 600) { best.used = true; a.odds = best.value; }
    if (a.gem) a.odds = parseFloat(a.gem);
  }

  return anchors.filter((a) => (a.odds ?? 0) > 0).map(classify).filter((o): o is Offer => o !== null);
}

/**
 * data-type -> семантика рынка.
 *
 * ⚠️ Про фору. `fora` и `fora2` — НЕ «минус» и «плюс», а два разных двусторонних
 * рынка, и знак зависит от того, чья вкладка открыта. На вкладке NiP `fora_2` = «NiP −1.5»,
 * а на вкладке magic `fora_1` = «magic +1.5». Поэтому знак берётся из data-bet_text
 * («Фора по картам +1.5») — он присутствует в обоих вариантах разметки сайта,
 * и из подписи <i>±X</i> как запасной вариант. Конвенция data-type ненадёжна.
 */
function classify(a: RawAnchor): Offer | null {
  const [head, tail] = a.type.split('|');
  const p = (head ?? '').split('_');
  const line = tail != null ? parseFloat(tail) : null;
  const odds = a.odds!;
  const base = { odds, text: a.text, max: a.max, type: a.type, teamLabel: a.descTeam };

  const textSign = /(?:^|\s)([+-]\d+(?:\.\d+)?)/.exec(a.text)?.[1] ?? null;
  const signed = (fallback: number) => {
    const s = textSign ?? a.descSign;
    return s != null ? parseFloat(s) : fallback;
  };
  const slot = (v: string | undefined): TeamSlot => (v === '1' ? '1' : '2');

  switch (p[0]) {
    case 'win':
      if (p.length === 2) return { ...base, market: 'series', team: slot(p[1]) };
      if (p.length === 3) return { ...base, market: 'map_win', map: Number(p[1]), team: slot(p[2]) };
      return null;
    case 'pistol':    return { ...base, market: 'pistol', pistol: Number(p[1]), team: slot(p[2]) };
    case 'first5':    return { ...base, market: 'first_n', map: Number(p[1]), team: slot(p[2]), n: line };
    case 'roundstot': return { ...base, market: 'rounds_total', map: Number(p[1]), side: p[2] === '1' ? 'over' : 'under', line };
    case 'oddeven':   return { ...base, market: 'oddeven', map: Number(p[1]), side: p[2] === '1' ? 'even' : 'odd' };
    case 'rounddif':  return { ...base, market: 'round_fora', map: Number(p[1]), team: slot(p[2]), hcap: signed(-(line ?? 0)) };
    case 'rounddif2': return { ...base, market: 'round_fora', map: Number(p[1]), team: slot(p[2]), hcap: signed(line ?? 0) };
    case 'overtime':  return { ...base, market: 'overtime', map: Number(p[1]) };
    case 'fora':      return { ...base, market: 'maps_fora', team: slot(p[1]), hcap: signed(-(line ?? 0)) };
    case 'fora2':     return { ...base, market: 'maps_fora', team: slot(p[1]), hcap: signed(line ?? 0) };
    case 'maps':      return { ...base, market: 'maps_total', side: p[1] === '1' ? 'over' : 'under', line };
    default: return null;
  }
}

/** Вырезает блоки модалок из произвольного HTML (в том числе из дампа целой страницы). */
export function extractModals(html: string): string[] {
  const open = /<div\b[^>]*(?:id="bet"|class="[^"]*\bmodal\b[^"]*\bbets\b[^"]*")[^>]*>/g;
  const blocks: string[] = [];
  let end = 0;
  for (let m: RegExpExecArray | null; (m = open.exec(html)); ) {
    if (m.index < end) continue;
    const tagRe = /<\/?div\b[^>]*>/g;
    tagRe.lastIndex = open.lastIndex;
    let depth = 1;
    let stop = html.length;
    for (let t: RegExpExecArray | null; depth > 0 && (t = tagRe.exec(html)); ) {
      depth += t[0][1] === '/' ? -1 : 1;
      stop = tagRe.lastIndex;
    }
    const block = html.slice(m.index, stop);
    if (/class="koef"/.test(block)) { blocks.push(block); end = stop; }
  }
  return blocks.length ? blocks : [html];
}

export function parseOne(html: string, source: string | null = null, hint: string | null = null): Match {
  const head = parseHeader(html);
  const teams = parseTeams(html);
  const offers = parseOffers(html);
  const active = (Object.values(teams).find((t) => t.active)?.slot
    ?? offers.find((o) => o.market === 'series')?.team
    ?? null) as TeamSlot | null;
  return { ...head, teams, active, offers, hint, sources: source ? [source] : [] };
}

export function parseHtml(html: string, source: string | null = null, hint: string | null = null): Match[] {
  const blocks = extractModals(html);
  return blocks
    .map((b, i) => parseOne(b, blocks.length > 1 ? `${source}#${i + 1}` : source, hint))
    .filter((m) => m.offers.length > 0);
}

/** Объединяет два захода (вкладки разных команд) в один матч. */
export function mergeSides(a: Match, b: Match | null | undefined): Match {
  if (!b) return a;
  const seen = new Set(a.offers.map((o) => o.type));
  const offers = [...a.offers, ...b.offers.filter((o) => !seen.has(o.type))];
  const teams = { ...b.teams, ...a.teams };
  for (const s of ['1', '2'] as const) if (!teams[s]?.name && b.teams[s]?.name) teams[s] = b.teams[s];
  return { ...a, teams, offers, sides: 2, sources: [...a.sources, ...b.sources] };
}

// ── Аналитика ─────────────────────────────────────────────────────────────────
function book(yes: number | null, no: number | null): Book | null {
  const y = imp(yes);
  const n = imp(no);
  if (y != null && n != null) return { p: y / (y + n), margin: y + n - 1, solid: true };
  if (y != null) return { p: y, margin: null, solid: false };
  if (n != null) return { p: 1 - n, margin: null, solid: false };
  return null;
}

export function seriesShape(m: Match): SeriesShape | null {
  const A = m.active;
  if (!A) return null;
  const B: TeamSlot = A === '1' ? '2' : '1';
  const f = (pred: (o: Offer) => boolean) => m.offers.find(pred)?.odds ?? null;

  const oSeriesA = f((o) => o.market === 'series' && o.team === A);
  const oSeriesB = f((o) => o.market === 'series' && o.team === B);
  const oAminus = f((o) => o.market === 'maps_fora' && o.team === A && (o.hcap ?? 0) < 0);
  const oAplus  = f((o) => o.market === 'maps_fora' && o.team === A && (o.hcap ?? 0) > 0);
  const oBminus = f((o) => o.market === 'maps_fora' && o.team === B && (o.hcap ?? 0) < 0);
  const oBplus  = f((o) => o.market === 'maps_fora' && o.team === B && (o.hcap ?? 0) > 0);
  const oOver   = f((o) => o.market === 'maps_total' && o.side === 'over');
  const oUnder  = f((o) => o.market === 'maps_total' && o.side === 'under');
  if (!oSeriesA) return null;

  // Карта #1 как независимая проверка: из вероятности взять карту выводится
  // вероятность серии, q²(3−2q). Сходится с книгой исхода — модель букмекера цельная.
  const bMap = book(
    f((o) => o.market === 'map_win' && o.map === 1 && o.team === A),
    f((o) => o.market === 'map_win' && o.map === 1 && o.team === B),
  );
  const mapCheck = bMap?.solid ? { q: bMap.p, seriesFromMap: bMap.p ** 2 * (3 - 2 * bMap.p) } : null;

  const parts = {
    a20: book(oAminus, oBplus),
    b20: book(oBminus, oAplus),
    p3: book(oOver, oUnder),
  };
  const have = (Object.entries(parts) as [keyof typeof parts, Book | null][]).filter(([, v]) => v);

  // Сокращённый режим: форы по картам в линии нет (частое дело на тир-3).
  // Разбивку «всухую / 2:1» построить не из чего, но сами шансы посчитать можно.
  if (have.length < 2) {
    if (!oSeriesB || !parts.p3) return null;
    const iA = imp(oSeriesA)!;
    const pA0 = iA / (iA + imp(oSeriesB)!);
    return {
      reduced: true, fair: null, books: parts, bookCount: have.length,
      pA: pA0, pB: 1 - pA0, p3maps: parts.p3.p, bSeriesActual: oSeriesB,
      mapCheck, p3FromHandicaps: null, p3FromTotals: parts.p3.p,
    };
  }

  // Совместная нормировка: снимать маржу попарно нельзя — книги разные,
  // и сумма их «честных» вероятностей единице не равна.
  let vals: { a20: number; b20: number; p3: number };
  if (have.length === 3) {
    const s = parts.a20!.p + parts.b20!.p + parts.p3!.p;
    vals = { a20: parts.a20!.p / s, b20: parts.b20!.p / s, p3: parts.p3!.p / s };
  } else {
    const missing = (['a20', 'b20', 'p3'] as const).find((k) => !parts[k])!;
    const known: Record<string, number> = Object.fromEntries(have.map(([k, v]) => [k, v!.p]));
    known[missing] = Math.max(0, 1 - have.reduce((acc, [, v]) => acc + v!.p, 0));
    const s = known.a20! + known.b20! + known.p3!;
    vals = { a20: known.a20! / s, b20: known.b20! / s, p3: known.p3! / s };
  }
  const { a20, b20, p3 } = vals;

  const pAr = imp(oSeriesA)!;
  const iB = imp(oSeriesB);
  const pA = iB != null ? pAr / (pAr + iB) : Math.min(Math.max(pAr, a20), a20 + p3);

  // Сумма четвёрки равна 1 тождественно:
  // a20 + (pA − a20) + (p3 − pA + a20) + b20 = a20 + b20 + p3 = 1
  const a21 = Math.min(Math.max(pA - a20, 0), p3);
  const b21 = p3 - a21;

  // Реконструкция кэфа соперника считается по СЫРЫМ вероятностям, а не по очищенным.
  // Смысл величины — «что выставил бы букмекер», а он выставляет с маржой внутри.
  // Из очищенной вероятности вышел бы кэф заметно длиннее реального.
  const rawA20 = imp(oAminus);
  const rawB20 = oBminus ? imp(oBminus) : oAplus ? 1 - imp(oAplus)! : null;
  const rawP3 = imp(oOver);
  let bSeriesOdds: number | null = null;
  if (rawA20 != null && rawB20 != null && rawP3 != null) {
    const pBraw = Math.max(0, rawP3 - (pAr - rawA20)) + rawB20;
    bSeriesOdds = pBraw > 0 ? 1 / pBraw : null;
  }

  return {
    fair: { a20, a21, b21, b20 },
    books: parts,
    solidHandicaps: !!(parts.a20?.solid || parts.b20?.solid),
    bookCount: have.length,
    clamped: Math.abs(pA - a20 - a21) > 1e-9,
    mapCheck,
    pA: a20 + a21,
    pB: b21 + b20,
    p3maps: p3,
    bSeriesOdds,
    bSeriesActual: oSeriesB,
    p3FromHandicaps: parts.a20 && parts.b20 ? 1 - parts.a20.p - parts.b20.p : null,
    p3FromTotals: parts.p3?.p ?? null,
  };
}

export function pairs(m: Match): MarketPair[] {
  const out: MarketPair[] = [];
  const push = (label: string, market: MarketKey, x?: Offer, y?: Offer) => {
    if (!x || !y) return;
    const ix = imp(x.odds)!;
    const iy = imp(y.odds)!;
    const s = ix + iy;
    const margin = s - 1;
    out.push({
      label, market,
      a: { ...x, implied: ix, fair: ix / s },
      b: { ...y, implied: iy, fair: iy / s },
      margin,
      suspicious: margin < MARGIN_MIN || margin > MARGIN_MAX,
    });
  };

  const mt = m.offers.filter((o) => o.market === 'maps_total');
  push(`Тотал карт ${mt[0]?.line ?? 2.5}`, 'maps_total',
    mt.find((o) => o.side === 'over'), mt.find((o) => o.side === 'under'));

  const rt = m.offers.filter((o) => o.market === 'rounds_total');
  for (const line of [...new Set(rt.map((o) => o.line))].sort((x, y) => (x ?? 0) - (y ?? 0))) {
    push(`Тотал раундов ${line}`, 'rounds_total',
      rt.find((o) => o.line === line && o.side === 'over'),
      rt.find((o) => o.line === line && o.side === 'under'));
  }

  const oe = m.offers.filter((o) => o.market === 'oddeven');
  push('Чёт / нечёт', 'oddeven', oe.find((o) => o.side === 'even'), oe.find((o) => o.side === 'odd'));

  const ser = m.offers.filter((o) => o.market === 'series');
  if (ser.length === 2) push('Исход серии', 'series', ser.find((o) => o.team === '1'), ser.find((o) => o.team === '2'));

  // Фора по картам: «X −1.5» и «Y +1.5» — две стороны ОДНОЙ книги.
  const mf = m.offers.filter((o) => o.market === 'maps_fora');
  for (const line of [...new Set(mf.map((o) => Math.abs(o.hcap ?? 0)))].sort((x, y) => x - y)) {
    for (const t of ['1', '2'] as const) {
      const minus = mf.find((o) => o.team === t && o.hcap === -line);
      const plus = mf.find((o) => o.team !== t && o.hcap === line);
      if (minus && plus) {
        push(`Фора: ${minus.teamLabel ?? `К${minus.team}`} −${line} / ${plus.teamLabel ?? `К${plus.team}`} +${line}`,
             'maps_fora', minus, plus);
      }
    }
  }
  return out;
}

/** Всё вместе — то, что рисует расширение и печатает отчёт. */
export function analyze(match: Match): Analysis {
  const shape = seriesShape(match);
  const books = pairs(match);
  // «Дешевле всего» ищем только среди правдоподобных книг: рынок с невозможной
  // маржой — это сбой разбора, и подавать его как лучшую находку нельзя.
  const trusted = books.filter((b) => !b.suspicious);
  const cheapest = trusted.length ? trusted.reduce((x, y) => (y.margin < x.margin ? y : x)) : null;
  const divergence = shape?.p3FromHandicaps != null && shape?.p3FromTotals != null
    ? shape.p3FromTotals - shape.p3FromHandicaps
    : null;
  return { match, shape, books, cheapest, divergence };
}

export function nameOf(match: Match, slot: TeamSlot, fallbackHint = ''): string {
  const fromHint = (fallbackHint || match.hint || '').split(/\s+vs\s+/i)
    .map((s) => s.replace(/\s*\[[^\]]*\]\s*$/, '').trim());
  return match.teams[slot]?.name || fromHint[Number(slot) - 1] || `Команда ${slot}`;
}
