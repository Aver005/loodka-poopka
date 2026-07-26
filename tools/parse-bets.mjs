#!/usr/bin/env node
/**
 * parse-bets.mjs — парсер модалок букмекера в структурированный отчёт.
 *
 *   node tools/parse-bets.mjs                 # input/html/ -> input/parsed/
 *   node tools/parse-bets.mjs <dir|file...>   # явные пути
 *   node tools/parse-bets.mjs --out <dir>
 *
 * Ест .html (outerHTML модалки #bet) и .json (вывод tools/grab-console.js).
 * Матчи из разных заходов (по одной команде на модалку) склеиваются автоматически.
 * Недостающая сторона реконструируется из форы по картам и тотала карт.
 *
 * Zero dependencies.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

// ── Тиры рынков (см. MARKETS.md) ──────────────────────────────────────────────
const TIER = {
  maps_total:   { tier: 'A', label: 'Тотал карт',          order: 1 },
  maps_fora:    { tier: 'A', label: 'Фора по картам',      order: 2 },
  map_win:      { tier: 'A', label: 'Победа на карте',     order: 3 },
  series:       { tier: 'B', label: 'Исход серии',         order: 4 },
  round_fora:   { tier: 'B', label: 'Фора по раундам',     order: 5 },
  rounds_total: { tier: 'C', label: 'Тотал раундов',       order: 6 },
  pistol:       { tier: 'C', label: 'Пистолетные раунды',  order: 7 },
  first_n:      { tier: 'C', label: 'Первыми N раундов',   order: 8 },
  oddeven:      { tier: 'C', label: 'Чёт / нечёт',         order: 9 },
  overtime:     { tier: 'C', label: 'Овертайм',            order: 10 },
};
const TIER_MARK = { A: '🅰️', B: '🅱️', C: '🅾️' };
const EDGE_FLOOR = 0.03; // порог входа из README.md

// ── Утилиты ───────────────────────────────────────────────────────────────────
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&nbsp;': ' ' };
const decode = (s = '') => s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] ?? m);
const stripTags = (s = '') => decode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const odds = (x) => (x == null || !isFinite(x) ? '—' : x.toFixed(3));
const imp = (o) => (o > 0 ? 1 / o : null);

// ── Парсинг HTML ──────────────────────────────────────────────────────────────
function parseHeader(html) {
  const timer = /<div class="bet_timer[^"]*">([^<]*)<\/div>/.exec(html)?.[1]?.trim() ?? null;
  const raw = /<div class="bet_event">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const fmt = /<b>([^<]*)<\/b>/.exec(raw)?.[1]?.trim() ?? null;
  const tournament = stripTags(raw.replace(/<b>[\s\S]*?<\/b>/, ''));
  return { tournament: tournament || null, format: fmt, timer };
}

function parseTeams(html) {
  const teams = {};
  for (const slot of ['1', '2']) {
    const m = new RegExp(`<div class="team_${slot}([^"]*)">`).exec(html);
    if (!m) continue;
    const rest = html.slice(m.index + m[0].length);
    teams[slot] = {
      slot,
      active: /\bactive\b/.test(m[1]),
      name: stripTags(/<span class="team_name">([\s\S]*?)<\/span>/.exec(rest)?.[1] ?? '') || null,
      alt: /alt="([^"]*)"/.exec(rest)?.[1] ?? null,
      link: /href="(\/team\/[^"]*)"/.exec(rest)?.[1] ?? null,
    };
  }
  return teams;
}

/** Каждый <a class="m_next"> получает ближайший незанятый <span class="koef">. */
function parseOffers(html) {
  const koefs = [];
  const kRe = /<span class="koef">\s*([\d.]+)\s*<\/span>/g;
  for (let m; (m = kRe.exec(html)); ) {
    koefs.push({ value: parseFloat(m[1]), start: m.index, end: kRe.lastIndex, used: false });
  }

  // Подписи вида <b>Команда</b><i>-1.5</i> — единственный надёжный источник знака форы.
  const descs = [];
  const dRe = /<span class="select_two_desc[^"]*">([\s\S]*?)<\/span>/g;
  for (let m; (m = dRe.exec(html)); ) {
    descs.push({
      team: stripTags(/<b>([\s\S]*?)<\/b>/.exec(m[1])?.[1] ?? '') || null,
      sign: /<i>\s*([+-]?[\d.]+)\s*<\/i>/.exec(m[1])?.[1] ?? null,
      end: dRe.lastIndex,
    });
  }
  const descBefore = (pos) => {
    let best = null;
    for (const d of descs) if (d.end <= pos && pos - d.end < 500) best = d;
    return best;
  };

  const anchors = [];
  const aRe = /<a\s[^>]*>/g;
  for (let m; (m = aRe.exec(html)); ) {
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
    let best = null;
    let bestD = Infinity;
    for (const k of koefs) {
      if (k.used) continue;
      const d = k.end <= a.start ? a.start - k.end : k.start >= a.end ? k.start - a.end : 0;
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best && bestD < 600) { best.used = true; a.odds = best.value; }
    if (a.gem) a.odds = parseFloat(a.gem); // data-gem авторитетнее
  }

  return anchors.filter((a) => a.odds > 0).map(classify).filter(Boolean);
}

