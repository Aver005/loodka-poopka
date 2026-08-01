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
  /** Стабильный ключ строки листинга — `data-id` матча на сайте. */
  id: string;
  team1: string;
  team2: string;
  /** `data-raw_id` команд: переживает переименования вроде «RUSTEC» → «ex-RUSTEC». */
  teamId1: string | null;
  teamId2: string | null;
  odds1: number | null;
  odds2: number | null;
  /**
   * Доля ставок публики на каждую команду, в процентах.
   * Сайт показывает её сам — и это прямое измерение «народной команды»,
   * которое у меня до сих пор было только качественным признаком в фильтрах.
   */
  publicPct1: number | null;
  publicPct2: number | null;
  tournament: string | null;
  /** BO1 / BO3 / BO5 */
  format: string | null;
  /**
   * Сколько миллисекунд до старта; null — не удалось разобрать.
   *
   * ⚠️ **Отрицательное значение — матч уже идёт**, и это минус прошедшее время.
   * См. `running`: у идущих матчей сайт считает таймер ВВЕРХ.
   */
  startsInMs: number | null;
  /**
   * Матч идёт прямо сейчас, `startsInMs` = −(сколько уже играют).
   *
   * 🐛 Живой баг 01.08, стоивший фантомного кандидата. Блок «ТЕКУЩИЕ МАТЧИ» показывает
   * не обратный отсчёт, а **прошедшее** время в том же формате `HH:MM:SS`.
   * Sinners vs INOX шёл третий час — и попал в бриф как «через 2 ч 51 мин», то есть
   * с точностью до знака. Хуже того, асимметрия из-за этого **перевернулась**:
   * детектор счёл уставшей INOX в матче, который на самом деле уже закончился,
   * и не увидел усталости в следующем.
   *
   * Различать по классу таймера нельзя: `timer_active` стоит и на предстоящих.
   * Признак блока текущих матчей — класс карточки `full_width_event`.
   */
  running: boolean;
  /** Абсолютное время старта, как его отдаёт сайт. */
  startsAt: string | null;
  /**
   * У матча **доступны** live-ставки — красная точка в интерфейсе.
   *
   * ⚠️ Это НЕ «матч идёт». Блок `#upcoming` по определению содержит только
   * предстоящие матчи. Я один раз перепутал и отфильтровал по этому флагу —
   * из анализа молча выпали главные случаи дня.
   */
  liveBetting: boolean;
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

// ── Разбор листинга ───────────────────────────────────────────────────────────
const stripTags = (s = ''): string => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Контейнеры, в которых сайт держит матчи.
 *
 * ⚠️ Их ДВА, и это было источником молчаливой потери данных. Сбор читал только
 * `#upcoming` и терял блок «ТЕКУЩИЕ МАТЧИ» — а там лежат матчи на старте,
 * то есть самая срочная часть листинга. На живом снимке это два матча,
 * один со стартом через 43 минуты.
 *
 * Порядок важен: текущие идут первыми, как и на странице.
 */
export const LISTING_CONTAINERS = ['#current_matches_block', '#upcoming'] as const;

/**
 * Таймер сайта: `00:55:43`, `1д 00:45:15` либо текст «Скоро начнется».
 *
 * Текстовый вариант раньше давал `null`, и это было хуже, чем кажется: матч с `null`
 * не попадал в подсчёт нагрузки команд (`teamLoads` их отбрасывает), то есть переставал
 * создавать усталость сопернику. Возвращаем 0 — «уже начинается»: ставить туда нечего,
 * но как предыдущая игра команды он теперь учитывается.
 */
