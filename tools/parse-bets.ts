#!/usr/bin/env bun
/**
 * parse-bets.ts — превращает выгрузки модалок в читаемый отчёт.
 *
 *   bun run parse                      input/html/ -> input/parsed/
 *   bun run parse <dir|file...>        явные пути
 *   bun run parse --out <dir>
 *
 * Вся математика живёт в extension/src/engine.ts и общая с расширением,
 * поэтому «подсказка на сайте» и «отчёт в репозитории» не могут разойтись.
 * Здесь только ввод-вывод и вёрстка markdown.
 */

import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import {
  analyze,
  parseHtml,
  seriesShape,
  pairs,
  nameOf,
  TIER,
  TIER_MARK,
  EDGE_FLOOR,
  pct,
  oddsFmt,
  imp,
  requiredP,
  type MarketKey,
  type Match,
  type Offer,
  type TeamSlot,
} from '@lp/extension/engine';

// ── Склейка нескольких заходов по одному матчу ────────────────────────────────
/**
 * Ключ матча. Имена команд есть не всегда: если захвачен только .modal_content,
 * блок team_select в дамп не попадает. Тогда отпечатком служит тотал карт —
 * это рынок уровня матча, и на вкладках обеих команд он одинаковый.
 */
function matchKey(m: Match): string
{
  const names = Object.values(m.teams)
    .map((t) => t.name)
    .filter(Boolean)
    .sort();
  if (names.length === 2) return `${m.tournament ?? '?'} | ${names.join(' | ')}`.toLowerCase();

  const mt = m.offers
    .filter((o) => o.market === 'maps_total')
    .sort((a, b) => (a.side ?? '').localeCompare(b.side ?? ''))
    .map((o) => o.odds.toFixed(3))
    .join('/');
  if (mt) return `${m.tournament ?? '?'} | maps:${mt}`.toLowerCase();

  return (m.hint ?? m.sources[0] ?? '?').toLowerCase();
}

interface Merged extends Match
{
  activeSlots: Set<TeamSlot | null>;
}

function merge(list: Match[]): Merged[]
{
  const byKey = new Map<string, Merged>();
  for (const m of list)
  {
    const k = matchKey(m);
    const prev = byKey.get(k);
    if (!prev)
    {
      byKey.set(k, { ...m, activeSlots: new Set([m.active]) });
      continue;
    }
    const seen = new Set(prev.offers.map((o) => o.type));
    for (const o of m.offers) if (!seen.has(o.type)) prev.offers.push(o);
    prev.activeSlots.add(m.active);
    prev.sources.push(...m.sources);
    prev.timer ??= m.timer;
    prev.tournament ??= m.tournament;
    prev.format ??= m.format;
    prev.hint ??= m.hint;
    for (const slot of ['1', '2'] as const)
    {
      if (!prev.teams[slot]?.name && m.teams[slot]?.name) prev.teams[slot] = m.teams[slot];
    }
  }

  // Второй проход: безымянные записи подклеиваем к именованным по отпечатку тотала карт.
  const all = [...byKey.values()];
  const named = all.filter((m) => Object.values(m.teams).some((t) => t.name));
  const fp = (m: Match) =>
    m.offers
      .filter((o) => o.market === 'maps_total')
      .sort((a, b) => (a.side ?? '').localeCompare(b.side ?? ''))
      .map((o) => o.odds.toFixed(3))
      .join('/');

  return all.filter((m) =>
  {
    if (named.includes(m) || !fp(m)) return true;
    const host = named.find((n) => fp(n) === fp(m));
    if (!host) return true;
    const seen = new Set(host.offers.map((o) => o.type));
    for (const o of m.offers) if (!seen.has(o.type)) host.offers.push(o);
    host.sources.push(...m.sources);
    return false;
  });
}