/**
 * data-type -> семантика рынка.
 *
 * ⚠️ Про фору. `fora` и `fora2` — НЕ «минус» и «плюс», а два разных двусторонних
 * рынка; знак зависит от вкладки команды. На вкладке NiP `fora_2` = «NiP −1.5»,
 * а на вкладке magic `fora_1` = «magic +1.5». Поэтому знак берём из подписи
 * <b>Команда</b><i>±X</i>, а конвенцию data-type держим лишь как запасной вариант.
 * То же самое с `rounddif` / `rounddif2`.
 */
function classify(a) {
  const [head, tail] = a.type.split('|');
  const p = head.split('_');
  const line = tail != null ? parseFloat(tail) : null;
  const base = { odds: a.odds, text: a.text, max: a.max, type: a.type, teamLabel: a.descTeam };
  // Знак форы: сначала из data-bet_text («Фора по картам +1.5») — он есть в обоих
  // вариантах разметки; затем из подписи <i>±X</i>; и только потом конвенция data-type.
  const textSign = /(?:^|\s)([+-]\d+(?:\.\d+)?)/.exec(a.text)?.[1] ?? null;
  const signed = (fallback) => {
    const s = textSign ?? a.descSign;
    return s != null ? parseFloat(s) : fallback;
  };

  switch (p[0]) {
    case 'win':
      if (p.length === 2) return { ...base, market: 'series', team: p[1] };
      if (p.length === 3) return { ...base, market: 'map_win', map: +p[1], team: p[2] };
      return null;
    case 'pistol':
      return { ...base, market: 'pistol', pistol: +p[1], team: p[2] };
    case 'first5':
      return { ...base, market: 'first_n', map: +p[1], team: p[2], n: line };
    case 'roundstot':
      return { ...base, market: 'rounds_total', map: +p[1], side: p[2] === '1' ? 'over' : 'under', line };
    case 'oddeven':
      return { ...base, market: 'oddeven', map: +p[1], side: p[2] === '1' ? 'even' : 'odd' };
    case 'rounddif':
      return { ...base, market: 'round_fora', map: +p[1], team: p[2], hcap: signed(-line), book: 'A' };
    case 'rounddif2':
      return { ...base, market: 'round_fora', map: +p[1], team: p[2], hcap: signed(+line), book: 'B' };
    case 'overtime':
      return { ...base, market: 'overtime', map: +p[1] };
    case 'fora':
      return { ...base, market: 'maps_fora', team: p[1], hcap: signed(-line), book: 'A' };
    case 'fora2':
      return { ...base, market: 'maps_fora', team: p[1], hcap: signed(+line), book: 'B' };
    case 'maps':
      return { ...base, market: 'maps_total', side: p[1] === '1' ? 'over' : 'under', line };
    default:
      return null;
  }
}

