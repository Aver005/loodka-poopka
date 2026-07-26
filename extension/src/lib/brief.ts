import {
  analyze, nameOf, oddsFmt, pct, requiredP, TIER,
  type Match, type TeamSlot,
} from '../engine';

/**
 * Готовый промпт для Claude Code.
 *
 * Смысл в разделении труда: арифметику расширение уже посчитало и кладёт сюда
 * готовой, чтобы модель не тратила ход на устный счёт и не ошибалась в нём.
 * От неё требуется только то, чего расширение не умеет — оценка вероятности
 * по форме, составам, расписанию и новостям.
 *
 * Отдельно и намеренно: в брифе НЕ называется, какая ставка «выглядит хорошо».
 * Иначе модель получит якорь и подгонит свою оценку под линию, а именно этого
 * правило слепой оценки и избегает.
 */
export function buildBrief(match: Match, edgeFloor = 0.03): string {
  const { shape, books, cheapest, divergence } = analyze(match);
  const name = (slot: TeamSlot) => nameOf(match, slot);
  const L: string[] = [];

  L.push(`# Разбор матча: ${name('1')} vs ${name('2')}`, '');
  L.push(`**Турнир:** ${match.tournament ?? '?'} · **Формат:** ${match.format ?? '?'}` +
         (match.timer ? ` · **До старта:** ${match.timer}` : ''));
  L.push('');
  L.push('Линия снята расширением, вся арифметика ниже уже посчитана — вероятности очищены от маржи.');
  L.push('');

  if (shape) {
    L.push('## Что говорит линия', '');
    const A = match.active as TeamSlot;
    const B: TeamSlot = A === '1' ? '2' : '1';
    if (shape.fair) {
      L.push('| Исход | Вероятность |', '|---|:-:|');
      L.push(`| ${name(A)} 2:0 | ${pct(shape.fair.a20)} |`);
      L.push(`| ${name(A)} 2:1 | ${pct(shape.fair.a21)} |`);
      L.push(`| ${name(B)} 2:1 | ${pct(shape.fair.b21)} |`);
      L.push(`| ${name(B)} 2:0 | ${pct(shape.fair.b20)} |`);
      L.push('');
    }
    L.push(`**Итог:** ${name(A)} ${pct(shape.pA)} · ${name(B)} ${pct(shape.pB)} · три карты ${pct(shape.p3maps)}`);
    if (shape.reduced) L.push('', '⚠️ Форы по картам в линии нет — разбивка «всухую / 2:1» недоступна.');
    if (shape.solidHandicaps === false) {
      L.push('', '⚠️ Фора снята только с одной стороны — оценка разгрома занижена.');
    }
    if (divergence != null && Math.abs(divergence) >= 0.05) {
      L.push('', `🚨 **Книги расходятся на ${(Math.abs(divergence) * 100).toFixed(1)} п.п.** по вероятности трёх карт: ` +
             `по форам ${pct(shape.p3FromHandicaps)}, по тоталу карт ${pct(shape.p3FromTotals)}.`);
    }
    if (shape.mapCheck) {
      const d = Math.abs(shape.mapCheck.seriesFromMap - shape.pA);
      L.push('', `Сверка через карту #1: ${pct(shape.mapCheck.q)} на карту → q²(3−2q) = ` +
             `${pct(shape.mapCheck.seriesFromMap)} на серию против ${pct(shape.pA)} в книге исхода ` +
             `(расхождение ${(d * 100).toFixed(1)} п.п.).`);
    }
    L.push('');
  }

  if (books.length) {
    L.push('## Маржа по книгам', '');
    L.push('| Рынок | Кэфы | Маржа |', '|---|---|:-:|');
    for (const b of [...books].sort((x, y) => x.margin - y.margin)) {
      const flag = b.suspicious ? ' 🚨 **разбор сбоил, не доверять**' : '';
      L.push(`| ${b.label} | ${oddsFmt(b.a.odds)} / ${oddsFmt(b.b.odds)} | ${pct(b.margin)}${flag} |`);
    }
    if (cheapest) L.push('', `Дешевле всего — **${cheapest.label}** (${pct(cheapest.margin)}).`);
    if (books.some((b) => b.suspicious)) {
      L.push('');
      L.push('> 🚨 Строки с пометкой собраны неверно: маржа вне правдоподобного диапазона ' +
             'означает, что в одну книгу попали кэфы разных рынков. Ставки по ним не рассматривать.');
    }
    L.push('');
  }

  // Только приоритетные рынки: гнать в промпт чёт/нечёт и пистолеты бессмысленно.
  const priority = match.offers
    .filter((o) => TIER[o.market].tier !== 'C')
    .sort((a, b) => TIER[a.market].order - TIER[b.market].order);

  if (priority.length) {
    L.push(`## Порог входа (Edge ≥ ${(edgeFloor * 100).toFixed(0)}%)`, '');
    L.push('| Ставка | Кэф | Нужна моя P выше |', '|---|:-:|:-:|');
    for (const o of priority) {
      const need = requiredP(o.odds, edgeFloor);
      const tag = o.team ? ` (${name(o.team)})` : '';
      L.push(`| ${o.text || o.type}${tag} | ${oddsFmt(o.odds)} | ${need > 1 ? 'недостижимо' : pct(need)} |`);
    }
    L.push('');
  }

  L.push('## Что нужно от тебя', '');
  L.push('1. Свежие новости по обеим командам: составы, замены, стендины, тренер.');
  L.push('2. Форма за последние 10–15 карт (карты честнее, чем матчи).');
  L.push('3. Маппул и вероятное вето — какие карты доедут до игры и кому это выгодно.');
  L.push('4. Контекст: цена матча, LAN или онлайн, усталость, расписание, вторая игра за день.');
  L.push('5. **Своя оценка вероятности** по приоритетным рынкам — и сравнить с порогом выше.');
  L.push('6. Вердикт 🟢/🟡/🔴 и размер по шкале из README.md.');
  L.push('');
  L.push('> Если внятной причины знать больше рынка нет — так и скажи, пас это нормальный ответ.');

  return L.join('\n');
}
