import { useMemo, useState } from 'react';
import {
  analyze,
  edgeOf,
  imp,
  nameOf,
  oddsFmt,
  pct,
  requiredP,
  stakeFor,
  TIER,
  TIER_MARK,
  type Offer,
  type TeamSlot,
} from '../engine';
import { buildBrief } from '../lib/brief';
import { estimateKey, useStore } from '../store';
import { Schedule } from './Schedule';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Switch,
  Table,
  Td,
  Th,
  Tooltip,
  TooltipProvider,
} from './ui';

export function App()
{
  const current = useStore((s) => s.current);
  const capturedAt = useStore((s) => s.capturedAt);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const estimates = useStore((s) => s.estimates);
  const setEstimate = useStore((s) => s.setEstimate);
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => (current ? analyze(current) : null), [current]);

  if (!current || !result)
  {
    // Матч не открыт — но анализ расписания доступен всегда, он строится по листингу.
    return (
      <Shell>
        <Card>
          <CardBody className="py-4 text-center text-xs text-muted-foreground">
            Открой матч на сайте — расчёт по нему появится здесь автоматически.
          </CardBody>
        </Card>
        <Schedule />
      </Shell>
    );
  }

  const { shape, books, cheapest, divergence } = result;
  const name = (slot: TeamSlot) => nameOf(current, slot);
  const A = (current.active ?? '1') as TeamSlot;
  const B: TeamSlot = A === '1' ? '2' : '1';
  const stale = capturedAt != null && Date.now() - capturedAt > 10 * 60_000;

  const copyBrief = async () =>
  {
    await navigator.clipboard.writeText(buildBrief(current, settings.edgeFloor));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Мусорные рынки в калькулятор не пускаем: считать Edge для чёт/нечёта бессмысленно.
  const priority: Offer[] = current.offers
    .filter((o) => TIER[o.market].tier !== 'C')
    .sort((a, b) => TIER[a.market].order - TIER[b.market].order);

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-sm font-semibold leading-tight">
          {name('1')} <span className="text-muted-foreground">vs</span> {name('2')}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{current.tournament ?? '?'}</span>
          <span>·</span>
          <span>{current.format ?? '?'}</span>
          {current.timer && (
            <>
              <span>·</span>
              <span>до старта {current.timer}</span>
            </>
          )}
          {(current.sides ?? 1) < 2 && (
            <Badge tone="warn">
              <Tooltip content="По одной стороне вероятность разгрома соперника выводится из «+1.5», а там своя маржа — вычитанием она не убирается. На реальных данных разница 18.9% против 25.2%.">
                одна сторона
              </Tooltip>
            </Badge>
          )}
          {stale && <Badge tone="warn">данные старше 10 минут</Badge>}
        </p>
      </header>

      {shape && (
        <Card>
          <CardHeader>
            <CardTitle>Сетка исходов</CardTitle>
            <Badge tone="muted" className="ml-auto">
              {shape.bookCount}/3 книг
            </Badge>
          </CardHeader>
          <CardBody>
            {shape.reduced ? (
              <p className="text-[11px] text-muted-foreground">
                Форы по картам в линии нет — разбивку «всухую / 2:1» построить не из чего.
              </p>
            ) : (
              <Table>
                <tbody>
                  <Row label={`${name(A)} 2:0`} value={pct(shape.fair!.a20)} />
                  <Row label={`${name(A)} 2:1`} value={pct(shape.fair!.a21)} />
                  <Row label={`${name(B)} 2:1`} value={pct(shape.fair!.b21)} />
                  <Row label={`${name(B)} 2:0`} value={pct(shape.fair!.b20)} />
                </tbody>
              </Table>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                {name(A)} <b className="text-good">{pct(shape.pA)}</b>
              </span>
              <span>
                {name(B)} <b className="text-good">{pct(shape.pB)}</b>
              </span>
              <span className="text-muted-foreground">
                три карты <b className="text-foreground">{pct(shape.p3maps)}</b>
              </span>
            </div>

            {shape.mapCheck && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {Math.abs(shape.mapCheck.seriesFromMap - shape.pA) < 0.02 ? '✅' : '⚠️'}{' '}
                <Tooltip content="Из вероятности взять одну карту выводится вероятность серии по формуле q²(3−2q). Сходится с книгой исхода — значит модель букмекера цельная и арифметической щели в ней нет.">
                  сверка через карту #1
                </Tooltip>
                : {pct(shape.mapCheck.q)} → {pct(shape.mapCheck.seriesFromMap)} против{' '}
                {pct(shape.pA)}
              </p>
            )}

            {divergence != null && (
              <p
                className={`mt-1 text-[11px] ${Math.abs(divergence) >= 0.05 ? 'text-warn' : 'text-muted-foreground'}`}
              >
                {Math.abs(divergence) >= 0.05 ? '🚨' : '✅'}{' '}
                <Tooltip content="Маржа внутри каждой книги уже снята, поэтому расхождение — это несогласие самих оценок букмекера, а не её след. Обычно сильнее та книга, где маржа ниже.">
                  книги о трёх картах
                </Tooltip>
                : форы {pct(shape.p3FromHandicaps)} против тотала {pct(shape.p3FromTotals)} (
                {(Math.abs(divergence) * 100).toFixed(1)} п.п.)
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Калькулятор Edge</CardTitle>
          <span className="ml-auto text-[10px] text-muted-foreground">
            впиши свою вероятность, %
          </span>
        </CardHeader>
        <CardBody className="px-0 py-0">
          <Table>
            <thead>
              <tr>
                <Th>Рынок</Th>
                <Th className="text-right">Кэф</Th>
                <Th className="text-right">Порог</Th>
                <Th className="w-14 text-right">Моя P</Th>
                <Th className="text-right">Edge</Th>
                <Th className="text-right">Ставка</Th>
              </tr>
            </thead>
            <tbody>
              {priority.map((o) =>
              {
                const key = estimateKey(current, o.type);
                const p = estimates[key];
                const need = requiredP(o.odds, settings.edgeFloor);
                const edge = p != null ? edgeOf(p, o.odds) : null;
                const stake = edge != null ? stakeFor(edge, settings.unit) : null;
                const tier = TIER[o.market].tier;
                return (
                  <tr key={o.type}>
                    <Td className="max-w-[150px]">
                      <span className="mr-1">{TIER_MARK[tier]}</span>
                      <span className="text-[11px]">{o.text || o.type}</span>
                      {o.team && <span className="text-muted-foreground"> · {name(o.team)}</span>}
                    </Td>
                    <Td className="text-right font-medium">{oddsFmt(o.odds)}</Td>
                    <Td className="text-right text-muted-foreground">
                      {need > 1 ? '∅' : pct(need, 0)}
                    </Td>
                    <Td className="text-right">
                      <Input
                        className="h-6 w-12 px-1 text-right"
                        inputMode="decimal"
                        placeholder="—"
                        value={p != null ? Math.round(p * 1000) / 10 : ''}
                        onChange={(e) =>
                        {
                          const v = e.target.value.replace(',', '.').trim();
                          setEstimate(key, v === '' ? null : Number(v) / 100);
                        }}
                      />
                    </Td>
                    <Td
                      className={`text-right font-medium ${edge == null ? '' : edge >= settings.edgeFloor ? 'text-good' : 'text-bad'}`}
                    >
                      {edge == null ? '—' : `${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`}
                    </Td>
                    <Td className="text-right">
                      {stake && stake.units > 0 ? (
                        <Badge tone={stake.flag === '🟢' ? 'good' : 'warn'}>{stake.sum} ₽</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      {books.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Маржа по книгам</CardTitle>
          </CardHeader>
          <CardBody className="px-0 py-0">
            <Table>
              <tbody>
                {[...books]
                  .sort((a, b) => a.margin - b.margin)
                  .map((b) => (
                    <tr key={b.label}>
                      <Td className="text-[11px]">
                        {TIER_MARK[TIER[b.market].tier]} {b.label}
                      </Td>
                      <Td className="text-right text-muted-foreground">
                        {oddsFmt(b.a.odds)} / {oddsFmt(b.b.odds)}
                      </Td>
                      <Td className="text-right">
                        <Badge tone={b.margin > 0.095 ? 'bad' : b.margin > 0.088 ? 'warn' : 'good'}>
                          {pct(b.margin)}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
            {cheapest && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Дешевле всего — <span className="text-foreground">{cheapest.label}</span>. Выбор
                рынка важнее выбора команды: маржа это фора букмекеру ещё до анализа.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <Schedule />

      <Button onClick={copyBrief} className="w-full">
        {copied ? '✓ Скопировано' : 'Скопировать бриф для Claude'}
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Настройки</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1">
          <label className="flex items-center justify-between gap-3 py-1 text-xs">
            <span className="text-muted-foreground">Банк, ₽</span>
            <Input
              className="w-20 text-right"
              inputMode="numeric"
              value={settings.bank}
              onChange={(e) => setSettings({ bank: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 py-1 text-xs">
            <span className="text-muted-foreground">1 юнит, ₽</span>
            <Input
              className="w-20 text-right"
              inputMode="numeric"
              value={settings.unit}
              onChange={(e) => setSettings({ unit: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 py-1 text-xs">
            <span className="text-muted-foreground">Порог Edge, %</span>
            <Input
              className="w-20 text-right"
              inputMode="decimal"
              value={Math.round(settings.edgeFloor * 1000) / 10}
              onChange={(e) =>
                setSettings({ edgeFloor: (Number(e.target.value.replace(',', '.')) || 0) / 100 })
              }
            />
          </label>
          <Switch
            checked={settings.autoBothSides}
            onCheckedChange={(v) => setSettings({ autoBothSides: v })}
            label="Собирать обе вкладки команд"
          />
          <Switch
            checked={settings.showBadges}
            onCheckedChange={(v) => setSettings({ showBadges: v })}
            label="Бейджи у коэффициентов"
          />
          <p className="pt-1 text-[10px] leading-snug text-muted-foreground">
            Юнит — 5% банка на старте. Пересчитывается раз в неделю от текущего банка: банк падает —
            падает и размер ставок.
          </p>
        </CardBody>
      </Card>
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>
    <main className="flex min-h-dvh flex-col gap-3 bg-background p-3 text-foreground">
      {children}
    </main>
  </TooltipProvider>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <tr>
    <Td className="text-muted-foreground">{label}</Td>
    <Td className="text-right font-medium">{value}</Td>
  </tr>
);