/**
 * Вытаскивает блоки модалок из произвольного HTML.
 * Работает и на одиночной модалке, и на дампе целой страницы (там их бывает много —
 * сайт держит по узлу id="bet" на каждый матч, поэтому querySelector('#bet') и промахивался).
 */
function extractModals(html) {
  const open = /<div\b[^>]*(?:id="bet"|class="[^"]*\bmodal\b[^"]*\bbets\b[^"]*")[^>]*>/g;
  const blocks = [];
  let end = 0;

  for (let m; (m = open.exec(html)); ) {
    if (m.index < end) continue; // вложенный в уже взятый блок
    const tagRe = /<\/?div\b[^>]*>/g;
    tagRe.lastIndex = open.lastIndex;
    let depth = 1;
    let stop = html.length;
    for (let t; depth > 0 && (t = tagRe.exec(html)); ) {
      depth += t[0][1] === '/' ? -1 : 1;
      stop = tagRe.lastIndex;
    }
    const block = html.slice(m.index, stop);
    if (/class="koef"/.test(block)) { blocks.push(block); end = stop; }
  }

  return blocks.length ? blocks : [html];
}

function parseOne(html, source, hint) {
  const head = parseHeader(html);
  const teams = parseTeams(html);
  const offers = parseOffers(html);
  // Активная сторона: по классу .active, иначе по суффиксу команды в data-type исхода.
  const active = Object.values(teams).find((t) => t.active)?.slot
    ?? offers.find((o) => o.market === 'series')?.team
    ?? null;
  return { ...head, teams, active, offers, hint, sources: [source] };
}

function parseHtml(html, source, hint) {
  const blocks = extractModals(html);
  return blocks
    .map((block, i) => parseOne(block, blocks.length > 1 ? `${source}#${i + 1}` : source, hint))
    .filter((m) => m.offers.length);
}

// ── Склейка нескольких заходов по одному матчу ────────────────────────────────
/**
 * Ключ матча. Имена команд есть не всегда: если захвачен только .modal_content,
 * блок team_select в дамп не попадает. Тогда отпечатком служит тотал карт —
 * это рынок уровня матча, и на вкладках обеих команд он одинаковый.
 */
function matchKey(m) {
  const names = Object.values(m.teams).map((t) => t.name).filter(Boolean).sort();
  if (names.length === 2) return `${m.tournament ?? '?'} | ${names.join(' | ')}`.toLowerCase();

  const mt = m.offers.filter((o) => o.market === 'maps_total')
    .sort((a, b) => a.side.localeCompare(b.side)).map((o) => o.odds.toFixed(3)).join('/');
  if (mt) return `${m.tournament ?? '?'} | maps:${mt}`.toLowerCase();

  return (m.hint || m.sources[0]).toLowerCase();
}

function merge(list) {
  const byKey = new Map();
  for (const m of list) {
    const k = matchKey(m);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...m, activeSlots: new Set([m.active]) }); continue; }
    const seen = new Set(prev.offers.map((o) => o.type));
    for (const o of m.offers) if (!seen.has(o.type)) prev.offers.push(o);
    prev.activeSlots.add(m.active);
    prev.sources.push(...m.sources);
    prev.timer = prev.timer ?? m.timer;
    prev.tournament = prev.tournament ?? m.tournament;
    prev.format = prev.format ?? m.format;
    prev.hint = prev.hint ?? m.hint;
    for (const slot of ['1', '2']) if (!prev.teams[slot]?.name && m.teams[slot]?.name) prev.teams[slot] = m.teams[slot];
  }
  // Второй проход: безымянные записи (захвачен только .modal_content, без блока команд)
  // подклеиваем к именованным, если совпал тотал карт — это отпечаток уровня матча.
  const all = [...byKey.values()];
  const named = all.filter((m) => Object.values(m.teams).some((t) => t.name));
  const fp = (m) => m.offers.filter((o) => o.market === 'maps_total')
    .sort((a, b) => a.side.localeCompare(b.side)).map((o) => o.odds.toFixed(3)).join('/');

  return all.filter((m) => {
    if (named.includes(m) || !fp(m)) return true;
    const host = named.find((n) => fp(n) === fp(m));
    if (!host) return true;
    const seen = new Set(host.offers.map((o) => o.type));
    for (const o of m.offers) if (!seen.has(o.type)) host.offers.push(o);
    host.sources.push(...m.sources);
    return false;
  });
}

