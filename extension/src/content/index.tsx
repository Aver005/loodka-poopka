import { createRoot, type Root } from 'react-dom/client';
import type { Match } from '../engine';
import { OVERLAY_CSS } from '../generated/overlay-css';
import { mergeSides } from '../engine';
import { LISTING_CONTAINERS, parseListingHtml } from '../listing';
import { captureMatch, findModal, matchFingerprint, observeDom, signature } from '../lib/modal';
import { initStoreSync, useStore, type ListingCommand } from '../store';
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
 * Снимает список матчей со страницы.
 *
 * Дефект расписания — единственное преимущество, которое пока работает, — существует
 * только в сравнении строк листинга между собой. Из модалки его не видно никогда.
 *
 * Три исправленных здесь дефекта, каждый терял данные молча:
 *
 * 1. **Читался только `#upcoming`.** Блок «ТЕКУЩИЕ МАТЧИ» (`#current_matches_block`)
 *    выпадал целиком, а там лежат матчи на старте — самая срочная часть листинга.
 * 2. **Снимок ЗАМЕНЯЛ собранное.** Достаточно было один раз прочитать DOM в неполном
 *    состоянии (инициализация слайдера, активный поиск по листингу), чтобы полный
 *    сбор превратился в огрызок без всякой возможности починить его из интерфейса.
 * 3. **Отпечаток считался как длина HTML.** Изменение той же длины сбор пропускал,
 *    и «обновить» молча не делало ничего.
 */
let lastListingSig = '';

/** Разметка всех блоков с матчами, склеенная подряд. */
function listingHtml(): string | null
{
  const parts: string[] = [];
  for (const sel of LISTING_CONTAINERS)
  {
    const el = document.querySelector(sel);
    if (el) parts.push(el.innerHTML);
  }
  return parts.length ? parts.join('\n') : null;
}

/** @returns сколько матчей видно сейчас; −1 если блоков с матчами на странице нет. */
function harvestListing(force = false): number
{
  const html = listingHtml();
  if (html == null) return -1;

  const matches = parseListingHtml(html);
  if (!matches.length) return 0;

  // Отпечаток по составу матчей, а не по длине разметки: длина совпадает слишком
  // легко, а набор id — нет.
  const sig = matches.map((m) => m.id).sort().join(',');
  if (!force && sig === lastListingSig) return matches.length;
  lastListingSig = sig;

  useStore.getState().mergeListing(matches);
  return matches.length;
}

/**
 * Правило 4 (то же, что и для съёма линии): пока мы сами листаем страницы,
 * все мутации DOM — наши, и реагировать на них нельзя.
 */
let paginating = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Пролистывает все страницы слайдера и собирает всё, что найдётся.
 *
 * ⚠️ Про запросы к сайту. Клик по точке пагинации — это **локальный** сдвиг Swiper'а:
 * все страницы уже лежат в DOM (на проверенном снимке 4 из 4, 33 матча целиком),
 * так что сеть тут не задействована. Это принципиально: автоматическое переключение
 * вкладок команд в модалке однажды выглядело для сайта как спам и стоило блокировки.
 * Поэтому обход запускается только по кнопке и никогда сам.
 *
 * Ценность кнопки не в том, что без неё чего-то не видно сегодня, а в том, что сбор
 * перестаёт зависеть от того, в каком состоянии слайдер оказался в момент чтения.
 */
async function collectAllPages(): Promise<number>
{
  if (paginating || capturing) return 0;

  const dots = [...document.querySelectorAll<HTMLElement>('#upcoming .navi a.dot[data-page]')];
  const activeIdx = Math.max(0, dots.findIndex((d) => /\bactive\b/.test(d.className)));

  paginating = true;
  const { setListingScan } = useStore.getState();
  try
  {
    // Сначала то, что видно прямо сейчас: если пагинации нет вообще, этим и закончим.
    let found = Math.max(0, harvestListing(true));
    setListingScan({ page: 1, pages: Math.max(1, dots.length), found });

    for (let i = 0; i < dots.length; i++)
    {
      dots[i]!.click();
      // Swiper анимирует переход; читать надо после того, как он доедет.
      await sleep(360);
      found = Math.max(found, Math.max(0, harvestListing(true)));
      setListingScan({ page: i + 1, pages: dots.length, found: useStore.getState().listing.length });
    }

    // Возвращаем страницу как было — пользователь её не переключал, это сделали мы.
    if (dots.length) dots[activeIdx]?.click();
    await sleep(360);

    return useStore.getState().listing.length;
  }
  finally
  {
    setListingScan(null);
    paginating = false;
  }
}

// ── Команды из панели ─────────────────────────────────────────────────────────
let handledCommandAt = 0;

async function runListingCommand(cmd: ListingCommand | null): Promise<void>
{
  if (!cmd || cmd.at <= handledCommandAt) return;
  handledCommandAt = cmd.at;

  const store = useStore.getState();
  try
  {
    if (cmd.action === 'collect-all') await collectAllPages();
    else harvestListing(true);
  }
  finally
  {
    store.ackListing();
  }
}

// ── Наблюдение ────────────────────────────────────────────────────────────────
function onDomChange(): void
{
  // Во время обхода страниц DOM меняем мы сами — и сбор, и съём линии тут молчат.
  if (paginating) return;

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
void Promise.resolve(useStore.persist.rehydrate()).then(() =>
{
  render();
  // Сразу читаем то, что уже на странице. Раньше сбор ждал первой мутации DOM,
  // и на статичной странице листинг мог остаться вчерашним — именно из-за этого
  // хранилище приходилось чистить руками.
  harvestListing(true);
  // Команда могла прилететь до того, как мы догрузились.
  void runListingCommand(useStore.getState().listingCommand);
});

useStore.subscribe((s) => void runListingCommand(s.listingCommand));
observeDom(onDomChange);