// ── Отчёт ─────────────────────────────────────────────────────────────────────
function report(m: Merged): string
{
  const name = (slot: TeamSlot) => nameOf(m, slot);
  const A = m.active;
  const L: string[] = [];

  L.push(`## ${name('1')} vs ${name('2')}`, '');
  L.push(`**${m.tournament ?? '?'}** · **${m.format ?? '?'}** · до старта: \`${m.timer ?? '?'}\``);
  L.push(
    `Заходов: ${m.activeSlots.size} (кэфы стороны: **${A ? name(A) : '?'}**) · офферов: ${m.offers.length}`,
  );
  L.push('');

  const shape = seriesShape(m);
  if (shape && A)
  {
    const B: TeamSlot = A === '1' ? '2' : '1';
    L.push('### 🎯 Сетка исходов серии', '');

    if (shape.reduced)
    {
      L.push(
        '⚠️ **Сокращённый режим.** Форы по картам в линии нет — разбивку «всухую / 2:1» ' +
          'построить не из чего. Шансы на серию и на три карты считаются напрямую.',
      );
      L.push('');
    }
    else
    {
      L.push(
        `Книг задействовано: **${shape.bookCount}/3**` +
          (shape.solidHandicaps
            ? ' · фора взята с обеих сторон, маржа снята честно.'
            : ' · ⚠️ фора только с одной стороны — оценка разгрома занижена.') +
          (shape.clamped ? ' · 🚨 книги противоречат друг другу, значения зажаты по границе.' : ''),
      );
      L.push('');
      L.push('| Исход | Вероятность |', '|---|:-:|');
      L.push(`| ${name(A)} 2:0 | **${pct(shape.fair!.a20)}** |`);
      L.push(`| ${name(A)} 2:1 | **${pct(shape.fair!.a21)}** |`);
      L.push(`| ${name(B)} 2:1 | **${pct(shape.fair!.b21)}** |`);
      L.push(`| ${name(B)} 2:0 | **${pct(shape.fair!.b20)}** |`);
      L.push('');
    }

    L.push(
      `**Итог:** ${name(A)} **${pct(shape.pA)}** · ${name(B)} **${pct(shape.pB)}** · три карты **${pct(shape.p3maps)}**`,
    );

    if (!shape.bSeriesActual && shape.bSeriesOdds)
    {
      L.push('');
      L.push(
        `> 🔮 **Реконструкция.** Кэф на ${name(B)} в серии не скачан, но выводится: ` +
          `**${oddsFmt(shape.bSeriesOdds)}**.`,
      );
    }

    if (shape.mapCheck)
    {
      const d = Math.abs(shape.mapCheck.seriesFromMap - shape.pA);
      L.push('');
      L.push(
        `> ${d < 0.02 ? '✅' : '⚠️'} **Сверка через карту #1.** Книга даёт ${name(A)} ` +
          `**${pct(shape.mapCheck.q)}** на отдельной карте. Отсюда шанс на серию BO3 ` +
          `равен q²(3−2q) = **${pct(shape.mapCheck.seriesFromMap)}**, а книга исхода говорит ` +
          `**${pct(shape.pA)}** — разница ${(d * 100).toFixed(1)} п.п. ` +
          (d < 0.02 ? 'Модель букмекера внутренне цельная.' : 'Книги расходятся.'),
      );
    }

    if (shape.p3FromHandicaps != null && shape.p3FromTotals != null)
    {
      const d = Math.abs(shape.p3FromTotals - shape.p3FromHandicaps);
      const ok = d < 0.05;
      L.push('');
      L.push(
        `> ${ok ? '✅' : '🚨'} **Рассогласование книг.** P(три карты) по форам = **${pct(shape.p3FromHandicaps)}**, ` +
          `по тоталу карт = **${pct(shape.p3FromTotals)}**, разница **${(d * 100).toFixed(1)} п.п.**`,
      );
      L.push('>');
      L.push(
        '> Маржа внутри каждой книги уже снята, так что это не её след, а расхождение ' +
          'самих оценок букмекера. ' +
          (ok
            ? 'В пределах нормы.'
            : `Тотал карт ждёт ${shape.p3FromTotals > shape.p3FromHandicaps ? 'затяжную серию' : 'разгром'} ` +
              'заметно охотнее, чем форы. Обычно сильнее та книга, где маржа ниже.'),
      );
    }
    L.push('');
  }

  const ps = pairs(m);
  if (ps.length)
  {
    L.push('### ⚖️ Двусторонние рынки: маржа', '');
    L.push('| Рынок | Тир | Сторона A | Сторона B | Маржа |', '|---|:-:|---|---|:-:|');
    const sorted = [...ps].sort((x, y) => TIER[x.market].order - TIER[y.market].order);
    for (const p of sorted)
    {
      const warn = p.margin > 0.095 ? ' 🔴' : p.margin > 0.088 ? ' 🟠' : ' 🟢';
      L.push(
        `| ${p.label} | ${TIER_MARK[TIER[p.market].tier]} | ${oddsFmt(p.a.odds)} → ${pct(p.a.fair)} | ` +
          `${oddsFmt(p.b.odds)} → ${pct(p.b.fair)} | **${pct(p.margin)}**${warn} |`,
      );
    }
    const cheapest = sorted.reduce((x, y) => (y.margin < x.margin ? y : x));
    L.push('', `Самый дешёвый рынок здесь — **${cheapest.label}** (${pct(cheapest.margin)}).`, '');
  }

  const groups = new Map<MarketKey, Offer[]>();
  for (const o of m.offers) groups.set(o.market, [...(groups.get(o.market) ?? []), o]);
  const ordered = [...groups.entries()].sort(([x], [y]) => TIER[x].order - TIER[y].order);

  for (const grade of ['A', 'B', 'C'] as const)
  {
    const g = ordered.filter(([k]) => TIER[k].tier === grade);
    if (!g.length) continue;
    const head =
    {
      A: '🅰️ Приоритет — сюда смотрим',
      B: '🅱️ При сильном сигнале',
      C: '🅾️ Маржа-ловушки — по умолчанию пас',
    }[grade];
    L.push(`### ${head}`, '');
    L.push('| Рынок | Кэф | Implied | Нужна P для Edge ≥3% | Лимит |', '|---|:-:|:-:|:-:|:-:|');
    for (const [, list] of g)
    {
      for (const o of [...list].sort((x, y) => x.odds - y.odds))
      {
        const need = requiredP(o.odds, EDGE_FLOOR);
        const tag = o.team ? ` *(${name(o.team)})*` : '';
        L.push(
          `| ${o.text || o.type}${tag} | **${oddsFmt(o.odds)}** | ${pct(imp(o.odds))} | ` +
            `${need > 1 ? '—' : pct(need)} | ${o.max ? `${o.max} ₽` : '—'} |`,
        );
      }
    }
    L.push('');
  }

  return L.join('\n');
}