// ── Аналитика ─────────────────────────────────────────────────────────────────
/**
 * Разворачивает сетку исходов серии BO3 из данных одной стороны.
 * Обозначим A = команда, чьи кэфы есть (active), B = соперник.
 *   P(A 2:0) = implied(A -1.5)
 *   P(B 2:0) = 1 - implied(A +1.5)
 *   P(A 2:1) = implied(A серия) - P(A 2:0)
 *   P(B 2:1) = implied(тотал карт > 2.5) - P(A 2:1)
 */
function seriesShape(m) {
  const A = m.active;
  if (!A) return null;
  const B = A === '1' ? '2' : '1';
  const f = (pred) => m.offers.find(pred)?.odds ?? null;

  const oSeriesA = f((o) => o.market === 'series' && o.team === A);
  const oSeriesB = f((o) => o.market === 'series' && o.team === B);
  const oAminus = f((o) => o.market === 'maps_fora' && o.team === A && o.hcap < 0);
  const oAplus = f((o) => o.market === 'maps_fora' && o.team === A && o.hcap > 0);
  const oBminus = f((o) => o.market === 'maps_fora' && o.team === B && o.hcap < 0);
  const oBplus = f((o) => o.market === 'maps_fora' && o.team === B && o.hcap > 0);
  const oOver = f((o) => o.market === 'maps_total' && o.side === 'over');
  const oUnder = f((o) => o.market === 'maps_total' && o.side === 'under');
  if (!oSeriesA) return null;

  /**
   * Книга = два взаимодополняющих исхода. «A −1.5» и «B +1.5» — одно и то же событие
   * с двух сторон, поэтому маржа снимается внутри книги. Если есть только одна сторона,
   * значение остаётся сырым (завышенным на маржу) — помечаем solid: false.
   */
  const book = (yes, no) => {
    if (yes && no) return { p: imp(yes) / (imp(yes) + imp(no)), margin: imp(yes) + imp(no) - 1, solid: true };
    if (yes) return { p: imp(yes), margin: null, solid: false };
    if (no) return { p: 1 - imp(no), margin: null, solid: false };
    return null;
  };

  // Три события, полностью покрывающие пространство исходов BO3.
  const parts = {
    a20: book(oAminus, oBplus),   // A всухую
    b20: book(oBminus, oAplus),   // B всухую
    p3: book(oOver, oUnder),      // три карты
  };
  // Карта #1 как независимая проверка: из вероятности взять одну карту выводится
  // вероятность серии, q²(3−2q). Если сходится с книгой исхода — модель букмекера цельная.
  const oMapA = f((o) => o.market === 'map_win' && o.map === 1 && o.team === A);
  const oMapB = f((o) => o.market === 'map_win' && o.map === 1 && o.team === B);
  const bMap = book(oMapA, oMapB);
  const mapCheck = bMap?.solid
    ? { q: bMap.p, seriesFromMap: bMap.p ** 2 * (3 - 2 * bMap.p) }
    : null;

  const have = Object.entries(parts).filter(([, v]) => v);

  // Сокращённый режим: форы по картам в линии нет (частое дело на тир-3), но исход
  // и тотал карт есть. Разбивку на «всухую / 2:1» не построить, а вот сами шансы — да.
  if (have.length < 2) {
    if (!oSeriesB || !parts.p3) return null;
    const pAr0 = imp(oSeriesA);
    const pA0 = pAr0 / (pAr0 + imp(oSeriesB));
    return {
      reduced: true,
      fair: null,
      books: parts,
      bookCount: have.length,
      pA: pA0,
      pB: 1 - pA0,
      p3maps: parts.p3.p,
      bSeriesActual: oSeriesB,
      mapCheck,
      disagreement: null,
      p3FromHandicaps: null,
      p3FromTotals: parts.p3.p,
    };
  }

  // Известны все три — нормируем совместно (по отдельности книги в сумму 1 не складываются).
  // Известны две — третье событие достраивается как остаток.
  let vals;
  let disagreement = null;
  if (have.length === 3) {
    const s = parts.a20.p + parts.b20.p + parts.p3.p;
    disagreement = s - 1;
    vals = { a20: parts.a20.p / s, b20: parts.b20.p / s, p3: parts.p3.p / s };
  } else {
    const missing = ['a20', 'b20', 'p3'].find((k) => !parts[k]);
    const known = Object.fromEntries(have.map(([k, v]) => [k, v.p]));
    known[missing] = Math.max(0, 1 - have.reduce((acc, [, v]) => acc + v.p, 0));
    const s = known.a20 + known.b20 + known.p3;
    vals = { a20: known.a20 / s, b20: known.b20 / s, p3: known.p3 / s };
  }
  const { a20, b20, p3 } = vals;

  // Доля A в серии: обе стороны — честная пара, одна — сырое значение с зажимом.
  const pAr = imp(oSeriesA);
  const pA = oSeriesB ? pAr / (pAr + imp(oSeriesB)) : Math.min(Math.max(pAr, a20), a20 + p3);

  // Три карты делим между командами. Сумма четвёрки равна 1 тождественно:
  // a20 + (pA − a20) + (p3 − pA + a20) + b20 = a20 + b20 + p3 = 1.
  const a21 = Math.min(Math.max(pA - a20, 0), p3);
  const b21 = p3 - a21;
  const clamped = Math.abs(pA - a20 - a21) > 1e-9;

  return {
    fair: { a20, a21, b21, b20 },
    books: parts,
    solidHandicaps: !!(parts.a20?.solid || parts.b20?.solid),
    bookCount: have.length,
    clamped,
    mapCheck,
    pA: a20 + a21,
    pB: b21 + b20,
    p3maps: p3,
    bSeriesOdds: b21 + b20 > 0 ? 1 / (b21 + b20) : null,
    bSeriesActual: oSeriesB,
    // Рассогласование книг: насколько сумма трёх независимо очищенных вероятностей
    // отличается от единицы. Маржа уже снята, так что это чистое расхождение мнений.
    disagreement,
    p3FromHandicaps: parts.a20 && parts.b20 ? 1 - parts.a20.p - parts.b20.p : null,
    p3FromTotals: parts.p3?.p ?? null,
  };
}

