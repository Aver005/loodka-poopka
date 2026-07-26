import { useMemo } from 'react';
import { analyze, nameOf, pct, type Match, type TeamSlot } from '../engine';
import { buildBrief } from '../lib/brief';
import { useStore } from '../store';

interface Props {
  match: Match;
  busy: boolean;
  /** Вторую сторону по этому матчу ещё не снимали. */
  bothSidesAvailable: boolean;
  unit: number;
  onRefresh: () => void;
  onBothSides: () => void;
}

/**
 * Компактная сводка поверх модалки.
 *
 * Здесь намеренно нет ни одного компонента из библиотеки: ни выпадающих списков,
 * ни диалогов, ни тултипов. Всё богатое — в боковой панели, где свой документ
 * и нет чужого CSS. Здесь только то, на что глаз падает за полсекунды.
 */
export function Overlay({ match, busy, bothSidesAvailable, onRefresh, onBothSides }: Props) {
  const edgeFloor = useStore((s) => s.settings.edgeFloor);
  const { shape, cheapest, divergence } = useMemo(() => analyze(match), [match]);

  const A = (match.active ?? '1') as TeamSlot;
  const B: TeamSlot = A === '1' ? '2' : '1';
  const oneSided = (match.sides ?? 1) < 2;

  const copyBrief = () => {
    void navigator.clipboard.writeText(buildBrief(match, edgeFloor));
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card font-sans text-foreground shadow-xl">
      {/* Полоса-акцент, чтобы блок читался как «не часть сайта» */}
      <div className="h-0.5 w-full bg-primary/70" />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        {shape ? (
          <>
            <Team name={nameOf(match, A)} value={pct(shape.pA)} lead={shape.pA >= shape.pB} />
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground">VS</span>
            <Team name={nameOf(match, B)} value={pct(shape.pB)} lead={shape.pB > shape.pA} />

            <span className="mx-1 h-7 w-px bg-border" />

            <Metric label="три карты" value={pct(shape.p3maps)} />
            {cheapest && <Metric label="дешевле всего" value={`${cheapest.label} · ${pct(cheapest.margin)}`} />}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            Данных мало: в линии нет тотала карт либо снята лишь одна сторона.
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {bothSidesAvailable && (
            <Btn onClick={onBothSides} disabled={busy} title="Переключит вкладку команды один раз и вернёт обратно">
              Обе стороны
            </Btn>
          )}
          <Btn onClick={onRefresh} disabled={busy}>{busy ? 'Считаю…' : 'Обновить'}</Btn>
          <Btn onClick={copyBrief} primary>Бриф для Claude</Btn>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 bg-background/40 px-3 py-1.5 text-[11px]">
        <span className="text-muted-foreground">
          бейдж <code className="rounded bg-muted px-1 py-px text-foreground">≥52%</code> у кэфа — какой должна быть твоя оценка
        </span>

        {oneSided && (
          <Note tone="warn" title="По одной стороне вероятность разгрома соперника выводится из «+1.5», а там своя маржа — вычитанием она не убирается. На реальных данных 18.9% против 25.2%.">
            одна сторона — разгром занижен
          </Note>
        )}

        {divergence != null && Math.abs(divergence) >= 0.05 && (
          <Note tone="warn" title="Маржа внутри книг уже снята, значит это расхождение самих оценок букмекера, а не её след.">
            книги расходятся на {(Math.abs(divergence) * 100).toFixed(1)} п.п.
          </Note>
        )}

        {shape?.mapCheck && Math.abs(shape.mapCheck.seriesFromMap - shape.pA) < 0.02 && (
          <Note tone="good" title="Вероятность серии, выведенная из карты #1 через q²(3−2q), сходится с книгой исхода.">
            модель линии цельная
          </Note>
        )}
      </div>
    </div>
  );
}

function Team({ name, value, lead }: { name: string; value: string; lead: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`text-xs ${lead ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{name}</span>
      <span className={`text-sm font-bold tabular-nums ${lead ? 'text-primary' : 'text-foreground'}`}>{value}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums text-foreground">{value}</span>
    </span>
  );
}

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
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
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
}: { children: React.ReactNode; tone: 'warn' | 'good'; title: string }) {
  return (
    <span
      title={title}
      className={`cursor-help rounded px-1.5 py-0.5 ${
        tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-good/15 text-good'
      }`}
    >
      {tone === 'warn' ? '⚠️' : '✅'} {children}
    </span>
  );
}
