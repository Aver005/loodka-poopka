/* ============================================================================
 * grab-console.js — вставить в консоль браузера (F12 → Console) ОДИН раз.
 *
 *     await LP.grab()    открытая модалка → забрать (пробует обе команды)
 *     LP.debug()         что скрипт видит в DOM — если grab капризничает
 *     await LP.page()    аварийный режим: сохранить страницу целиком
 *     LP.count()         сколько накопилось
 *     LP.save()          скачать всё одним .json → положить в input/html/
 *     LP.clear()         сбросить
 *
 * Принцип: grab() СНАЧАЛА сохраняет то, что видно, и только потом пробует
 * переключить вкладку команды. Даже если переключение не сработает —
 * данные одной стороны уже в буфере, а этого хватает для исхода и тотала карт.
 * ========================================================================== */
(() =>
{
  const KEY = 'lp_bets_v2';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = () =>
  {
    try
    {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    }
    catch
    {
      return [];
    }
  };
  const store = (v) => localStorage.setItem(KEY, JSON.stringify(v));
  const log = (msg, color = '#0a0') => console.log(`%c LP `, `background:${color};color:#fff`, msg);

  const visible = (el) =>
    !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  /** Ближайший общий предок набора узлов. */
  function lca(nodes)
  {
    let a = nodes[0];
    for (const n of nodes.slice(1)) while (a && !a.contains(n)) a = a.parentElement;
    return a;
  }

  /**
   * Модалка = общий предок ВИДИМЫХ коэффициентов, поднятый до блока с командами.
   * Считать по «максимуму .koef» нельзя: на странице висят скрытые модалки других
   * матчей, и максимум всегда у <body>. Видимость отсекает их сразу.
   */
  function modal()
  {
    const koefs = [...document.querySelectorAll('.koef')].filter(visible);
    if (!koefs.length) return null;

    let el = lca(koefs);
    const hasTeams = (n) => !!n?.querySelector('[class*="team_select"], [class*="team_name"]');

    // Поднимаемся, пока не подхватим блок команд — но не дальше, чем начнут
    // добавляться чужие коэффициенты (значит вылезли за пределы своего матча).
    for (let i = 0; i < 6 && el?.parentElement && el !== document.body; i++)
    {
      if (hasTeams(el)) break;
      const up = el.parentElement;
      if ([...up.querySelectorAll('.koef')].filter(visible).length !== koefs.length) break;
      el = up;
    }
    return el;
  }

  /** Ищем вкладки команд несколькими способами — разметка на сайте плавает. */
  function findTabs(root)
  {
    const scopes = [root, root?.parentElement, document];
    for (const scope of scopes)
    {
      if (!scope) continue;
      for (const probe of [
        () => [scope.querySelector('[class*="team_1"]'), scope.querySelector('[class*="team_2"]')],
        () =>
        {
          const s = scope.querySelector('.team_select, [class*="team_select"]');
          return s ? [...s.children] : [];
        },
        () =>
          [...scope.querySelectorAll('.team_name, [class*="team_name"]')].map(
            (n) => n.closest('[class*="team_"]') ?? n.parentElement?.parentElement,
          ),
        () =>
          [...scope.querySelectorAll('.team_stat_link, [class*="stat_link"]')].map(
            (n) => n.closest('[class*="team_"]') ?? n.parentElement?.parentElement,
          ),
      ])
      {
        const tabs = (probe() || []).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        if (tabs.length === 2) return tabs;
      }
    }
    return [];
  }

  const sig = (root) =>
    root ? [...root.querySelectorAll('.koef')].map((n) => n.textContent.trim()).join(',') : '';

  async function clickTab(tab, root)
  {
    const before = sig(root);
    const targets = [
      tab.querySelector('[class*="team_right"]'),
      tab.querySelector('img'),
      tab.firstElementChild,
      tab,
    ];
    for (const t of targets)
    {
      if (!t) continue;
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
      {
        t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      try
      {
        t.click?.();
      }
      catch
      {}
      for (let i = 0; i < 16; i++)
      {
        // ~2 c на цель, дальше пробуем следующую
        await sleep(120);
        const now = sig(modal() ?? root);
        if (now && now !== before)
        {
          await sleep(400);
          return true;
        }
      }
    }
    return false;
  }

  function label(root)
  {
    const names = [...(root?.querySelectorAll('.team_name, [class*="team_name"]') ?? [])]
      .map((n) => n.textContent.trim())
      .filter(Boolean);
    const ev = root
      ?.querySelector('.bet_event, [class*="bet_event"]')
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
    return `${names.length ? names.join(' vs ') : '(имена не найдены)'}${ev ? ` [${ev}]` : ''}`;
  }

  /**
   * Кладёт запись, ЗАМЕНЯЯ прежнюю по тому же (матч + сторона).
   * Сравнивать по html нельзя: кэфы шевелятся, и повторный заход плодил бы дубли
   * вместо того, чтобы обновлять цифры.
   */
  function push(root, note)
  {
    const bag = load();
    const rec =
    {
      source: location.href,
      label: label(root),
      note,
      ts: Date.now(),
      html: root.outerHTML,
    };
    const i = bag.findIndex((b) => b.label === rec.label && b.note === rec.note);
    if (i >= 0)
    {
      bag[i] = rec;
      store(bag);
      return { added: 0, updated: 1 };
    }
    bag.push(rec);
    store(bag);
    return { added: 1, updated: 0 };
  }

  const LP =
  {
    async grab()
    {
      const root = modal();
      if (!root)
      {
        log('Не нашёл коэффициенты на странице. Открой модалку и попробуй LP.debug()', '#c00');
        return 0;
      }

      // 1. Сначала сохраняем то, что видим. Что бы дальше ни случилось — данные есть.
      const r1 = push(root, 'сторона A');
      const tabs = findTabs(root);

      // 2. Потом пробуем вторую сторону.
      if (tabs.length !== 2)
      {
        log(`${label(root)} — сохранена одна сторона. Вкладки команд не найдены.`, '#a60');
        console.log(
          '   Исход и тотал карт восстановятся и так, а вот фора по картам будет неточной.',
        );
        console.log('   Переключи вкладку руками и повтори LP.grab()');
        return 1;
      }

      const inactive = tabs.find((t) => !/\bactive\b/.test(t.className)) ?? tabs[1];
      let r2 = { added: 0, updated: 0 };
      if (await clickTab(inactive, root))
      {
        await sleep(300);
        r2 = push(modal() ?? root, 'сторона B');
      }
      else
      {
        log('вторую вкладку кликнуть не удалось — переключи руками и повтори LP.grab()', '#a60');
      }

      const add = r1.added + r2.added;
      const upd = r1.updated + r2.updated;
      log(
        `${label(root)} — новых ${add}${upd ? `, обновлено ${upd}` : ''}, всего в буфере ${load().length}`,
      );
      return add + upd;
    },

    async page()
    {
      const bag = load();
      bag.push(
      {
        source: location.href,
        label: 'FULL PAGE',
        note: 'аварийный режим',
        ts: Date.now(),
        html: document.documentElement.outerHTML,
      });
      store(bag);
      log(
        `Страница целиком сохранена (${(bag.at(-1).html.length / 1024) | 0} КБ). Парсер сам найдёт модалку.`,
      );
      return 1;
    },

    debug()
    {
      const root = modal();
      console.group('%c LP debug ', 'background:#06c;color:#fff');
      console.log('коэффициентов на странице:', document.querySelectorAll('.koef').length);
      console.log('выбранный контейнер:', root);
      if (root)
      {
        console.log('  tag/class:', root.tagName, '|', root.className, '| id:', root.id || '—');
        console.log('  .koef внутри:', root.querySelectorAll('.koef').length);
        console.log('  m_next внутри:', root.querySelectorAll('.m_next, [data-type]').length);
        console.log(
          '  скелет:',
          [...root.children].map((c) => `${c.tagName}.${c.className}`).join('\n           '),
        );
      }
      console.log('кандидаты во вкладки:', findTabs(root));
      console.log(
        'узлы с team в классе:',
        [...document.querySelectorAll('[class*="team"]')].slice(0, 12).map((n) => n.className),
      );
      console.groupEnd();
      console.log('Если вкладки пустые — жми LP.page() и присылай файл, разберу структуру.');
    },

    count()
    {
      const b = load();
      console.table(
        b.map((x, i) => (
        {
          '#': i,
          матч: x.label,
          что: x.note,
          КБ: (x.html.length / 1024) | 0,
          собрано: new Date(x.ts).toLocaleTimeString(),
        })),
      );
      return b.length;
    },

    /** Выбросить записи, чей label содержит подстроку. LP.drop('не найдены') — типовой случай. */
    drop(substr)
    {
      const bag = load();
      const keep = bag.filter((b) => !b.label.toLowerCase().includes(String(substr).toLowerCase()));
      store(keep);
      log(`Удалено ${bag.length - keep.length}, осталось ${keep.length}`);
      return keep.length;
    },

    /** По умолчанию после выгрузки буфер чистится — файл уже на диске, копия не нужна. */
    save(opts = {})
    {
      const bag = load();
      if (!bag.length) return log('Пусто.', '#c00');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(bag)], { type: 'application/json' }));
      a.download = `bets-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (opts.keep) log(`Скачано ${bag.length} записей. Буфер оставлен (opts.keep).`);
      else
      {
        localStorage.removeItem(KEY);
        log(`Скачано ${bag.length} записей, буфер очищен → файл в input/html/`);
      }
      return bag.length;
    },

    clear()
    {
      localStorage.removeItem(KEY);
      log('Сброшено.');
    },
  };

  window.LP = LP;
  log(
    'Готово. await LP.grab() на каждом матче → LP.save() в конце. Если что-то не так — LP.debug()',
  );
})();