/** Двусторонние рынки -> маржа + очищенные вероятности. */
function pairs(m) {
  const out = [];
  const push = (label, market, x, y) => {
    if (!x || !y) return;
    const s = imp(x.odds) + imp(y.odds);
    out.push({
      label, market,
      a: { ...x, implied: imp(x.odds), fair: imp(x.odds) / s },
      b: { ...y, implied: imp(y.odds), fair: imp(y.odds) / s },
      margin: s - 1,
    });
  };

  const mt = m.offers.filter((o) => o.market === 'maps_total');
  push(`Тотал карт ${mt[0]?.line ?? 2.5}`, 'maps_total',
    mt.find((o) => o.side === 'over'), mt.find((o) => o.side === 'under'));

  const rt = m.offers.filter((o) => o.market === 'rounds_total');
  for (const line of [...new Set(rt.map((o) => o.line))].sort((x, y) => x - y)) {
    push(`Тотал раундов ${line}`, 'rounds_total',
      rt.find((o) => o.line === line && o.side === 'over'),
      rt.find((o) => o.line === line && o.side === 'under'));
  }

  const oe = m.offers.filter((o) => o.market === 'oddeven');
  push('Чёт / нечёт', 'oddeven', oe.find((o) => o.side === 'even'), oe.find((o) => o.side === 'odd'));

  const ser = m.offers.filter((o) => o.market === 'series');
  if (ser.length === 2) push('Исход серии', 'series', ser.find((o) => o.team === '1'), ser.find((o) => o.team === '2'));

  // Фора по картам: «X −1.5» и «Y +1.5» — это две стороны ОДНОЙ книги.
  // Пары собираются только когда скачаны обе вкладки команд.
  const mf = m.offers.filter((o) => o.market === 'maps_fora');
  for (const line of [...new Set(mf.map((o) => Math.abs(o.hcap)))].sort((x, y) => x - y)) {
    for (const t of ['1', '2']) {
      const minus = mf.find((o) => o.team === t && o.hcap === -line);
      const plus = mf.find((o) => o.team !== t && o.hcap === +line);
      if (minus && plus) {
        push(`Фора: ${minus.teamLabel ?? `К${minus.team}`} −${line} / ${plus.teamLabel ?? `К${plus.team}`} +${line}`,
             'maps_fora', minus, plus);
      }
    }
  }

  return out;
}

