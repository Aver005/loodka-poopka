import { TIER, imp, pct, requiredP, type Match } from '../engine';

const CLASS = 'lp-badge';

/**
 * Приписывает к каждому коэффициенту на странице его смысл.
 *
 * Показывается не implied (в нём сидит маржа букмекера), а **минимальная вероятность,
 * при которой ставка проходит порог входа**. Это единственное число, с которым
 * осмысленно сравнивать свою оценку: «я думаю, тут больше 52%?» — да или нет.
 *
 * Бейджи вставляются в светлый DOM страницы: внутрь чужой вёрстки shadow root
 * не воткнуть. Поэтому у них свой префикс и максимально нейтральные стили.
 */
export function paintBadges(root: HTMLElement, match: Match, edgeFloor: number): void {
  clearBadges(root);

  const byType = new Map(match.offers.map((o) => [o.type, o]));

  for (const a of root.querySelectorAll<HTMLElement>('a[data-type]')) {
    const offer = byType.get(a.dataset.type ?? '');
    if (!offer) continue;

    const { tier } = TIER[offer.market];
    const need = requiredP(offer.odds, edgeFloor);

    const badge = document.createElement('span');
    badge.className = `${CLASS} ${CLASS}--${tier.toLowerCase()}`;

    if (tier === 'C') {
      // Маржа-ловушки не заслуживают вычислений — их надо просто не замечать.
      badge.classList.add(`${CLASS}--trap`);
      badge.textContent = 'пас';
      badge.title = `${TIER[offer.market].label} — маржа-ловушка, играть не стоит (см. MARKETS.md)`;
    } else if (need > 1) {
      badge.textContent = '∅';
      badge.title = 'Кэф слишком низкий: порог входа недостижим ни при какой вероятности';
    } else {
      badge.textContent = `≥${pct(need, 0)}`;
      badge.title =
        `${TIER[offer.market].label}\n` +
        `Кэф ${offer.odds.toFixed(3)} · в цене ${pct(imp(offer.odds))}\n` +
        `Ставка выгодна, если твоя оценка выше ${pct(need)}`;
    }

    // Кладём рядом с ценой, а не внутрь кнопки — иначе ломается клик по ставке.
    const anchor = a.previousElementSibling?.classList.contains('koef')
      ? a.previousElementSibling
      : a.nextElementSibling?.classList.contains('koef')
        ? a.nextElementSibling
        : a;
    anchor.insertAdjacentElement('afterend', badge);
  }
}

export function clearBadges(root: ParentNode = document): void {
  for (const el of root.querySelectorAll(`.${CLASS}`)) el.remove();
}
