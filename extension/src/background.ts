/**
 * Фоновый service worker.
 *
 * Задача одна: открыть панель по клику на иконку. Content script сам этого не может —
 * открытие требует пользовательского жеста и привилегированного контекста.
 *
 * ⚠️ `chrome.sidePanel` есть не везде: это API Chrome 114+, и в Chromium-браузерах
 * вроде Яндекс Браузера его может не оказаться. Поэтому вызовы обёрнуты, а при
 * отсутствии API панель открывается отдельным окном — функциональность та же,
 * просто окно не прилипает к краю.
 *
 * Сети здесь нет намеренно. В MV3 у service worker отсутствует XMLHttpRequest,
 * поэтому когда дело дойдёт до запросов — только голый fetch, а не библиотеки,
 * рассчитывающие на XHR.
 */

const PANEL_URL = 'panel.html';
const hasSidePanel = (): boolean => typeof chrome.sidePanel?.open === 'function';

chrome.runtime.onInstalled.addListener(() =>
{
  if (!hasSidePanel()) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() =>
  {
    /* браузер не поддерживает — откроем окном */
  });
});

async function openPanel(windowId?: number): Promise<void>
{
  if (hasSidePanel() && windowId != null)
  {
    try
    {
      await chrome.sidePanel.open({ windowId });
      return;
    }
    catch
    {
      /* проваливаемся в запасной путь */
    }
  }

  // Запасной путь: своё окно. Если оно уже открыто — просто выводим его вперёд,
  // иначе при каждом клике плодились бы копии.
  const url = chrome.runtime.getURL(PANEL_URL);
  const existing = await chrome.windows.getAll({ populate: true });
  for (const w of existing)
  {
    if (w.tabs?.some((t) => t.url === url) && w.id != null)
    {
      await chrome.windows.update(w.id, { focused: true });
      return;
    }
  }
  await chrome.windows.create({ url, type: 'popup', width: 430, height: 920 });
}

// Срабатывает только когда у action нет default_popup — это наш случай.
chrome.action.onClicked.addListener((tab) =>
{
  void openPanel(tab.windowId);
});

chrome.runtime.onMessage.addListener((msg, sender) =>
{
  if (msg?.type === 'open-panel') void openPanel(sender.tab?.windowId);
});
