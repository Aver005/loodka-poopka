import { useMemo, useState } from 'react';
import {
  analyze, nameOf, oddsFmt, pct, requiredP, TIER, TIER_MARK,
  type Match, type Offer, type TeamSlot,
} from '../engine';
import { buildBrief } from '../lib/brief';
import { useStore } from '../store';

interface Props {
  match: Match;
  busy: boolean;
  /** Сколько миллисекунд назад снималась вторая сторона; null — ни разу. */
  secondSideAgeMs: number | null;
  unit: number;
  onRefresh: () => void;
  onBothSides: () => void;
}

/**
 * Панель расчёта сбоку от модалки.
 *
 * Компонентов из библиотеки здесь нет намеренно: ни выпадающих списков, ни диалогов,
 * ни тултипов. Всё богатое — в боковой панели браузера, где свой документ и нет
 * чужого CSS. Здесь только то, что читается взглядом, не отрываясь от ставок.
 */
export function Overlay({ match, busy, secondSideAgeMs, onRefresh, onBothSides }: Props) {
  const edgeFloor = useStore((s) => s.settings.edgeFloor);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const { shape, books, cheapest, divergence } = useMemo(() => analyze(match), [match]);

  const A = (match.active ?? '1') as TeamSlot;
  const B: TeamSlot = A === '1' ? '2' : '1';
  const oneSided = (match.sides ?? 1) < 2;
  const staleMin = secondSideAgeMs != null ? Math.floor(secondSideAgeMs / 60_000) : null;
  const secondSideStale = staleMin != null && staleMin >= 5;

  const copyBrief = () => {
    void navigator.clipboard.writeText(buildBrief(match, edgeFloor));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  // Мусорные рынки в таблицу не пускаем: считать порог для чёт/нечёта бессмысленно.
  const priority: Offer[] = match.offers
    .filter((o) => TIER[o.market].tier !== 'C')
    .sort((a, b) => TIER[a.market].order - TIER[b.market].order);

  return (
    // Высота задаётся явно, а не через inherit: внутри Shadow DOM наследование
    // от хоста с auto-высотой не сработает, и внутренняя прокрутка сломается.
    <div className="flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-xl border border-border bg-card font-sans text-foreground shadow-2xl">
      {/* ── Шапка ── */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-background/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold leading-tight">
            {nameOf(match, '1')} <span className="text-muted-foreground">vs</span> {nameOf(match, '2')}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {match.tournament ?? '?'} · {match.format ?? '?'}
            {match.timer && ` · ${match.timer}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Развернуть' : 'Свернуть'}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </header>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* ── Шансы ── */}
          <Section>
            {shape ? (
              <>
                <div className="flex items-stretch gap-2">
                  <Side name={nameOf(match, A)} value={pct(shape.pA)} lead={shape.pA >= shape.pB} />
                  <Side name={nameOf(match, B)} value={pct(shape.pB)} lead={shape.pB > shape.pA} />
                </div>
                <div className="mt-2 flex justify-between text-[11px]">
                  <span className="text-muted-foreground">три карты</span>
                  <span className="font-medium tabular-nums">{pct(shape.p3maps)}</span>
                </div>

                {shape.fair && (
                  <table className="mt-2 w-full text-[11px]">
                    <tbody>
                      <GridRow label={`${nameOf(match, A)} 2:0`} value={pct(shape.fair.a20)} />
                      <GridRow label={`${nameOf(match, A)} 2:1`} value={pct(shape.fair.a21)} />
                      <GridRow label={`${nameOf(match, B)} 2:1`} value={pct(shape.fair.b21)} />
                      <GridRow label={`${nameOf(match, B)} 2:0`} value={pct(shape.fair.b20)} />
                    </tbody>
                  </table>
                )}
              </>
            ) : (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Сетку исходов не построить: нужны кэфы <b className="text-foreground">обеих</b> команд
                на исход серии, а снята одна вкладка.
                {' '}Нажми <b className="text-foreground">«Обе стороны»</b> внизу.
              </p>
            )}
          </Section>

          {/* ── Пороги входа ── */}
          {priority.length > 0 && (
            <Section title="Порог входа" hint={`Edge ≥ ${(edgeFloor * 100).toFixed(0)}%`}>
              <table className="w-full text-[11px]">
                <tbody>
                  {priority.map((o) => {
                    const need = requiredP(o.odds, edgeFloor);
                    return (
                      <tr key={o.type} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-2 leading-tight">
                          <span className="mr-1">{TIER_MARK[TIER[o.market].tier]}</span>
                          {o.text || o.type}
                          {o.team && <span className="text-muted-foreground"> · {nameOf(match, o.team)}</span>}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                          {oddsFmt(o.odds)}
                        </td>
                        <td className="py-1 text-right font-semibold tabular-nums text-primary">
                          {need > 1 ? '∅' : `≥${pct(need, 0)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                Цифра справа — какой должна быть <b>твоя</b> оценка вероятности, чтобы ставка окупалась.
              </p>
            </Section>
          )}

          {/* ── Маржа ── */}
          {books.length > 0 && (
            <Section title="Маржа по книгам">
              <table className="w-full text-[11px]">
                <tbody>
                  {[...books].sort((a, b) => a.margin - b.margin).map((b) => (
                    <tr key={b.label} className="border-b border-border/40 last:border-0">
                      <td className="py-1 pr-2 leading-tight">{b.label}</td>
                      <td className="py-1 text-right tabular-nums">
                        {b.suspicious ? (
                          <span className="text-bad" title="Маржа вне правдоподобного диапазона — в книгу попали кэфы разных рынков. Не доверять.">
                            🚨 {pct(b.margin)}
                          </span>
                        ) : (
                          <span className={b.margin > 0.095 ? 'text-bad' : b.margin > 0.088 ? 'text-warn' : 'text-good'}>
                            {pct(b.margin)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cheapest && (
                <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                  Дешевле всего — <span className="text-foreground">{cheapest.label}</span>.
                  Выбор рынка важнее выбора команды.
                </p>
              )}
            </Section>
          )}

          {/* ── Предупреждения ── */}
          <Section>
            <div className="space-y-1">
              {oneSided ? (
                <Note tone="warn" title="По одной стороне вероятность разгрома соперника выводится из «+1.5», а там своя маржа — вычитанием она не убирается. На реальных данных 18.9% против 25.2%.">
                  снята одна сторона — оценка разгрома занижена
                </Note>
              ) : secondSideStale ? (
                <Note tone="warn" title="Кэфы второй команды переиспользуются с прошлого снятия. Первая сторона свежая, вторая — нет. Нажми «Обе стороны», чтобы обновить обе.">
                  вторая сторона снята {staleMin} мин назад — цены могли уехать
                </Note>
              ) : (
                <Note tone="good" title="Обе вкладки команд сняты, маржа снимается корректно во всех книгах.">
                  обе стороны на месте{staleMin ? ` (вторая — ${staleMin} мин назад)` : ''}
                </Note>
              )}
              {divergence != null && Math.abs(divergence) >= 0.05 && (
                <Note tone="warn" title="Маржа внутри книг уже снята, значит это расхождение самих оценок букмекера, а не её след.">
                  книги расходятся на {(Math.abs(divergence) * 100).toFixed(1)} п.п. по трём картам
                </Note>
              )}
              {shape?.mapCheck && (
                Math.abs(shape.mapCheck.seriesFromMap - shape.pA) < 0.02 ? (
                  <Note tone="good" title="Вероятность серии, выведенная из карты #1 через q²(3−2q), сходится с книгой исхода.">
                    модель линии цельная
                  </Note>
                ) : (
                  <Note tone="warn" title="Из карты #1 через q²(3−2q) выводится одна вероятность серии, а книга исхода даёт другую. Обычно так выглядит ручная правка линии.">
                    карта #1 и исход расходятся на{' '}
                    {(Math.abs(shape.mapCheck.seriesFromMap - shape.pA) * 100).toFixed(1)} п.п.
                  </Note>
                )
              )}
              <Note tone="muted" title="Чёт/нечёт, пистолеты, «первыми N раундов», овертайм — маржа 8–10% при нулевой предсказуемости.">
                бейдж «пас» = маржа-ловушка, туда не смотрим
              </Note>
            </div>
          </Section>
        </div>
      )}

      {/* ── Кнопки ── */}
      {/* Кнопки доступны всегда. «Обе стороны» — ручное действие, и прятать его
          после первого использования означало бы запереть пользователя в худших данных. */}
      <footer className="flex shrink-0 gap-1.5 border-t border-border bg-background/60 px-2 py-2">
        <Btn onClick={onRefresh} disabled={busy} title="Пересчитать по текущим кэфам. Вкладки не переключаются.">
          {busy ? 'Считаю…' : 'Обновить'}
        </Btn>
        <Btn
          onClick={onBothSides}
          disabled={busy}
          title="Переключит вкладку команды один раз и вернёт обратно. Нужно для точной оценки разгрома."
        >
          Обе стороны
        </Btn>
        <Btn onClick={copyBrief} primary>{copied ? '✓' : 'Бриф'}</Btn>
      </footer>
    </div>
  );
}

// ── Мелочи ────────────────────────────────────────────────────────────────────
function Section({
  title, hint, children,
}: { title?: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-0">
      {title && (
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
          {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function Side({ name, value, lead }: { name: string; value: string; lead: boolean }) {
  return (
    <div className={`flex-1 rounded-lg border px-2 py-1.5 ${
      lead ? 'border-primary/40 bg-primary/10' : 'border-border bg-background/40'
    }`}>
      <div className="truncate text-[10px] text-muted-foreground">{name}</div>
      <div className={`text-base font-bold tabular-nums ${lead ? 'text-primary' : 'text-foreground'}`}>
        {value}
      </div>
    </div>
  );
}

const GridRow = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b border-border/40 last:border-0">
    <td className="py-0.5 text-muted-foreground">{label}</td>
    <td className="py-0.5 text-right font-medium tabular-nums">{value}</td>
  </tr>
);

function Btn({
  children, onClick, disabled, primary, title,
}: {
  children: React.ReactNode; onClick: () => void;
  disabled?: boolean; primary?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition disabled:opacity-40 ${
        primary
          ? 'bg-primary text-primary-foreground hover:opacity-90'
          : 'border border-border bg-accent text-accent-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

function Note({
  children, tone, title,
}: { children: React.ReactNode; tone: 'warn' | 'good' | 'muted'; title: string }) {
  const styles = {
    warn: 'bg-warn/12 text-warn',
    good: 'bg-good/12 text-good',
    muted: 'bg-muted text-muted-foreground',
  }[tone];
  const icon = { warn: '⚠️', good: '✅', muted: 'ℹ️' }[tone];
  return (
    <div title={title} className={`cursor-help rounded px-1.5 py-1 text-[10px] leading-snug ${styles}`}>
      {icon} {children}
    </div>
  );
}