// ── Отчёт ─────────────────────────────────────────────────────────────────────
function report(m) {
  const fromHint = (m.hint ?? '').split(/\s+vs\s+/i).map((s) => s.replace(/\s*\[[^\]]*\]\s*$/, '').trim());
  const nameOf = (slot) => m.teams[slot]?.name || fromHint[+slot - 1] || `Команда ${slot}`;
  const t1 = nameOf('1');
  const t2 = nameOf('2');
  const A = m.active;
  const L = [];

  L.push(`## ${t1} vs ${t2}`, '');
  L.push(`**${m.tournament ?? '?'}** · **${m.format ?? '?'}** · до старта: \`${m.timer ?? '?'}\``);
  L.push(`Заходов: ${m.activeSlots?.size ?? 1} (кэфы стороны: **${A ? nameOf(A) : '?'}**) · офферов: ${m.offers.length}`);
  L.push('');

  const shape = seriesShape(m);
  if (shape) {
    const B = A === '1' ? '2' : '1';
    L.push('### 🎯 Сетка исходов серии', '');
    if (shape.reduced) {
      L.push('⚠️ **Сокращённый режим.** Форы по картам в линии нет — разбивку «всухую / 2:1» ' +
             'построить не из чего. Шансы на серию и на три карты считаются напрямую.');
      L.push('');
    } else {
      L.push(`Книг задействовано: **${shape.bookCount}/3**` +
             (shape.solidHandicaps ? ' · фора взята с обеих сторон, маржа снята честно.'
                                   : ' · ⚠️ фора только с одной стороны — оценка разгрома завышена на маржу.') +
             (shape.clamped ? ' · 🚨 книги противоречат друг другу, значения зажаты по границе.' : ''));
      L.push('');
      L.push('| Исход | Вероятность |', '|---|:-:|');
      L.push(`| ${nameOf(A)} 2:0 | **${pct(shape.fair.a20)}** |`);
      L.push(`| ${nameOf(A)} 2:1 | **${pct(shape.fair.a21)}** |`);
      L.push(`| ${nameOf(B)} 2:1 | **${pct(shape.fair.b21)}** |`);
      L.push(`| ${nameOf(B)} 2:0 | **${pct(shape.fair.b20)}** |`);
      L.push('');
    }
    L.push(`**Итог:** ${nameOf(A)} **${pct(shape.pA)}** · ${nameOf(B)} **${pct(shape.pB)}** · три карты **${pct(shape.p3maps)}**`);

    if (!shape.bSeriesActual) {
      L.push('');
      L.push(`> 🔮 **Реконструкция.** Кэф на ${nameOf(B)} в серии не скачан, но выводится: ` +
             `**${odds(shape.bSeriesOdds)}**.`);
    }

    if (shape.mapCheck) {
      const d = Math.abs(shape.mapCheck.seriesFromMap - shape.pA);
      L.push('');
      L.push(`> ${d < 0.02 ? '✅' : '⚠️'} **Сверка через карту #1.** Книга даёт ${nameOf(A)} ` +
             `**${pct(shape.mapCheck.q)}** на отдельной карте. Отсюда шанс на серию BO3 ` +
             `равен q²(3−2q) = **${pct(shape.mapCheck.seriesFromMap)}**, а книга исхода говорит ` +
             `**${pct(shape.pA)}** — разница ${(d * 100).toFixed(1)} п.п. ` +
             (d < 0.02
               ? 'Модель букмекера внутренне цельная.'
               : 'Книги расходятся: одна из них ставится менее аккуратно.'));
    }

    if (shape.p3FromHandicaps != null && shape.p3FromTotals != null) {
      const d = Math.abs(shape.p3FromTotals - shape.p3FromHandicaps);
      const ok = d < 0.05;
      L.push('');
      L.push(`> ${ok ? '✅' : '🚨'} **Рассогласование книг.** P(три карты) по форам = **${pct(shape.p3FromHandicaps)}**, ` +
             `по тоталу карт = **${pct(shape.p3FromTotals)}**, разница **${(d * 100).toFixed(1)} п.п.**`);
      L.push('>');
      L.push('> Маржа здесь уже снята внутри каждой книги, так что это не её след, а расхождение ' +
             'самих оценок букмекера. ' +
             (ok ? 'В пределах нормы.'
                 : `Тотал карт ждёт ${shape.p3FromTotals > shape.p3FromHandicaps ? 'затяжную серию' : 'разгром'} ` +
                   'заметно охотнее, чем форы. Обычно сильнее та книга, где маржа ниже — сверься с таблицей ниже, ' +
                   'прежде чем считать это вэлью.'));
    }
    L.push('');
  }

  const ps = pairs(m);
  if (ps.length) {
    L.push('### ⚖️ Двусторонние рынки: маржа', '');
    L.push('| Рынок | Тир | Сторона A | Сторона B | Маржа |', '|---|:-:|---|---|:-:|');
    const sorted = [...ps].sort((x, y) => (TIER[x.market]?.order ?? 99) - (TIER[y.market]?.order ?? 99));
    for (const p of sorted) {
      const tr = TIER[p.market]?.tier ?? '?';
      const warn = p.margin > 0.095 ? ' 🔴' : p.margin > 0.088 ? ' 🟠' : ' 🟢';
      L.push(`| ${p.label} | ${TIER_MARK[tr] ?? ''} | ${odds(p.a.odds)} → ${pct(p.a.fair)} | ` +
             `${odds(p.b.odds)} → ${pct(p.b.fair)} | **${pct(p.margin)}**${warn} |`);
    }
    L.push('');
    const cheapest = sorted.reduce((x, y) => (y.margin < x.margin ? y : x));
    L.push(`Самый дешёвый рынок здесь — **${cheapest.label}** (${pct(cheapest.margin)}).`);
    L.push('');
  }

  // Все офферы по тирам
  const groups = new Map();
  for (const o of m.offers) {
    const g = groups.get(o.market) ?? [];
    g.push(o);
    groups.set(o.market, g);
  }
  const ordered = [...groups.entries()].sort((x, y) => (TIER[x[0]]?.order ?? 99) - (TIER[y[0]]?.order ?? 99));

  for (const grade of ['A', 'B', 'C']) {
    const g = ordered.filter(([k]) => TIER[k]?.tier === grade);
    if (!g.length) continue;
    const head = { A: '🅰️ Приоритет — сюда смотрим', B: '🅱️ При сильном сигнале', C: '🅾️ Маржа-ловушки — по умолчанию пас' }[grade];
    L.push(`### ${head}`, '');
    L.push('| Рынок | Кэф | Implied | Нужна P для Edge ≥3% | Лимит |', '|---|:-:|:-:|:-:|:-:|');
    for (const [, list] of g) {
      for (const o of list.sort((x, y) => x.odds - y.odds)) {
        const need = (1 + EDGE_FLOOR) / o.odds;
        const label = o.text || o.type;
        const teamTag = o.team ? ` *(${nameOf(o.team)})*` : '';
        L.push(`| ${label}${teamTag} | **${odds(o.odds)}** | ${pct(imp(o.odds))} | ${need > 1 ? '—' : pct(need)} | ${o.max ? o.max + ' ₽' : '—'} |`);
      }
    }
    L.push('');
  }

  return L.join('\n');
}

