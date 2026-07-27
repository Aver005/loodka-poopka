import { createRoot, type Root } from 'react-dom/client';
import type { Match } from '../engine';
import { OVERLAY_CSS } from '../generated/overlay-css';
import { mergeSides } from '../engine';
import { parseListingHtml } from '../listing';
import { captureMatch, findModal, matchFingerprint, observeDom, signature } from '../lib/modal';
import { initStoreSync, useStore } from '../store';
import { clearBadges, paintBadges } from './badges';
import { Overlay } from './Overlay';

const HOST_ID = 'lp-overlay-host';

/**
 * Управление оверлеем.
 *
 * Состояние держится в модуле, а не в React: единственный наблюдатель за DOM
 * должен уметь отличать чужие мутации от наших собственных, а хук об этом не знает.
 *
 * История вопроса: сначала наблюдателей было два (один монтировал, второй считал),
 * и оба реагировали на клик по вкладке команды, который делали мы сами. Получилась
 * петля «клик → мутация → съём → клик», сайт увидел спам запросами и заблокировал.
 * Отсюда три правила ниже.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Правило 1: пока идёт съём, любые мутации — наши, и реагировать на них нельзя. */
let capturing = false;

/** Правило 2: обрабатываем только отпечаток, который ещё не обрабатывали. */
let handledSignature = '';

/**
 * Правило 3: вторая сторона снимается ТОЛЬКО вручную — это переключение вкладки,
 * то есть запрос к сайту. Но однажды снятая, она запоминается и подмешивается
 * во все последующие обновления: иначе «Обновить» молча откатывал бы разбор
 * к одной стороне и терял то, что пользователь только что собрал.
 */
const secondSides = new Map<string, { match: Match; at: number }>();

let match: Match | null = null;
let busy = false;

// ── Позиционирование ──────────────────────────────────────────────────────────
const PANEL_WIDTH = 330;
const GAP = 12;

/**
 * Панель крепится сбоку от модалки и живёт в `position: fixed`.
 *
 * Раньше блок вставлялся внутрь модалки сверху — и выталкивал её содержимое вниз,
 * из-за чего модалка прыгала при каждом пересчёте. Фиксированное позиционирование
 * выводит панель из потока: на вёрстку сайта она больше не влияет вообще.
 */
