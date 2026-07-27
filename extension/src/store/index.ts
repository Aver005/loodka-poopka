import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { chromeStorage, syncAcrossContexts } from '../lib/chrome-storage';
import { DEFAULT_UNIT, EDGE_FLOOR, type Match } from '../engine';
import type { ListingMatch } from '../listing';

const KEY = 'lp-store';

export interface Settings
{
  /** Банк в рублях. */
  bank: number;
  /** 1u в рублях. По умолчанию 5% банка — умеренно-агрессивный профиль. */
  unit: number;
  /** Порог входа по Edge. */
  edgeFloor: number;
  /** Показывать ли бейджи прямо у коэффициентов. */
  showBadges: boolean;
  /** Автоматически собирать вкладку второй команды. */
  autoBothSides: boolean;
}

export interface StoreState
{
  settings: Settings;
  /** Последний разобранный матч. Мост между оверлеем и панелью. */
  current: Match | null;
  /** Когда разобран — чтобы панель понимала, свежие ли данные. */
  capturedAt: number | null;
  /** Моя оценка вероятности по ключу оффера: `${match}|${type}` -> 0..1 */
  estimates: Record<string, number>;

  /** Весь листинг матчей. Нужен для анализа расписания — из одного матча его не видно. */
  listing: ListingMatch[];
  listingAt: number | null;

  setSettings: (patch: Partial<Settings>) => void;
  setCurrent: (match: Match | null) => void;
  setEstimate: (key: string, p: number | null) => void;
  clearEstimates: () => void;
  setListing: (matches: ListingMatch[]) => void;
}

const DEFAULT_SETTINGS: Settings =
{
  bank: 5000,
  unit: DEFAULT_UNIT,
  edgeFloor: EDGE_FLOOR,
  showBadges: true,
  // Выключено намеренно. Переключение вкладок — это запросы к сайту, и делать их
  // автоматически на каждое движение линии оказалось прямым путём к блокировке
  // за спам. Теперь вторая сторона снимается только по кнопке и раз на матч.
  autoBothSides: false,
};

export const useStore = create<StoreState>()(
  persist(
    (set) => (
    {
      settings: DEFAULT_SETTINGS,
      current: null,
      capturedAt: null,
      estimates: {},
      listing: [],
      listingAt: null,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setCurrent: (match) => set({ current: match, capturedAt: match ? Date.now() : null }),
      setEstimate: (key, p) =>
        set((s) =>
        {
          const next = { ...s.estimates };
          if (p == null || !isFinite(p)) delete next[key];
          else next[key] = Math.min(Math.max(p, 0), 1);
          return { estimates: next };
        }),
      clearEstimates: () => set({ estimates: {} }),
      setListing: (matches) => set({ listing: matches, listingAt: Date.now() }),
    }),
    {
      name: KEY,
      storage: createJSONStorage(() => chromeStorage),
      // Оценки не переживают перезагрузку намеренно: они относятся к конкретной
      // линии в конкретный момент, а кэфы к следующему разу уже уедут.
      partialize: (s) => ({
        settings: s.settings,
        current: s.current,
        capturedAt: s.capturedAt,
        listing: s.listing,
        listingAt: s.listingAt,
      }),
    },
  ),
);

/** Подписать этот контекст на изменения из других. Вызывать один раз при старте. */
export function initStoreSync(): () => void
{
  return syncAcrossContexts(KEY, () =>
  {
    void useStore.persist.rehydrate();
  });
}

/** Стабильный ключ оценки: матч + рынок. */
export const estimateKey = (match: Match | null, offerType: string): string =>
  `${match?.tournament ?? '?'}|${Object.values(match?.teams ?? {})
    .map((t) => t.name)
    .join('-')}|${offerType}`;

