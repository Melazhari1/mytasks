import { Api, requireAuth, signOut } from './api.js';
import { Theme, Icons, renderShell, emptyState, escapeHtml, formatDate, toast } from './ui.js';
import { lineChart, barChart, completionMeter } from './charts.js';
import { taskModal } from './tasks-shared.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

/* Widget layout (order, width, height) is a device preference, not account
   data — stored in localStorage like Theme, not round-tripped to the server.
   Declared here (not down by the functions that use them) because `const` is
   not hoisted the way function declarations are: calling applyWidgetOrder()
   below while these were still in their temporal dead zone threw on every
   load. */
const WIDGET_ORDER_KEY = 'mytasks.dashboard.widgetOrder';
const WIDGET_SIZE_KEY = 'mytasks.dashboard.widgetSizes';
const WIDGET_WIDTH_KEY = 'mytasks.dashboard.widgetWidths';
const DEFAULT_WIDGET_ORDER = ['tiles', 'activity', 'priority', 'categories', 'upcoming', 'progress'];
const DEFAULT_FULL_WIDGETS = new Set(['tiles', 'activity']);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'dashboard.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="refresh"]').innerHTML = `${Icons.refresh}Refresh`;
$('[data-action="new-task"]').innerHTML = `${Icons.plus}New task`;
$('[data-action="reset-layout"]').innerHTML = `${Icons.refresh}Reset layout`;
$('[data-action="refresh"]').addEventListener('click', () => load());
$('[data-action="new-task"]').addEventListener('click', () => taskModal({ onSaved: load }));
$('[data-action="reset-layout"]').addEventListener('click', resetLayout);

$('[data-slot="greeting"]').textContent = greeting(user);

applyWidgetOrder();
applyWidgetWidths();
applyWidgetSizes();
enableWidgetDragging();
enableWidgetWidthToggle();
enableWidgetResizing();
refreshResetButton();

/* --- Load ----------------------------------------------------------------- */
async function load() {
  showSkeletons();

  try {
    const [summary, categories, all] = await Promise.all([
      Api.tasks.summary(),
      Api.categories.list(true),
      // One generous page is enough to drive every panel client-side and
      // keeps the dashboard to three requests instead of a dozen.
      Api.tasks.list({ per_page: 100, sort: 'created_at', dir: 'desc' }),
    ]);

    render(summary.data, categories.data, all.data, all.meta);
  } catch (err) {
    console.error(err);
    toast('Could not load the dashboard.', 'error');
  }
}

function render(summary, categories, tasks, meta) {
  $('[data-slot="subtitle"]').textContent = subtitle(summary);

  renderTiles(summary);
  renderActivity(tasks);
  renderPriority(tasks);
  renderCategories(categories);
  renderUpcoming(tasks);

  completionMeter($('[data-slot="meter"]'), {
    done: summary.completed,
    total: summary.total,
  });

  $('[data-slot="meter-note"]').textContent = meta?.total > tasks.length
    ? `Charts cover the ${tasks.length} most recent of ${meta.total} tasks.`
    : '';
}

/* --- Tiles ---------------------------------------------------------------- */
function renderTiles(s) {
  const tiles = [
    { label: 'Due today',    value: s.due_today,     icon: 'clock',  accent: 'var(--accent)',
      foot: s.due_today ? 'Deadlines land today' : 'Nothing due today' },
    { label: 'Overdue',      value: s.overdue,       icon: 'alert',  accent: 'var(--critical)',
      foot: s.overdue ? 'Past their deadline' : 'All clear' },
    { label: 'High priority', value: s.high_priority, icon: 'flame', accent: 'var(--prio-high)',
      foot: 'Open and urgent' },
    { label: 'Pending',      value: s.pending,       icon: 'tasks',  accent: 'var(--series-2)',
      foot: `${s.completed} completed so far` },
  ];

  $('[data-slot="tiles"]').innerHTML = tiles.map((t) => `
    <article class="tile" style="--tile-accent:${t.accent}">
      <div class="tile__label">${Icons[t.icon]}${escapeHtml(t.label)}</div>
      <div class="tile__value">${t.value}</div>
      <div class="tile__foot">${escapeHtml(t.foot)}</div>
    </article>`).join('');
}