export function parseCountdown(text: string): number | null {
  const m = /(?:(\d+)\s*д\s*)?(\d{1,2}):(\d{2}):(\d{2})/.exec(text);
  if (m) {
    const [, d, hh, mm, ss] = m;
    return ((Number(d ?? 0) * 24 + Number(hh)) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
  }
  return /скоро|начина/i.test(text) ? 0 : null;
}

/**
 * Порядок по времени старта. Матчи с нечитаемым таймером — в КОНЕЦ.
 *
 * Наивное `(a.startsInMs ?? 0) - (b.startsInMs ?? 0)` ставило их в самое начало,
 * впереди матча, до которого 40 минут. Именно от этого листинг выглядел
 * «не в том порядке».
 */
export function byStart(a: ListingMatch, b: ListingMatch): number {
  if (a.startsInMs == null) return b.startsInMs == null ? 0 : 1;
  if (b.startsInMs == null) return -1;
  return a.startsInMs - b.startsInMs;
}

export const sortByStart = (matches: ListingMatch[]): ListingMatch[] => [...matches].sort(byStart);

/**
 * Сливает новый снимок с уже собранным, по `data-id`.
 *
 * Зачем не просто заменять. Слайдер отдаёт то, что сейчас в DOM, и снимок легко
 * бывает неполным — во время инициализации, при активном поиске по листингу или
 * когда открыта другая страница пагинации. Замена в этот момент **уничтожала**
 * полный сбор и оставляла огрызок, который нечем было починить, кроме ручной
 * чистки хранилища.
 *
 * Свежие данные выигрывают (кэфы и таймеры двигаются), но полнота не теряется.
 */
export function mergeListings(prev: ListingMatch[], next: ListingMatch[]): ListingMatch[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of next) byId.set(m.id, m);
  return sortByStart([...byId.values()]);
}

/**
 * Разбирает разметку листинга — любое число блоков, склеенных подряд.
 *
 * Слайдер держит все свои страницы в DOM сразу (проверено на снимке: 4 страницы,
 * 33 матча, все размечены полностью), поэтому листать для полноты не обязательно
 * и лишних запросов к сайту сбор не делает.
 *
 * Завершённые матчи (`finished_event`) сюда намеренно не попадают: сплит идёт
 * по `<div class="event `, а у них класс начинается с `finished_event`.
 * Ставить туда нечего — но см. задачу про чтение их счёта, оно нужно, чтобы
 * знать РЕАЛЬНУЮ длительность предыдущей серии команды.
 */
export function parseListingHtml(html: string): ListingMatch[] {
  const out: ListingMatch[] = [];

  // Режем по началу карточки матча: вложенных `.event` внутри не бывает.
  for (const block of html.split(/<div class="event\s/).slice(1)) {
    const cls = /^([^"]*)"/.exec(block)?.[1] ?? '';
    const id = /data-id="(\d+)"/.exec(block)?.[1];
    if (!id) continue;

    const sides: { raw: string; teamId: string | null; inner: string }[] = [];
    const sideRe = /<a[^>]*data-raw_id="(\d+)"[^>]*class="(left|right)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    for (let m: RegExpExecArray | null; (m = sideRe.exec(block)); ) {
      sides.push({ raw: m[2]!, teamId: m[1] ?? null, inner: m[3] ?? '' });
    }
    const left = sides.find((s) => s.raw === 'left');
    const right = sides.find((s) => s.raw === 'right');
    if (!left || !right) continue;

    const nameOf = (inner: string) => stripTags(/<span class="team_name">([\s\S]*?)<\/span>/.exec(inner)?.[1] ?? '');
    const oddsOf = (inner: string) => {
      const v = /<span class="sum[^"]*">\s*([\d.]+)\s*<\/span>/.exec(inner)?.[1];
      return v ? parseFloat(v) : null;
    };
    const pctOf = (inner: string) => {
      const v = /<span class="percent_sum">\s*(\d+)/.exec(inner)?.[1];
      return v ? Number(v) : null;
    };

    const center = /<div class="center">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    const timerTag = /<span class="timer[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(center)?.[0] ?? '';

    // Блок «ТЕКУЩИЕ МАТЧИ» размечает карточки во всю ширину, и только он.
    // В нём таймер считает ВВЕРХ: `02:51:07` значит «играют 2 ч 51 мин», а не
    // «начнётся через». Пре-стартовые строки этого блока показывают «Скоро начнется»,
    // то есть ноль, — будущего времени тут не бывает по определению.
    const timerMs = parseCountdown(stripTags(timerTag));
    const running = /\bfull_width_event\b/.test(cls) && timerMs != null && timerMs > 0;

    out.push({
      id,
      team1: nameOf(left.inner),
      team2: nameOf(right.inner),
      teamId1: left.teamId,
      teamId2: right.teamId,
      odds1: oddsOf(left.inner),
      odds2: oddsOf(right.inner),
      publicPct1: pctOf(left.inner),
      publicPct2: pctOf(right.inner),
      tournament: stripTags(/<span class="event_name">([\s\S]*?)<\/span>/.exec(center)?.[1] ?? '') || null,
      format: stripTags(/<span class="event_type">([\s\S]*?)<\/span>/.exec(center)?.[1] ?? '') || null,
      startsInMs: running ? -timerMs! : timerMs,
      running,
      startsAt: /data-start="([^"]*)"/.exec(timerTag)?.[1] ?? null,
      liveBetting: /\blive_betting_upcoming\b/.test(cls),
    });
  }

  return out;
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