// ── Ввод/вывод ────────────────────────────────────────────────────────────────
function collectFiles(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) { console.warn(`  ! не найдено: ${p}`); continue; }
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs)) {
        if (['.html', '.htm', '.json'].includes(extname(f).toLowerCase())) files.push(join(abs, f));
      }
    } else files.push(abs);
  }
  return files;
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = resolve(outIdx >= 0 ? argv[outIdx + 1] : 'input/parsed');
  // Без --out индекс равен -1, поэтому проверку на «это значение флага» делаем только когда флаг есть.
  const inputs = argv.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  const files = collectFiles(inputs.length ? inputs : ['input/html']);

  if (!files.length) {
    console.error('Нет входных файлов. Положи outerHTML модалок в input/html/ и запусти снова.');
    console.error('Подсказка: tools/grab-console.js — сниппет для консоли браузера, забирает обе стороны сам.');
    process.exit(1);
  }

  const parsed = [];
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    try {
      if (extname(f).toLowerCase() === '.json') {
        const data = JSON.parse(raw);
        for (const item of Array.isArray(data) ? data : [data]) {
          const hint = item.label && !/не найден/i.test(item.label) ? item.label : null;
          parsed.push(...parseHtml(item.html ?? item, item.source ?? f, hint));
        }
      } else {
        parsed.push(...parseHtml(raw, f));
      }
    } catch (e) {
      console.warn(`  ! ошибка разбора ${f}: ${e.message}`);
    }
  }

  const matches = merge(parsed);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const md = [
    '# 📊 Разбор линии',
    '',
    `Файлов: ${files.length} · матчей: ${matches.length} · офферов: ${matches.reduce((s, m) => s + m.offers.length, 0)}`,
    '',
    'Тиры рынков — из [MARKETS.md](../../MARKETS.md). Колонка «Нужна P для Edge ≥3%» — минимальная',
    'вероятность, при которой ставка проходит порог входа из [README.md](../../README.md).',
    '',
    '---',
    '',
    ...matches.map(report).flatMap((r) => [r, '---', '']),
  ].join('\n');

  writeFileSync(join(outDir, 'report.md'), md, 'utf8');
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(
    matches.map((m) => ({ ...m, activeSlots: [...(m.activeSlots ?? [])], shape: seriesShape(m), pairs: pairs(m) })),
    null, 2), 'utf8');

  console.log(`OK  ${matches.length} match(es), ${files.length} file(s)`);
  for (const m of matches) {
    const s = seriesShape(m);
    const t = Object.values(m.teams).map((x) => x.name).join(' vs ');
    console.log(`  - ${t} [${m.tournament ?? '?'} ${m.format ?? '?'}] offers=${m.offers.length}` +
                (s ? ` P=${pct(s.pA)}/${pct(s.pB)}` : ''));
  }
  console.log(`->  ${join(outDir, 'report.md')}`);
}

main();