/* --- Activity: created vs completed, 14 days ------------------------------ */
function renderActivity(tasks) {
  const DAYS = 14;
  const days = [];

  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d);
  }

  const key = (d) => d.toISOString().slice(0, 10);
  const created = new Map(days.map((d) => [key(d), 0]));
  const completed = new Map(days.map((d) => [key(d), 0]));

  const bump = (map, iso) => {
    if (!iso) return;
    const k = String(iso).slice(0, 10);
    if (map.has(k)) map.set(k, map.get(k) + 1);
  };

  tasks.forEach((t) => {
    bump(created, t.created_at);
    bump(completed, t.completed_at);
  });

  lineChart($('[data-slot="chart-activity"]'), {
    labels: days.map((d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
    series: [
      { label: 'Created',   token: '--series-1', values: days.map((d) => created.get(key(d))) },
      { label: 'Completed', token: '--series-2', values: days.map((d) => completed.get(key(d))) },
    ],
    title: 'Activity',
  });
}

/* --- Priority: ordinal ramp, low → high ----------------------------------- */
function renderPriority(tasks) {
  const pending = tasks.filter((t) => t.status === 'pending');

  const rows = [
    { label: 'High',   token: '--prio-high',   value: pending.filter((t) => t.priority === 'high').length },
    { label: 'Medium', token: '--prio-medium', value: pending.filter((t) => t.priority === 'medium').length },
    { label: 'Low',    token: '--prio-low',    value: pending.filter((t) => t.priority === 'low').length },
  ];

  barChart($('[data-slot="chart-priority"]'), {
    rows, title: 'Open work by priority', unit: 'tasks', ordinal: true,
  });
}

/* --- Categories: one series, one colour ----------------------------------- */
function renderCategories(categories) {
  const rows = categories
    .map((c) => ({ label: c.name, value: c.stats?.pending ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  // Past ~7 classes adjacent bars blur — fold the tail rather than shrink it.
  const shown = rows.slice(0, 7);
  const rest = rows.slice(7);

  if (rest.length) {
    shown.push({ label: `Other (${rest.length})`, value: rest.reduce((a, b) => a + b.value, 0) });
  }

  const host = $('[data-slot="chart-categories"]');

  if (!shown.length) {
    host.innerHTML = '<p class="card__sub" style="margin:0">No open tasks in any goal right now.</p>';
    return;
  }

  barChart(host, { rows: shown, title: 'Open work by goal', unit: 'tasks' });
}

/* --- Up next -------------------------------------------------------------- */
function renderUpcoming(tasks) {
  const host = $('[data-slot="upcoming"]');

  const upcoming = tasks
    .filter((t) => t.status === 'pending' && t.due_at)
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .slice(0, 6);

  if (!upcoming.length) {
    host.replaceChildren(emptyState({
      title: 'Nothing scheduled',
      message: 'Give a task a due date and it will show up here.',
      actionLabel: 'New task',
      onAction: () => taskModal({ onSaved: load }),
    }));
    return;
  }

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th style="width:34px"></th><th>Task</th><th>Goal</th><th>Priority</th><th>Due</th></tr>
        </thead>
        <tbody>
          ${upcoming.map((t) => `
            <tr>
              <td>
                <button class="task-check" data-toggle="${t.id}" aria-pressed="false"
                        aria-label="Mark “${escapeHtml(t.title)}” complete">${Icons.check}</button>
              </td>
              <td>${escapeHtml(t.title)}</td>
              <td>
                <span class="cat-dot" style="background:${escapeHtml(t.category.color || 'var(--accent)')}"></span>
                ${escapeHtml(t.category.name ?? '—')}
              </td>
              <td><span class="pill pill--${t.priority}">${t.priority}</span></td>
              <td>
                ${t.is_overdue
                  ? `<span class="pill pill--overdue">${Icons.alert} ${escapeHtml(formatDate(t.due_at))}</span>`
                  : escapeHtml(dueLabel(t))}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await Api.tasks.toggle(btn.dataset.toggle);
        toast(res.message ?? 'Task completed.', 'ok');
        load();
      } catch {
        toast('Could not update that task.', 'error');
        btn.disabled = false;
      }
    });
  });
}

/* Midnight means "no particular time" — showing 00:00 is noise. */
function dueLabel(t) {
  const time = t.due_time && t.due_time !== '00:00' ? `, ${t.due_time}` : '';
  return `${formatDate(t.due_at)}${time}`;
}

/* --- Widget layout: order, width, size --------------------------------------
   Drag handles use Pointer Events so mouse, touch and pen all reorder the
   same way, with no HTML5 drag-and-drop ghost image to fight with. If a
   future release adds a widget that isn't in a saved order, it's appended
   at the end rather than disappearing. */
function loadWidgetOrder() {
  let saved;

  try {
    saved = JSON.parse(localStorage.getItem(WIDGET_ORDER_KEY) ?? 'null');
  } catch {
    return null;
  }

  if (!Array.isArray(saved)) return null;

  const known = saved.filter((id) => DEFAULT_WIDGET_ORDER.includes(id));
  const missing = DEFAULT_WIDGET_ORDER.filter((id) => !known.includes(id));

  return known.length ? [...known, ...missing] : null;
}

function applyWidgetOrder() {
  const grid = $('[data-slot="widgets"]');
  const order = loadWidgetOrder();

  (order ?? DEFAULT_WIDGET_ORDER).forEach((id) => {
    const widget = grid.querySelector(`[data-widget="${id}"]`);
    if (widget) grid.appendChild(widget);
  });
}

function saveWidgetOrder() {
  const order = [...$('[data-slot="widgets"]').querySelectorAll('[data-widget]')]
    .map((w) => w.dataset.widget);

  localStorage.setItem(WIDGET_ORDER_KEY, JSON.stringify(order));
  refreshResetButton();
}

function enableWidgetDragging() {
  const grid = $('[data-slot="widgets"]');

  grid.querySelectorAll('[data-drag-handle]').forEach((handle) => {
    handle.innerHTML = Icons.grip;

    handle.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const widget = handle.closest('[data-widget]');
      handle.setPointerCapture(event.pointerId);
      widget.classList.add('widget--dragging');

      const onMove = (moveEvent) => {
        const over = document
          .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          ?.closest('[data-widget]');

        if (!over || over === widget || over.parentNode !== grid) return;

        const rect = over.getBoundingClientRect();
        const before = moveEvent.clientX < rect.left + rect.width / 2;
        grid.insertBefore(widget, before ? over : over.nextSibling);
      };

      const onUp = () => {
        widget.classList.remove('widget--dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        saveWidgetOrder();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      event.preventDefault();
    });
  });
}

/* --- Width: normal (one grid column) vs full (spans every column) --------- */
function loadWidgetWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDGET_WIDTH_KEY) ?? 'null');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function applyWidgetWidths() {
  const widths = loadWidgetWidths();

  document.querySelectorAll('[data-widget]').forEach((widget) => {
    const id = widget.dataset.widget;
    if (id in widths) widget.classList.toggle('widget--full', widths[id]);
    syncWidthToggleButton(widget);
  });
}

function syncWidthToggleButton(widget) {
  const btn = widget.querySelector('[data-widget-toggle-width]');
  if (!btn) return;

  const full = widget.classList.contains('widget--full');
  btn.innerHTML = full ? Icons.minimize : Icons.maximize;
  btn.setAttribute('aria-label', `${full ? 'Narrow' : 'Widen'} ${widget.dataset.widget}`);
}

function enableWidgetWidthToggle() {
  document.querySelectorAll('[data-widget-toggle-width]').forEach((btn) => {
    const widget = btn.closest('[data-widget]');
    syncWidthToggleButton(widget);

    btn.addEventListener('click', () => {
      const full = !widget.classList.contains('widget--full');
      widget.classList.toggle('widget--full', full);
      syncWidthToggleButton(widget);

      const widths = loadWidgetWidths();
      widths[widget.dataset.widget] = full;
      localStorage.setItem(WIDGET_WIDTH_KEY, JSON.stringify(widths));
      refreshResetButton();
    });
  });
}

/* --- Height: native `resize: vertical` on card widgets --------------------
   The browser draws and drives the corner handle — no custom pointer-event
   code needed for the drag itself. But there is no standard "resize
   finished" event to hook, and (confirmed while testing this) a completed
   native resize does not reliably dispatch a plain mouseup on the element
   either — the drag is handled by the browser's own UA chrome, outside the
   normal event pipeline. ResizeObserver is the documented way around that:
   it fires on the actual box-size change regardless of what caused it. The
   `widget.style.height` guard below is what keeps it from misfiring on
   ordinary content growth (a table gaining rows, etc.) — nothing but a real
   resize (by the user here, or applyWidgetSizes()/resetLayout() reapplying
   one) ever sets that inline style, so an empty value means "not resized". */
function loadWidgetSizes() {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDGET_SIZE_KEY) ?? 'null');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function applyWidgetSizes() {
  const sizes = loadWidgetSizes();

  document.querySelectorAll('[data-widget].card').forEach((widget) => {
    const height = sizes[widget.dataset.widget];
    widget.style.height = height ?? '';
  });
}

function enableWidgetResizing() {
  document.querySelectorAll('[data-widget].card').forEach((widget) => {
    let resizeTimer;

    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const height = widget.style.height;
        if (!height) return;

        const sizes = loadWidgetSizes();
        if (sizes[widget.dataset.widget] === height) return;

        sizes[widget.dataset.widget] = height;
        localStorage.setItem(WIDGET_SIZE_KEY, JSON.stringify(sizes));
        refreshResetButton();
      }, 200);
    }).observe(widget);
  });
}

/* --- Shared: the "Reset layout" button only shows once something's been
   moved, widened, narrowed or resized. */
function refreshResetButton() {
  const customized = localStorage.getItem(WIDGET_ORDER_KEY) !== null
    || localStorage.getItem(WIDGET_WIDTH_KEY) !== null
    || localStorage.getItem(WIDGET_SIZE_KEY) !== null;

  $('[data-action="reset-layout"]').hidden = !customized;
}

function resetLayout() {
  localStorage.removeItem(WIDGET_ORDER_KEY);
  localStorage.removeItem(WIDGET_WIDTH_KEY);
  localStorage.removeItem(WIDGET_SIZE_KEY);

  // applyWidgetWidths()/applyWidgetSizes() only *override* entries present in
  // storage — with storage just cleared, that's nothing, so a widget the user
  // had widened or resized would otherwise be left exactly as they'd set it.
  // Reset every widget to its actual default explicitly.
  document.querySelectorAll('[data-widget]').forEach((widget) => {
    widget.classList.toggle('widget--full', DEFAULT_FULL_WIDGETS.has(widget.dataset.widget));
    widget.style.height = '';
    syncWidthToggleButton(widget);
  });

  applyWidgetOrder();
  refreshResetButton();
  toast('Layout reset.', 'ok');
}

/* --- Chrome helpers ------------------------------------------------------- */
function greeting(u) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = u.name?.split(' ')[0];
  return name ? `${part}, ${name}` : part;
}

function subtitle(s) {
  if (s.overdue)   return `${s.overdue} task${s.overdue > 1 ? 's' : ''} past due — worth a look first.`;
  if (s.due_today) return `${s.due_today} task${s.due_today > 1 ? 's' : ''} due today.`;
  if (s.pending)   return `${s.pending} open task${s.pending > 1 ? 's' : ''}, nothing overdue.`;
  return 'Queue is empty. Enjoy it.';
}

function showSkeletons() {
  $('[data-slot="tiles"]').innerHTML = Array.from({ length: 4 }, () =>
    '<div class="tile"><div class="skeleton" style="height:14px;width:60%"></div>'
    + '<div class="skeleton" style="height:34px;width:44%;margin-top:12px"></div></div>').join('');

  ['chart-activity', 'chart-priority', 'chart-categories'].forEach((slot, i) => {
    $(`[data-slot="${slot}"]`).innerHTML =
      `<div class="skeleton" style="height:${i ? 150 : 240}px"></div>`;
  });
}

load();
