#!/usr/bin/env bun
/**
 * build.ts — сборка расширения.
 *
 *   bun run build          собрать в extension/dist
 *   bun run dev            то же + пересборка по изменениям
 *
 * Ключевой момент: content script собирается в **iife**, а не в esm.
 * Content script в MV3 не может быть ES-модулем — браузер его просто не выполнит.
 * Панель и service worker живут в нормальных контекстах, там esm работает.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

const ROOT = resolve(import.meta.dir);
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'dist');

const log = (msg: string) => console.log(`  ${msg}`);

async function buildOnce(): Promise<boolean>
{
  // Чистим папку целиком. Бандлы панели именуются с хешем, и без этого
  // от прежних сборок копятся мёртвые файлы по ~900 КБ каждый.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // ── 0. Стили оверлея — СНАЧАЛА, потому что они вшиваются в content script ───
  // Тянуть их из content script через fetch оказалось плохой идеей: запрос
  // молча не долетал, и оверлей рендерился вообще без стилей. Строка в бандле
  // не может «не долететь» — ни сети, ни CSP, ни асинхронности.
  const css = await Bun.build(
  {
    entrypoints: [join(SRC, 'styles.css')],
    outdir: OUT,
    naming: 'overlay.[ext]',
    plugins: [tailwind],
  });
  if (!css.success)
  {
    report('styles', css.logs);
    return false;
  }

  const cssText = await Bun.file(join(OUT, 'overlay.css')).text();
  mkdirSync(join(SRC, 'generated'), { recursive: true });
  await Bun.write(
    join(SRC, 'generated', 'overlay-css.ts'),
    `// Сгенерировано build.ts — не редактировать руками.\n` +
      `export const OVERLAY_CSS = ${JSON.stringify(cssText)};\n`,
  );

  // ── 1. Content script: iife, иначе браузер его не запустит ──────────────────
  const content = await Bun.build(
  {
    entrypoints: [join(SRC, 'content', 'index.tsx')],
    outdir: OUT,
    naming: 'content.js',
    format: 'iife',
    target: 'browser',
    minify: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!content.success)
  {
    report('content', content.logs);
    return false;
  }

  // ── 2. Service worker ───────────────────────────────────────────────────────
  const bg = await Bun.build(
  {
    entrypoints: [join(SRC, 'background.ts')],
    outdir: OUT,
    naming: 'background.js',
    format: 'esm',
    target: 'browser',
  });
  if (!bg.success)
  {
    report('background', bg.logs);
    return false;
  }

  // ── 3. Боковая панель: html как точка входа, Bun сам подтянет tsx и css ─────
  const panel = await Bun.build(
  {
    entrypoints: [join(SRC, 'panel', 'index.html')],
    outdir: OUT,
    naming: { entry: 'panel.[ext]', chunk: 'panel-[hash].[ext]', asset: 'panel-[name].[ext]' },
    target: 'browser',
    format: 'esm',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!panel.success)
  {
    report('panel', panel.logs);
    return false;
  }

  // ── 4. Бейджи живут в светлом DOM страницы, им нужен обычный css-файл ───────
  await Bun.write(join(OUT, 'badges.css'), badgeCss());

  // ── 5. Манифест ─────────────────────────────────────────────────────────────
  const manifest = join(ROOT, 'manifest.json');
  if (!existsSync(manifest))
  {
    console.error('\n  ✗ Нет extension/manifest.json');
    console.error('    Скопируй manifest.example.json и подставь домен сайта.');
    console.error('    Рабочий манифест не версионируется: домен нельзя публиковать.\n');
    return false;
  }
  await Bun.write(join(OUT, 'manifest.json'), await Bun.file(manifest).text());

  const files = readdirSync(OUT).filter((f) => statSync(join(OUT, f)).isFile());
  log(`✅ собрано → extension/dist (${files.length} файлов)`);
  return true;
}

function report(what: string, logs: readonly unknown[]): void
{
  console.error(`\n  ✗ ошибка сборки: ${what}`);
  for (const l of logs) console.error(`    ${l}`);
}

/** Бейджи вставляются в чужую вёрстку, поэтому стили у них свои и нейтральные. */
function badgeCss(): string
{
  return `/* Бейджи расширения в светлом DOM страницы. Префикс lp- во избежание коллизий. */
.lp-badge{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:4px;
  font:500 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;
  vertical-align:middle;white-space:nowrap;border:1px solid transparent}
.lp-badge--a{color:#7ee2b0;background:rgba(126,226,176,.10);border-color:rgba(126,226,176,.28)}
.lp-badge--b{color:#e7cf87;background:rgba(231,207,135,.10);border-color:rgba(231,207,135,.26)}
.lp-badge--c{color:#8a8f9c;background:rgba(138,143,156,.08);border-color:rgba(138,143,156,.20)}
.lp-badge--trap{text-decoration:line-through;opacity:.55}
#lp-overlay-host{display:block;margin:8px 0}
`;
}

const ok = await buildOnce();

if (Bun.argv.includes('--watch'))
{
  log('👀 слежу за изменениями, Ctrl+C для выхода');
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(SRC, { recursive: true }, (_event, file) =>
  {
    // src/generated пишет сама сборка — без этой проверки получилась бы
    // бесконечная пересборка, порождающая саму себя.
    if (file && file.replace(/\\/g, '/').includes('generated/')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void buildOnce(), 150);
  });
}
else if (!ok)
{
  process.exit(1);
}
