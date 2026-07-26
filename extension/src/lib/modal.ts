import { mergeSides, parseOne, type Match } from '../engine';

/**
 * Поиск модалки на странице и снятие линии с обеих вкладок команд.
 *
 * Тут собраны грабли, на которых сборщик уже спотыкался:
 *
 * 1. Селектор `'#bet, .modal.bets'` брать НЕЛЬЗЯ. CSS-список возвращает первый узел
 *    в порядке документа, а не по приоритету селектора, и модалка подтверждения
 *    ставки `#bet_next` стоит в DOM раньше. Скрипт стабильно хватал не ту.
 * 2. Считать «по максимуму .koef» тоже нельзя: на странице висят скрытые модалки
 *    других матчей, и максимум всегда у <body>. Отбор идёт по ВИДИМЫМ узлам.
 * 3. Общий предок видимых коэффициентов — это `.modal_content`, где блока с командами
 *    уже нет. Поэтому после LCA поднимаемся до узла с `team_select`.
 */

const visible = (el: Element | null): boolean =>
  !!el && !!((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight || el.getClientRects().length);

function lca(nodes: Element[]): Element | null {
  let a: Element | null = nodes[0] ?? null;
  for (const n of nodes.slice(1)) while (a && !a.contains(n)) a = a.parentElement;
  return a;
}

export function findModal(): HTMLElement | null {
  const koefs = [...document.querySelectorAll('.koef')].filter(visible);
  if (!koefs.length) return null;

  let el = lca(koefs);
  const hasTeams = (n: Element | null) =>
    !!n?.querySelector('[class*="team_select"], [class*="team_name"]');

  // Поднимаемся, пока не подхватим блок команд — но не дальше, чем начнут
  // добавляться чужие коэффициенты (значит вылезли за пределы своего матча).
  for (let i = 0; i < 6 && el?.parentElement && el !== document.body; i++) {
    if (hasTeams(el)) break;
    const up: HTMLElement = el.parentElement;
    if ([...up.querySelectorAll('.koef')].filter(visible).length !== koefs.length) break;
    el = up;
  }
  return (el as HTMLElement) ?? null;
}

/** Вкладки команд. Разметка плавает, поэтому несколько стратегий поиска. */
export function findTabs(root: Element | null): HTMLElement[] {
  for (const scope of [root, root?.parentElement, document]) {
    if (!scope) continue;
    const probes: (() => (Element | null | undefined)[])[] = [
      () => [scope.querySelector('[class*="team_1"]'), scope.querySelector('[class*="team_2"]')],
      () => {
        const s = scope.querySelector('.team_select, [class*="team_select"]');
        return s ? [...s.children] : [];
      },
      () => [...scope.querySelectorAll('[class*="team_name"]')]
        .map((n) => n.closest('[class*="team_"]') ?? n.parentElement?.parentElement),
    ];
    for (const probe of probes) {
      const tabs = probe().filter((v): v is HTMLElement => v instanceof HTMLElement)
        .filter((v, i, arr) => arr.indexOf(v) === i);
      if (tabs.length === 2) return tabs;
    }
  }
  return [];
}

const sig = (root: Element | null): string =>
  root ? [...root.querySelectorAll('.koef')].map((n) => n.textContent?.trim()).join(',') : '';

/** Отпечаток видимой линии. Пустая строка — модалки на экране нет. */
export const signature = (): string => sig(findModal());

/** Отпечаток матча, устойчивый к движению кэфов: турнир + названия команд. */
export function matchFingerprint(m: Match): string {
  const names = Object.values(m.teams).map((t) => t.name).filter(Boolean).sort();
  return `${m.tournament ?? '?'}|${names.join('|')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickTab(tab: HTMLElement, root: Element | null): Promise<boolean> {
  const before = sig(root);
  const targets = [tab.querySelector('[class*="team_right"]'), tab.firstElementChild, tab];
  for (const t of targets) {
    if (!(t instanceof HTMLElement)) continue;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'] as const) {
      t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    for (let i = 0; i < 16; i++) {
      await sleep(120);
      const now = sig(findModal() ?? root);
      if (now && now !== before) { await sleep(300); return true; }
    }
  }
  return false;
}

/**
 * Снимает линию. По умолчанию обходит обе вкладки и возвращает вкладку на место.
 *
 * Второй заход нужен не для полноты ради полноты: по одной стороне вероятность
 * разгрома соперника выводится из «+1.5», а там своя маржа, и вычитанием она
 * не убирается. Разница на реальных данных — 18.9% против 25.2%.
 */
export async function captureMatch(bothSides: boolean): Promise<Match | null> {
  const root = findModal();
  if (!root) return null;

  const first = parseOne(root.outerHTML, location.href);
  if (!bothSides) return first;

  const tabs = findTabs(root);
  if (tabs.length !== 2) return first;

  const activeIdx = tabs.findIndex((t) => /\bactive\b/.test(t.className));
  const other = tabs[activeIdx === 0 ? 1 : 0];
  if (!other) return first;

  if (!(await clickTab(other, root))) return first;
  const second = parseOne(findModal()?.outerHTML ?? root.outerHTML, location.href);

  // Возвращаем вкладку как было — пользователь её не переключал, это сделали мы.
  const back = tabs[activeIdx >= 0 ? activeIdx : 0];
  if (back) await clickTab(back, findModal());

  return mergeSides(first, second);
}

/**
 * Дёргает колбэк на изменения DOM с дебаунсом.
 *
 * ⚠️ Своего состояния тут намеренно НЕТ. Раньше наблюдатель сам сравнивал отпечаток
 * с прошлым — и это порождало петлю: наш же клик по вкладке менял DOM, наблюдатель
 * считал это внешним событием и запускал новый съём, тот снова кликал, и так до
 * блокировки сайта за спам. Решать, что считать изменением, должен вызывающий,
 * потому что только он знает, чьи это мутации.
 */
export function observeDom(onChange: () => void, delay = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ping = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  };

  const mo = new MutationObserver(ping);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  ping();

  return () => { mo.disconnect(); if (timer) clearTimeout(timer); };
}