// ── Ввод ──────────────────────────────────────────────────────────────────────
function collectFiles(paths: string[]): string[]
{
  const files: string[] = [];
  for (const p of paths)
  {
    const abs = resolve(p);
    if (!existsSync(abs))
    {
      console.warn(`  ! не найдено: ${p}`);
      continue;
    }
    if (statSync(abs).isDirectory())
    {
      for (const f of readdirSync(abs))
      {
        if (['.html', '.htm', '.json'].includes(extname(f).toLowerCase())) files.push(join(abs, f));
      }
    }
    else files.push(abs);
  }
  return files;
}

// ── main ──────────────────────────────────────────────────────────────────────
const argv = Bun.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = resolve(outIdx >= 0 ? argv[outIdx + 1]! : 'input/parsed');
// Без --out индекс равен -1, поэтому «это значение флага» проверяем только когда флаг есть.
const inputs = argv.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const files = collectFiles(inputs.length ? inputs : ['input/html']);

if (!files.length)
{
  console.error('Нет входных файлов. Положи выгрузку в input/html/ и запусти снова.');
  console.error('Подсказка: tools/grab-console.js — сборщик для консоли браузера.');
  process.exit(1);
}

const parsed: Match[] = [];
for (const f of files)
{
  const raw = await Bun.file(f).text();
  try
  {
    if (extname(f).toLowerCase() === '.json')
    {
      const data = JSON.parse(raw);
      for (const item of Array.isArray(data) ? data : [data])
      {
        const hint = item.label && !/не найден/i.test(item.label) ? item.label : null;
        parsed.push(...parseHtml(item.html ?? item, item.source ?? f, hint));
      }
    }
    else
    {
      parsed.push(...parseHtml(raw, f));
    }
  }
  catch (e)
  {
    console.warn(`  ! ошибка разбора ${f}: ${(e as Error).message}`);
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

await Bun.write(join(outDir, 'report.md'), md);
await Bun.write(
  join(outDir, 'report.json'),
  JSON.stringify(
    matches.map((m) => (
    {
      ...m,
      activeSlots: [...m.activeSlots],
      ...analyze(m),
      match: undefined,
    })),
    null,
    2,
  ),
);

console.log(`OK  ${matches.length} match(es), ${files.length} file(s)`);
for (const m of matches)
{
  const s = seriesShape(m);
  const t = [nameOf(m, '1'), nameOf(m, '2')].join(' vs ');
  console.log(
    `  - ${t} [${m.tournament ?? '?'} ${m.format ?? '?'}] offers=${m.offers.length}` +
      (s ? ` P=${pct(s.pA)}/${pct(s.pB)}` : ''),
  );
}
console.log(`->  ${join(outDir, 'report.md')}`);
