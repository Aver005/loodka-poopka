/**
 * listing.ts — анализ расписания по всему листингу.
 *
 * Зачем это вообще. Единственное преимущество, которое пока работает в эксперименте,
 * — это **дефект расписания**: команда играет второй или третий BO3 за день, а линия
 * считает матч изолированно и держит её фаворитом.
 *
 * Такое свойство физически невозможно увидеть из одного матча: оно существует только
 * в сравнении строк листинга между собой. Отсюда и модуль — он ищет то, чего
 * не видно в модалке.
 *
 * ⚠️ Ключевая поправка, купленная опытом: тезис работает **только на асимметрии**.
 * В круговом турнире (Urban Riga) все играют подряд с интервалом в час — устают
 * одинаково, преимущества нет ни у кого, есть только рост дисперсии.
 */

// ── Типы ──────────────────────────────────────────────────────────────────────
export interface ListingMatch {
  /** Стабильный ключ строки листинга. */
  id: string;
  team1: string;
  team2: string;
  odds1: number | null;
  odds2: number | null;
  tournament: string | null;
  /** BO1 / BO3 / BO5 */
  format: string | null;
  /** Сколько миллисекунд до старта; null — не удалось разобрать. */
  startsInMs: number | null;
  live: boolean;
}

export interface Asymmetry {
  match: ListingMatch;
  /** Команда, которая выходит на матч уставшей. */
  tired: string;
  /** Её соперник — свежий или заметно менее загруженный. */
  fresh: string;
  /** Сколько матчей у уставшей команды до этого в тот же день. */
  priorMatches: number;
  /** Ожидаемый отдых между сериями. Отрицательный — наложение. */
  restMs: number;
  /** Уставшая команда всё ещё фаворит по линии. Главный признак перекоса. */
  tiredIsFavorite: boolean;
  /** Очищенная от маржи вероятность уставшей команды, если кэфы известны. */
  tiredFairP: number | null;
  /** 0..1 — насколько случай интересен. Для сортировки. */
  severity: number;
}

/** Типичная длительность серии. BO3 идёт 2–3.5 часа, берём середину. */
const DURATION_MS: Record<string, number> = {
  BO1: 60 * 60_000,
  BO2: 2 * 60 * 60_000,
  BO3: 2.5 * 60 * 60_000,
  BO5: 4 * 60 * 60_000,
};

const durationOf = (format: string | null): number =>
  DURATION_MS[(format ?? 'BO3').toUpperCase()] ?? DURATION_MS.BO3!;

/** Матчи считаем «того же дня», если они в пределах этого окна. */
const SAME_DAY_MS = 14 * 60 * 60_000;

// ── Загрузка команд ───────────────────────────────────────────────────────────
export interface TeamLoad {
  team: string;
  /** Матчи команды, отсортированные по времени старта. */
  matches: ListingMatch[];
}

export function teamLoads(matches: ListingMatch[]): Map<string, TeamLoad> {
  const byTeam = new Map<string, TeamLoad>();
  for (const m of matches) {
    if (m.startsInMs == null) continue;
    for (const team of [m.team1, m.team2]) {
      const load = byTeam.get(team) ?? { team, matches: [] };
      load.matches.push(m);
      byTeam.set(team, load);
    }
  }
  for (const load of byTeam.values()) {
    load.matches.sort((a, b) => (a.startsInMs ?? 0) - (b.startsInMs ?? 0));
  }
  return byTeam;
}

/** Сколько матчей у команды строго до указанного момента, в пределах суток. */
function priorCount(load: TeamLoad | undefined, beforeMs: number): number {
  if (!load) return 0;
  return load.matches.filter(
    (m) => m.startsInMs != null && m.startsInMs < beforeMs && beforeMs - m.startsInMs < SAME_DAY_MS,
  ).length;
}

/** Ожидаемый отдых: старт следующего минус предполагаемое окончание предыдущего. */
function restBefore(load: TeamLoad | undefined, beforeMs: number): number {
  if (!load) return Infinity;
  const prior = load.matches.filter((m) => m.startsInMs != null && m.startsInMs < beforeMs);
  const last = prior.at(-1);
  if (!last || last.startsInMs == null) return Infinity;
  return beforeMs - (last.startsInMs + durationOf(last.format));
}

// ── Поиск асимметрий ──────────────────────────────────────────────────────────
const imp = (o: number | null): number | null => (o && o > 0 ? 1 / o : null);

/** Очищенная от маржи вероятность первой команды. */
function fairP1(m: ListingMatch): number | null {
  const a = imp(m.odds1);
  const b = imp(m.odds2);
  if (a == null || b == null) return null;
  return a / (a + b);
}

