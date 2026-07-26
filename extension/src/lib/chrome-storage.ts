import type { StateStorage } from 'zustand/middleware';

/**
 * Адаптер chrome.storage.local для zustand/persist.
 *
 * Почему не localStorage: content script и боковая панель живут в РАЗНЫХ JS-реальностях
 * и localStorage у них разный. chrome.storage общий для всех контекстов расширения —
 * это и делает возможным мост «оверлей посчитал → панель показала».
 *
 * API асинхронный, persist это поддерживает штатно.
 */
export const chromeStorage: StateStorage =
{
  getItem: async (name) =>
  {
    const bag = await chrome.storage.local.get(name);
    return (bag[name] as string | undefined) ?? null;
  },
  setItem: async (name, value) =>
  {
    lastWritten.set(name, value);
    await chrome.storage.local.set({ [name]: value });
  },
  removeItem: async (name) =>
  {
    lastWritten.delete(name);
    await chrome.storage.local.remove(name);
  },
};

/**
 * Что записал ИМЕННО ЭТОТ контекст. Без этого подписка ниже ловила бы собственную
 * запись, дёргала регидратацию и устраивала бесконечный цикл.
 */
const lastWritten = new Map<string, string>();

/**
 * Синхронизация сторов между контекстами.
 *
 * У каждого контекста свой экземпляр стора. Без этой подписки они разъедутся:
 * поменял юнит в панели — оверлей продолжит считать по-старому.
 */
export function syncAcrossContexts(key: string, rehydrate: () => void): () => void
{
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) =>
  {
    if (area !== 'local') return;
    const change = changes[key];
    if (!change) return;
    const next = change.newValue as string | undefined;
    if (next != null && lastWritten.get(key) === next) return; // это наша же запись
    rehydrate();
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