/**
 * Таймер досчитал до нуля — матч уже начался или закончился.
 *
 * Сайт держит такие строки в блоке предстоящих, пока не уберёт их сам, и отличить
 * «стартует прямо сейчас» от «шёл три часа назад» по обратному отсчёту нельзя.
 * Для анализа расписания это одно и то же: ставить туда уже нечего.
 */
export const hasStarted = (m: ListingMatch): boolean =>
  m.startsInMs == null || m.startsInMs < 60_000;

/** Только те матчи, на которые ещё можно поставить. */
export const upcomingOnly = (matches: ListingMatch[]): ListingMatch[] =>
  matches.filter((m) => !hasStarted(m));

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

/**
 * Ожидаемый отдых: старт следующего минус предполагаемое окончание предыдущего.
 *
 * Для **идущего** матча окончание не может быть в прошлом: мы своими глазами видим,
 * что он ещё не закончился, поэтому нижняя граница — «сейчас» (0). Средняя длительность
 * тут перестаёт быть догадкой ровно в той части, которую видно
 * ([дырка 4](../../FATIGUE.md#4-отдых--это-прогноз-а-не-факт)): серия, идущая третий час,
 * даёт отдых по факту, а не по табличным 2 ч 30 м.
 */
function restBefore(load: TeamLoad | undefined, beforeMs: number): number {
  if (!load) return Infinity;
  const prior = load.matches.filter((m) => m.startsInMs != null && m.startsInMs < beforeMs);
  const last = prior.at(-1);
  if (!last || last.startsInMs == null) return Infinity;
  const expectedEnd = last.startsInMs + durationOf(last.format);
  return beforeMs - (last.running ? Math.max(expectedEnd, 0) : expectedEnd);
}

// ── Поиск асимметрий ──────────────────────────────────────────────────────────
const imp = (o: number | null): number | null => (o && o > 0 ? 1 / o : null);

/** Очищенная от маржи вероятность первой команды. */
export function fairP1(m: ListingMatch): number | null {
  const a = imp(m.odds1);
  const b = imp(m.odds2);
  if (a == null || b == null) return null;
  return a / (a + b);
}

/**
 * Насколько публика расходится с линией, в процентных пунктах.
 * Положительное значение — публика грузит первую команду сильнее, чем даёт линия.
 *
 * Что это вообще такое. Сайт показывает долю ставок на каждую команду, и это
 * **не пересчитанный кэф**: честная вероятность алгебраически равна `o2/(o1+o2)`,
 * так что при выводе из цены отклонение было бы нулевым везде. На живом листинге
 * из 43 матчей оно доходит до 7.5 п.п., а в среднем составляет 1.85 п.п.
 *
 * В отклонениях виден систематический перекос: публика **перегружает тяжёлых
 * фаворитов** сверх их честной вероятности на 3–4 п.п. Это классическое смещение
 * «фаворит–аутсайдер», и оно превращает качественный признак «народная команда»
 * из моих фильтров в измеримую величину.
 */
