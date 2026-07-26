import { createRoot, type Root } from 'react-dom/client';
import type { Match } from '../engine';
import { OVERLAY_CSS } from '../generated/overlay-css';
import {
  captureMatch, findModal, matchFingerprint, observeDom, signature,
} from '../lib/modal';
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

/** Правило 3: вторую сторону снимаем не чаще одного раза на матч. */
const doneBothSides = new Set<string>();

let match: Match | null = null;
let busy = false;

// ── Монтирование ──────────────────────────────────────────────────────────────
function ensureHost(modal: HTMLElement): boolean {
  if (host?.isConnected && modal.contains(host)) return true;

  host?.remove();
  root = null;

  host = document.createElement('div');
  host.id = HOST_ID;
  // Порядок важен: `all:initial` сбрасывает и display, поэтому идёт первым.
  host.style.cssText = 'all:initial;display:block;margin:8px 0;';

  const shadow = host.attachShadow({ mode: 'open' });

  // Стили вшиты в бандл строкой. Раньше они тянулись через fetch и молча
  // не долетали — оверлей рендерился совсем без оформления. Строка не может
  // «не долететь»: ни сети, ни CSP, ни асинхронности.
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.append(style);

  const mount = document.createElement('div');
  shadow.append(mount);

  modal.prepend(host);
  root = createRoot(mount);
  return true;
}

function unmount(): void {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  match = null;
  handledSignature = '';
  clearBadges();
}

function render(): void {
  if (!root || !match) return;
  const { settings } = useStore.getState();
  const fp = matchFingerprint(match);
  root.render(
    <Overlay
      match={match}
      busy={busy}
      bothSidesAvailable={!doneBothSides.has(fp)}
      onRefresh={() => void capture(false)}
      onBothSides={() => void capture(true)}
      unit={settings.unit}
    />,
  );
}

// ── Съём линии ────────────────────────────────────────────────────────────────
async function capture(bothSides: boolean): Promise<void> {
  if (capturing) return;

  const modal = findModal();
  if (!modal) { unmount(); return; }
  if (!ensureHost(modal)) return;

  capturing = true;
  busy = true;
  render();

  try {
    const fresh = await captureMatch(bothSides);
    if (fresh) {
      match = fresh;
      if (bothSides) doneBothSides.add(matchFingerprint(fresh));
      useStore.getState().setCurrent(fresh);

      const m = findModal();
      if (m && useStore.getState().settings.showBadges) {
        paintBadges(m, fresh, useStore.getState().settings.edgeFloor);
      } else {
        clearBadges();
      }
    }
  } catch (e) {
    console.warn('[LP] не удалось снять линию:', e);
  } finally {
    busy = false;
    render();
    // Даём сайту дорисовать после наших кликов и только потом принимаем
    // текущее состояние за исходное. Без паузы восстановление вкладки
    // тут же прилетело бы обратно как «внешнее изменение».
    setTimeout(() => {
      handledSignature = signature();
      capturing = false;
    }, 900);
  }
}

// ── Наблюдение ────────────────────────────────────────────────────────────────
function onDomChange(): void {
  if (capturing) return;

  const sig = signature();
  if (!sig) { if (host) unmount(); return; }
  if (sig === handledSignature) return;

  handledSignature = sig;
  // Автоматически снимаем ТОЛЬКО одну сторону: переключение вкладок — это
  // запросы к сайту, и делать их без спроса на каждое движение кэфов нельзя.
  void capture(false);
}

initStoreSync();
void Promise.resolve(useStore.persist.rehydrate()).then(render);
observeDom(onDomChange);