export interface AsymmetryOptions {
  /** Минимальная разница в числе предыдущих матчей, чтобы считать график перекошенным. */
  minLoadGap?: number;
  /** Отдых, выше которого усталость перестаёт считаться существенной. */
  maxRestMs?: number;
}

/**
 * Находит матчи, где одна команда выходит уставшей против заметно более свежей.
 *
 * Симметричные случаи (оба играют по второму разу, круговой турнир) отбрасываются:
 * там нет преимущества ни у кого.
 */
export function findAsymmetries(
  matches: ListingMatch[],
  opts: AsymmetryOptions = {},
): Asymmetry[] {
  const { minLoadGap = 1, maxRestMs = 4 * 60 * 60_000 } = opts;
  const loads = teamLoads(matches);
  const out: Asymmetry[] = [];

  for (const m of matches) {
    if (m.startsInMs == null || m.live) continue;

    const prior1 = priorCount(loads.get(m.team1), m.startsInMs);
    const prior2 = priorCount(loads.get(m.team2), m.startsInMs);
    if (Math.abs(prior1 - prior2) < minLoadGap) continue; // симметрично — пропускаем

    const tiredIsFirst = prior1 > prior2;
    const tired = tiredIsFirst ? m.team1 : m.team2;
    const fresh = tiredIsFirst ? m.team2 : m.team1;
    const priorMatches = Math.max(prior1, prior2);
    const rest = restBefore(loads.get(tired), m.startsInMs);
    if (rest > maxRestMs) continue; // успел отдохнуть — тезиса нет

    const p1 = fairP1(m);
    const tiredFairP = p1 == null ? null : tiredIsFirst ? p1 : 1 - p1;
    const tiredIsFavorite = tiredFairP != null && tiredFairP > 0.5;

    // Чем больше матчей позади, чем меньше отдыха и чем увереннее линия держит
    // уставшую команду фаворитом — тем интереснее случай.
    const loadScore = Math.min(priorMatches / 3, 1);
    const restScore = rest <= 0 ? 1 : Math.max(0, 1 - rest / maxRestMs);
    const priceScore = tiredFairP == null ? 0.3 : Math.max(0, (tiredFairP - 0.5) * 2);
    const severity = Math.min(1, loadScore * 0.35 + restScore * 0.3 + priceScore * 0.35);

    out.push({ match: m, tired, fresh, priorMatches, restMs: rest, tiredIsFavorite, tiredFairP, severity });
  }

  return out.sort((a, b) => b.severity - a.severity);
}

// ── Вывод ─────────────────────────────────────────────────────────────────────
export function formatDuration(ms: number): string {
  if (!isFinite(ms)) return '—';
  const sign = ms < 0 ? '−' : '';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const min = Math.round((abs % 3_600_000) / 60_000);
  return h ? `${sign}${h} ч ${min} мин` : `${sign}${min} мин`;
}

/**
 * Листинг для Claude — БЕЗ коэффициентов.
 *
 * Это не стилистика, а метод. Увидев цену первым, модель подгонит под неё свою
 * оценку вероятности, Edge выйдет около нуля, и найти ошибку рынка станет
 * невозможно по построению. Все оценки за первые два дня эксперимента ушли
 * с пометкой «с якорем» именно потому, что кэфы были видны на скриншотах.
 */
export function buildListingBrief(matches: ListingMatch[]): string {
  const asym = findAsymmetries(matches);
  const L: string[] = [];

  L.push('# Листинг матчей', '');
  L.push('Коэффициенты намеренно не приводятся — оценка вероятности должна быть слепой.', '');

  L.push('## Матчи', '');
  L.push('| Матч | Турнир | Формат | До старта |', '|---|---|:-:|:-:|');
  for (const m of [...matches].sort((a, b) => (a.startsInMs ?? 0) - (b.startsInMs ?? 0))) {
    L.push(`| ${m.team1} vs ${m.team2} | ${m.tournament ?? '?'} | ${m.format ?? '?'} | ` +
           `${m.live ? 'LIVE' : formatDuration(m.startsInMs ?? NaN)} |`);
  }
  L.push('');

  if (asym.length) {
    L.push('## ⚠️ Перекос расписания', '');
    L.push('Команды, выходящие на матч уставшими против более свежего соперника.', '');
    L.push('| Матч | Кто устал | Матчей позади | Отдых |', '|---|---|:-:|:-:|');
    for (const a of asym) {
      L.push(`| ${a.match.team1} vs ${a.match.team2} | **${a.tired}** | ${a.priorMatches} | ` +
             `${formatDuration(a.restMs)} |`);
    }
    L.push('');
    L.push('> Симметричные случаи (круговые турниры, где все играют подряд) сюда не попадают:');
    L.push('> когда график плотный у обоих, преимущества нет ни у кого.');
  }

  return L.join('\n');
}