function positionHost(modal: HTMLElement, el: HTMLElement): void
{
  const r = modal.getBoundingClientRect();
  const spaceRight = window.innerWidth - r.right;
  // Справа, если влезает; иначе слева; если и там тесно — прижимаем к краю окна.
  const left =
    spaceRight >= PANEL_WIDTH + GAP
      ? r.right + GAP
      : r.left - PANEL_WIDTH - GAP >= GAP
        ? r.left - PANEL_WIDTH - GAP
        : Math.max(GAP, window.innerWidth - PANEL_WIDTH - GAP);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(GAP, Math.min(r.top, window.innerHeight - 120)))}px`;
  el.style.maxHeight = `${Math.round(window.innerHeight - 2 * GAP)}px`;
}

let followTimer: ReturnType<typeof setInterval> | null = null;

function startFollowing(): void
{
  stopFollowing();
  const tick = () =>
  {
    const m = findModal();
    if (m && host) positionHost(m, host);
  };
  // Сайт двигает модалку инлайновыми стилями, ловить это событиями ненадёжно.
  // Один getBoundingClientRect раз в 300 мс дешевле, чем попытки угадать все триггеры.
  followTimer = setInterval(tick, 300);
  addEventListener('scroll', tick, { passive: true, capture: true });
  addEventListener('resize', tick, { passive: true });
}

function stopFollowing(): void
{
  if (followTimer)
  {
    clearInterval(followTimer);
    followTimer = null;
  }
}

// ── Монтирование ──────────────────────────────────────────────────────────────
function ensureHost(modal: HTMLElement): boolean
{
  if (host?.isConnected)
  {
    positionHost(modal, host);
    return true;
  }

  host?.remove();
  root = null;

  host = document.createElement('div');
  host.id = HOST_ID;
  // Порядок важен: `all:initial` сбрасывает в том числе position и display.
  host.style.cssText =
    'all:initial;position:fixed;z-index:2147483000;display:block;' +
    `width:${PANEL_WIDTH}px;pointer-events:auto;`;

  const shadow = host.attachShadow({ mode: 'open' });

  // Стили вшиты в бандл строкой. Раньше они тянулись через fetch и молча
  // не долетали — оверлей рендерился совсем без оформления. Строка не может
  // «не долететь»: ни сети, ни CSP, ни асинхронности.
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.append(style);

  const mount = document.createElement('div');
  shadow.append(mount);

  // В body, а не внутрь модалки: так вставка не влияет на её вёрстку.
  document.body.append(host);
  positionHost(modal, host);
  startFollowing();

  root = createRoot(mount);
  return true;
}

function unmount(): void
{
  stopFollowing();
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  match = null;
  handledSignature = '';
  clearBadges();
}

function render(): void
{
  if (!root || !match) return;
  const { settings } = useStore.getState();
  const stored = secondSides.get(matchFingerprint(match));
  root.render(
    <Overlay
      match={match}
      busy={busy}
      secondSideAgeMs={stored ? Date.now() - stored.at : null}
      onRefresh={() => void capture(false)}
      onBothSides={() => void capture(true)}
      unit={settings.unit}
    />,
  );
}

// ── Съём линии ────────────────────────────────────────────────────────────────
async function capture(bothSides: boolean): Promise<void>
{
  if (capturing) return;

  const modal = findModal();
  if (!modal)
  {
    unmount();
    return;
  }
  if (!ensureHost(modal)) return;

  capturing = true;
  busy = true;
  render();

  try
  {
    const fresh = await captureMatch(bothSides);
    if (fresh)
    {
      const fp = matchFingerprint(fresh);

      if ((fresh.sides ?? 1) >= 2)
      {
        // Свежий полный снимок — запоминаем его как источник второй стороны.
        secondSides.set(fp, { match: fresh, at: Date.now() });
        match = fresh;
      }
      else
      {
        // Обычное обновление одной стороны. Если вторая уже снималась —
        // подмешиваем её. Свежие кэфы выигрывают: mergeSides не перетирает
        // офферы, уже присутствующие в первом аргументе.
        const stored = secondSides.get(fp);
        match = stored ? mergeSides(fresh, stored.match) : fresh;
      }

      useStore.getState().setCurrent(match);

      const m = findModal();
      if (m && useStore.getState().settings.showBadges)
      {
        paintBadges(m, match, useStore.getState().settings.edgeFloor);
      }
      else
      {
        clearBadges();
      }
    }
  }
  catch (e)
  {
    console.warn('[LP] не удалось снять линию:', e);
  }
  finally
  {
    busy = false;
    render();
    // Даём сайту дорисовать после наших кликов и только потом принимаем
    // текущее состояние за исходное. Без паузы восстановление вкладки
    // тут же прилетело бы обратно как «внешнее изменение».
    setTimeout(() =>
    {
      handledSignature = signature();
      capturing = false;
    }, 900);
  }
}

// ── Сбор листинга ─────────────────────────────────────────────────────────────
/**
 * Снимает весь список матчей со страницы.
 *
 * Дефект расписания — единственное преимущество, которое пока работает, — существует
 * только в сравнении строк листинга между собой. Из модалки его не видно никогда.
 *
 * Слайдер держит **все страницы в DOM сразу**, поэтому листать ничего не надо:
 * один проход читает всё, и дополнительных запросов к сайту не возникает вообще.
 */
let lastListingSig = '';

function harvestListing(): void
{
  const root = document.querySelector('#upcoming');
  if (!root) return;

  const html = root.innerHTML;
  const sig = `${html.length}`;
  if (sig === lastListingSig) return; // ничего не поменялось
  lastListingSig = sig;

  const matches = parseListingHtml(html);
  if (matches.length) useStore.getState().setListing(matches);
}

// ── Наблюдение ────────────────────────────────────────────────────────────────
function onDomChange(): void
{
  harvestListing();
  if (capturing) return;

  const sig = signature();
  if (!sig)
  {
    if (host) unmount();
    return;
  }
  if (sig === handledSignature) return;

  handledSignature = sig;
  // Автоматически снимаем ТОЛЬКО одну сторону: переключение вкладок — это
  // запросы к сайту, и делать их без спроса на каждое движение кэфов нельзя.
  void capture(false);
}

initStoreSync();
void Promise.resolve(useStore.persist.rehydrate()).then(render);
observeDom(onDomChange);
