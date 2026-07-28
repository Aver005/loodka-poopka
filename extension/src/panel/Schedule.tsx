import { useMemo, useState } from 'react';
import {
  buildListingBrief, fairP1, findAsymmetries, formatDuration, hasStarted, publicBias,
  sortByStart, type ListingMatch,
} from '../listing';
import { useStore } from '../store';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Table, Td, Th, Tooltip } from './ui';

const pct = (x: number | null | undefined, d = 0) =>
  x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`;

/**
 * Управление сбором.
 *
 * Раньше листинг обновлялся исключительно сам, по мутациям DOM, и «переснять» его
 * из интерфейса было нельзя вообще — приходилось руками чистить хранилище расширения.
 * Отсюда три явных действия.
 */
function Controls() {
  const listing = useStore((s) => s.listing);
  const scan = useStore((s) => s.listingScan);
  const requestListing = useStore((s) => s.requestListing);
  const clearListing = useStore((s) => s.clearListing);

  if (scan) {
    return (
      <Card>
        <CardBody className="py-2 text-center text-[11px] text-muted-foreground">
          Листаю страницы: <b>{scan.page}</b> из {scan.pages} · найдено{' '}
          <b className="text-foreground">{scan.found}</b>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex gap-1.5">
      <Tooltip content="Пролистает все страницы слайдера и соберёт всё, что найдётся. Клик по пагинации — локальный сдвиг, запросов к сайту не делает.">
        <Button onClick={() => requestListing('collect-all')} className="flex-1">
          Собрать все страницы
        </Button>
      </Tooltip>
      <Tooltip content="Перечитать то, что сейчас в DOM, не листая.">
        <Button variant="outline" onClick={() => requestListing('refresh')}>
          Обновить
        </Button>
      </Tooltip>
      <Tooltip content="Выбросить собранное. Нужно, когда в списке остались матчи прошлого дня.">
        <Button variant="ghost" onClick={clearListing} disabled={!listing.length}>
          Очистить
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * Полный список собранного.
 *
 * Нужен ровно для одного: чтобы было видно, что именно прочитано. Пока в панели
 * показывались только выводы (перекос, деньги публики), проверить полноту сбора
 * было невозможно — а он терял целый блок страницы и об этом не сообщал.
 */
function AllMatches({ listing }: { listing: ListingMatch[] }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => sortByStart(listing), [listing]);
  const started = sorted.filter(hasStarted).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Все матчи</CardTitle>
        <Badge tone="muted" className="ml-auto">{listing.length}</Badge>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'скрыть' : 'показать'}
        </Button>
      </CardHeader>
      {open && (
        <CardBody className="px-0 py-0">
          <Table>
            <tbody>
              {sorted.map((m) => (
                <tr key={m.id} className={hasStarted(m) ? 'opacity-45' : ''}>
                  <Td className="max-w-41.25 text-[11px] leading-tight">
                    {m.team1} <span className="text-muted-foreground">vs</span> {m.team2}
                    <div className="text-[10px] text-muted-foreground">
                      {m.tournament ?? '—'} · {m.format ?? '—'}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-right text-[10px]">
                    {m.startsInMs == null
                      ? <span className="text-muted-foreground">таймер не разобран</span>
                      : formatDuration(m.startsInMs)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {started > 0 && (
            <p className="px-3 py-2 text-[10px] leading-snug text-muted-foreground">
              Бледным — {started} матч(ей), которые уже начались. В анализ они не идут,
              но в подсчёт нагрузки команд входят: именно они и создают усталость.
            </p>
          )}
        </CardBody>
      )}
    </Card>
  );
}

/**
 * Анализ всего листинга.
 *
 * Здесь живёт то, чего принципиально не видно из одного матча: кто выходит на игру
 * уставшим, кого перегружает публика и где линия этого не заметила.
 */
export function Schedule() {
  const listing = useStore((s) => s.listing);
  const listingAt = useStore((s) => s.listingAt);
  const [copied, setCopied] = useState(false);

  const asym = useMemo(() => findAsymmetries(listing), [listing]);
  const biased = useMemo(
    () =>
      listing
        .map((m) => ({ m, bias: publicBias(m), fair: fairP1(m) }))
        .filter((x) => x.bias != null && Math.abs(x.bias) >= 3)
        .sort((a, b) => Math.abs(b.bias!) - Math.abs(a.bias!))
        .slice(0, 8),
    [listing],
  );

  // Кнопки показываем и на пустом состоянии: раньше тут был ранний выход,
  // и «собрать» нажать было нечем именно тогда, когда это нужнее всего.
  if (!listing.length) {
    return (
      <>
        <Card>
          <CardBody className="py-5 text-center text-xs text-muted-foreground">
            Листинг пуст. Открой страницу со списком матчей — он соберётся сам,
            либо нажми «Собрать все страницы».
          </CardBody>
        </Card>
        <Controls />
      </>
    );
  }

  const copyBrief = async () => {
    await navigator.clipboard.writeText(buildListingBrief(listing));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const ageMin = listingAt ? Math.floor((Date.now() - listingAt) / 60_000) : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Перекос расписания</CardTitle>
          <Badge tone="muted" className="ml-auto">{listing.length} матчей</Badge>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {asym.length === 0 ? (
            <p className="px-3 py-3 text-[11px] leading-snug text-muted-foreground">
              Асимметрии нет: никто не выходит уставшим против заметно более свежего соперника.
              <br />
              <span className="opacity-80">
                Круговые турниры сюда не попадают намеренно — когда график плотный у всех,
                преимущества нет ни у кого.
              </span>
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Матч</Th>
                  <Th className="text-right">Позади</Th>
                  <Th className="text-right">Отдых</Th>
                  <Th className="text-right">Линия</Th>
                </tr>
              </thead>
              <tbody>
                {asym.map((a) => (
                  <tr key={a.match.id}>
                    <Td className="max-w-37.5 leading-tight">
                      <div className="text-[11px]">
                        <span className={a.tired === a.match.team1 ? 'font-semibold text-warn' : ''}>
                          {a.match.team1}
                        </span>
                        <span className="text-muted-foreground"> vs </span>
                        <span className={a.tired === a.match.team2 ? 'font-semibold text-warn' : ''}>
                          {a.match.team2}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {a.match.tournament} · {a.match.format} · через {formatDuration(a.match.startsInMs ?? NaN)}
                      </div>
                    </Td>
                    <Td className="text-right">{a.priorMatches}</Td>
                    <Td className={`text-right ${a.restMs < 0 ? 'text-bad' : ''}`}>
                      {formatDuration(a.restMs)}
                    </Td>
                    <Td className="text-right">
                      {a.tiredIsFavorite ? (
                        <Tooltip content="Линия держит уставшую команду фаворитом — значит график в цену не заложен. Это и есть перекос, ради которого всё считается.">
                          <Badge tone="good">{pct(a.tiredFairP)} 🎯</Badge>
                        </Tooltip>
                      ) : (
                        <Tooltip content="Рынок уже считает уставшую команду андердогом — график в цене, ставить не на что.">
                          <Badge tone="muted">{pct(a.tiredFairP)}</Badge>
                        </Tooltip>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {biased.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Деньги публики</CardTitle>
            <span className="ml-auto text-[10px] text-muted-foreground">отклонение от линии</span>
          </CardHeader>
          <CardBody className="px-0 py-0">
            <Table>
              <tbody>
                {biased.map(({ m, bias }) => (
                  <tr key={m.id}>
                    <Td className="max-w-42.5 text-[11px] leading-tight">
                      {m.team1} <span className="text-muted-foreground">vs</span> {m.team2}
                    </Td>
                    <Td className="text-right text-[10px] text-muted-foreground">
                      {m.publicPct1}/{m.publicPct2}
                    </Td>
                    <Td className="text-right">
                      <Badge tone={Math.abs(bias!) >= 5 ? 'warn' : 'muted'}>
                        {bias! > 0 ? '+' : ''}{bias!.toFixed(1)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="px-3 py-2 text-[10px] leading-snug text-muted-foreground">
              Знак — в сторону <b>первой</b> команды. На живых данных публика систематически
              перегружает тяжёлых фаворитов на 3–4 п.п. сверх честной вероятности.
              Это измерение того, что раньше было качественным признаком «народная команда».
            </p>
          </CardBody>
        </Card>
      )}

      <AllMatches listing={listing} />
      <Controls />

      <Button onClick={copyBrief} variant="outline" className="w-full">
        {copied ? '✓ Скопировано' : 'Скопировать листинг для Claude (без кэфов)'}
      </Button>
      <p className="-mt-1 text-center text-[10px] leading-snug text-muted-foreground">
        Цены в бриф не попадают намеренно: увидев их первой, модель подгонит под них
        свою оценку, и найти ошибку рынка станет невозможно.
        {ageMin != null && <> · собрано {ageMin} мин назад</>}
      </p>
    </>
  );
}

/** Мелкая справка для отладки: сколько матчей у каждой команды. */
export function teamsWithMultipleMatches(listing: ListingMatch[]): string[] {
  const count = new Map<string, number>();
  for (const m of listing) {
    for (const t of [m.team1, m.team2]) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()].filter(([, n]) => n > 1).map(([t, n]) => `${t} ×${n}`);
}
