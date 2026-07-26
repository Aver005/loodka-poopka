#!/usr/bin/env node
/**
 * scan-secrets.mjs — страж коммитов.
 *
 *   node tools/scan-secrets.mjs            проверить проиндексированное (режим хука)
 *   node tools/scan-secrets.mjs --all      проверить все отслеживаемые файлы
 *   node tools/scan-secrets.mjs --install  включить хук (core.hooksPath)
 *
 * Проверяется СОДЕРЖИМОЕ ИНДЕКСА (`git show :файл`), а не рабочая копия:
 * коммитится именно оно, и `git add -p` может отправить туда не то, что видно в редакторе.
 *
 * Здесь намеренно нет проектных паттернов вроде домена букмекера: файл публичный,
 * и вписать в него то, что он охраняет, значит это опубликовать. Такие правила
 * лежат в `.scanlocal` — он в .gitignore.
 *
 * Zero dependencies.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BLOCK = 'block';
const WARN = 'warn';

// ── Правила ───────────────────────────────────────────────────────────────────
// minCount — сколько совпадений нужно, чтобы правило сработало. Нужен там, где
// одиночное вхождение это нормальный пример в документации, а десяток — уже дамп.
const RULES = [
  // Ключи и токены
  { id: 'private-key', level: BLOCK, msg: 'Приватный ключ',
    re: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { id: 'jwt', level: BLOCK, msg: 'JWT-токен',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'aws-key', level: BLOCK, msg: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', level: BLOCK, msg: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', level: BLOCK, msg: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-key', level: BLOCK, msg: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', level: BLOCK, msg: 'Stripe secret key', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { id: 'anthropic-key', level: BLOCK, msg: 'Ключ Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'openai-key', level: BLOCK, msg: 'Ключ OpenAI', re: /\bsk-proj-[A-Za-z0-9_-]{16,}/ },
  { id: 'telegram-token', level: BLOCK, msg: 'Токен Telegram-бота', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}\b/ },

  // Присвоения секретов в коде и конфигах
  { id: 'secret-assign', level: BLOCK, msg: 'Секрет в присвоении',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { id: 'conn-string', level: BLOCK, msg: 'Строка подключения с паролем',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|ftp):\/\/[^\s:/@]+:[^\s@]{3,}@/i },

  // Сессии и куки
  { id: 'session-cookie', level: BLOCK, msg: 'Сессионная кука',
    re: /\b(?:PHPSESSID|JSESSIONID|connect\.sid|remember_token|_session_id)\s*[=:]\s*\S{8,}/i },
  { id: 'set-cookie', level: BLOCK, msg: 'Заголовок Set-Cookie', re: /^\s*Set-Cookie:\s*\S/im },

  // Чужие персональные данные с чужих сайтов
  { id: 'site-chat-pii', level: BLOCK, minCount: 2, msg: 'Никнеймы из чужого чата',
    re: /class=\\?"nick\\?"/ },
  { id: 'profile-ids', level: BLOCK, minCount: 2, msg: 'Ссылки на чужие профили',
    re: /\/profile\/\d{3,}/ },

  // Сырые выгрузки чужих сайтов
  { id: 'raw-odds-dump', level: BLOCK, minCount: 5, msg: 'Сырой HTML-дамп линии букмекера',
    re: /class=\\?"koef\\?"/ },
  { id: 'logged-in-markup', level: WARN, minCount: 2, msg: 'Разметка залогиненной сессии',
    re: /\b(?:logout|signout|sign-out)\b/i },

  // Утечки локального окружения
  { id: 'windows-userpath', level: BLOCK, msg: 'Windows-путь с именем пользователя',
    re: /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|All Users\b)[A-Za-z0-9._-]+/ },
  { id: 'unix-homepath', level: WARN, msg: 'Домашний путь Unix', re: /\/(?:home|Users)\/(?!runner\b)[a-z][a-z0-9._-]{2,}\// },
  { id: 'email', level: WARN, msg: 'Почтовый адрес',
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|test\b|localhost\b|noreply\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

const MAX_BYTES = 512 * 1024;
const SELF = ['tools/scan-secrets.mjs', '.scanignore', '.scanlocal', '.githooks/pre-commit'];

// ── Ignore-механика ───────────────────────────────────────────────────────────
/** .scanignore: glob-строки как в .gitignore. Пустые строки и # — комментарии. */
function loadIgnore() {
  if (!existsSync('.scanignore')) return [];
  return readFileSync('.scanignore', 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Простой glob: * внутри сегмента, ** через сегменты, // в конце — вся папка. */
function globToRe(g) {
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}${g.endsWith('/') ? '.*' : ''}$`);
}

/** .scanlocal: по одному регулярному выражению на строку. Файл не версионируется. */
function loadLocalRules() {
  if (!existsSync('.scanlocal')) return [];
  return readFileSync('.scanlocal', 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((src, i) => {
      const [pattern, label] = src.split(/\s+#\s+/);
      try {
        return { id: `local-${i + 1}`, level: BLOCK, re: new RegExp(pattern), msg: label || 'Локальное правило' };
      } catch {
        console.error(`  ! .scanlocal: не удалось разобрать регулярку — ${src}`);
        return null;
      }
    }).filter(Boolean);
}

// ── Git ───────────────────────────────────────────────────────────────────────
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function stagedFiles() {
  return git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').map((s) => s.trim()).filter(Boolean);
}
function stagedContent(path) {
  try { return execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

// ── Проверка ──────────────────────────────────────────────────────────────────
const redact = (s) => {
  const t = s.length > 90 ? `${s.slice(0, 60)}…` : s;
  return t.length > 16 ? `${t.slice(0, 8)}${'•'.repeat(6)}${t.slice(-6)}` : t;
};

function scanFile(path, buf, rules) {
  const findings = [];
  if (buf.length > MAX_BYTES) {
    findings.push({ path, line: 0, level: WARN, msg: `Крупный файл, ${(buf.length / 1024 | 0)} КБ — не выгрузка ли это`, sample: '' });
  }
  if (buf.subarray(0, 8000).includes(0)) return findings; // бинарник — содержимое не читаем

  const text = buf.toString('utf8');
  if (/(^|\n)[^\n]*scan:ignore-file/.test(text.slice(0, 2000))) return [];

  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('scan:ignore')) continue;
      const m = rule.re.exec(lines[i]);
      if (m) hits.push({ line: i + 1, sample: redact(m[0]) });
    }
    if (!hits.length || hits.length < (rule.minCount ?? 1)) continue;
    for (const h of hits.slice(0, 3)) {
      findings.push({ path, line: h.line, level: rule.level, msg: rule.msg, sample: h.sample, id: rule.id });
    }
    if (hits.length > 3) {
      findings.push({ path, line: hits[3].line, level: rule.level, msg: `${rule.msg} — ещё ${hits.length - 3} совпадений`, sample: '', id: rule.id });
    }
  }
  return findings;
}

// ── Установка хука ────────────────────────────────────────────────────────────
function install() {
  mkdirSync('.githooks', { recursive: true });
  writeFileSync(join('.githooks', 'pre-commit'),
    '#!/bin/sh\n# Страж коммитов. Обойти: git commit --no-verify\nexec node tools/scan-secrets.mjs\n',
    { encoding: 'utf8', mode: 0o755 });
  git('config', 'core.hooksPath', '.githooks');
  console.log('✅ Хук установлен: core.hooksPath = .githooks');
  console.log('   Проверить вручную: node tools/scan-secrets.mjs --all');
}

// ── main ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--install')) { install(); process.exit(0); }

const all = argv.includes('--all');
const ignoreRe = loadIgnore().map(globToRe);
const rules = [...RULES, ...loadLocalRules()];

const files = (all ? git('ls-files').split('\n').map((s) => s.trim()).filter(Boolean) : stagedFiles())
  .filter((f) => !SELF.includes(f))
  .filter((f) => !ignoreRe.some((re) => re.test(f)));

if (!files.length) process.exit(0);

const findings = [];
for (const f of files) {
  const buf = all ? (existsSync(f) ? readFileSync(f) : null) : stagedContent(f);
  if (buf) findings.push(...scanFile(f, buf, rules));
}

const blocks = findings.filter((f) => f.level === BLOCK);
const warns = findings.filter((f) => f.level === WARN);

if (!findings.length) {
  console.log(`✅ Проверено файлов: ${files.length}. Чувствительного не найдено.`);
  process.exit(0);
}

const show = (list, icon) => {
  for (const f of list) {
    console.error(`  ${icon} ${f.path}:${f.line}`);
    console.error(`     ${f.msg}${f.id ? `  [${f.id}]` : ''}`);
    if (f.sample) console.error(`     ${f.sample}`);
  }
};

console.error('');
if (blocks.length) { console.error(`🚫 Коммит остановлен — блокирующих находок: ${blocks.length}`); console.error(''); show(blocks, '✗'); }
if (warns.length) { console.error(''); console.error(`⚠️  Предупреждений: ${warns.length} (коммит не блокируют)`); console.error(''); show(warns, '!'); }

if (blocks.length) {
  console.error('');
  console.error('  Что делать:');
  console.error('    • убрать данные из файла — самый правильный путь');
  console.error('    • если файл безопасен, добавить путь в .scanignore');
  console.error('    • если безопасна одна строка, дописать в неё комментарий  scan:ignore');
  console.error('    • весь файл целиком —  scan:ignore-file  в первых строках');
  console.error('    • git commit --no-verify — крайний случай, осознанно');
  console.error('');
  process.exit(1);
}
process.exit(0);