export function publicBias(m: ListingMatch): number | null {
  const fair = fairP1(m);
  if (fair == null || m.publicPct1 == null) return null;
  return m.publicPct1 - fair * 100;
}

export interface AsymmetryOptions {
  /** Разница в числе матчей, достаточная сама по себе даже если оба уже играли. */
  bigLoadGap?: number;
  /** Отдых, выше которого усталость перестаёт считаться существенной. */
  maxRestMs?: number;
}

/**
 * Находит матчи, где одна команда выходит уставшей против заметно более свежей.
 *
 * Тезис работает **только на асимметрии**. Поэтому случай засчитывается, если либо
 * соперник совсем свежий, либо разрыв в загрузке большой.
 *
 * ⚠️ Почему одной разницы в один матч мало. В круговом турнире (Urban Riga) команды
 * играют друг с другом подряд, и у одной легко оказывается на матч больше, чем у другой.
 * Но там перемалывает всех, и лишняя игра не даёт сопернику свежести — она даёт
 * только рост дисперсии. Первая версия отмечала такое как перекос, и это было неверно.
 */
export function findAsymmetries(
  matches: ListingMatch[],
  opts: AsymmetryOptions = {},
): Asymmetry[] {
  const { bigLoadGap = 2, maxRestMs = 4 * 60 * 60_000 } = opts;
  const loads = teamLoads(matches);
  const out: Asymmetry[] = [];

  for (const m of matches) {
    // Начавшиеся матчи пропускаем: ставить туда нечего, а в подсчёт нагрузки
    // соперников они при этом входят — именно они и создают усталость.
    if (hasStarted(m)) continue;
    const startsAt = m.startsInMs!; // hasStarted уже отсеял null

    const prior1 = priorCount(loads.get(m.team1), startsAt);
    const prior2 = priorCount(loads.get(m.team2), startsAt);
    const gap = Math.abs(prior1 - prior2);
    const freshIsRested = Math.min(prior1, prior2) === 0;

    // Настоящая асимметрия: либо соперник вообще не играл, либо разрыв большой.
    if (gap === 0) continue;
    if (!freshIsRested && gap < bigLoadGap) continue;

    const tiredIsFirst = prior1 > prior2;
    const tired = tiredIsFirst ? m.team1 : m.team2;
    const fresh = tiredIsFirst ? m.team2 : m.team1;
    const priorMatches = Math.max(prior1, prior2);
    const rest = restBefore(loads.get(tired), startsAt);
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
  // Округляем МИНУТЫ ЦЕЛИКОМ, а потом делим на часы.
  // Раньше часы брались через floor, а минуты округлялись отдельно — и остаток
  // в 59.7 минуты давал «2 ч 60 мин» вместо «3 ч 0 мин».
  const totalMin = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
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
  for (const m of sortByStart(matches)) {
    // Идущий матч обязан выглядеть идущим. Один раз он попал сюда как «через 2 ч 51 мин»
    // (знак таймера), я запросил по нему линию, и в брифе появился кандидат,
    // которого не существовало. Отрицательный отсчёт в этой колонке — тоже плохо:
    // читается как наложение, а не как «уже играют».
    const when = m.running
      ? `идёт ${formatDuration(Math.abs(m.startsInMs ?? NaN))}`
      : formatDuration(m.startsInMs ?? NaN);
    L.push(`| ${m.team1} vs ${m.team2} | ${m.tournament ?? '?'} | ${m.format ?? '?'} | ${when} |`);
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



