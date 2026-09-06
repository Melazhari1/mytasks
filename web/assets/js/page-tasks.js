import { Api, requireAuth, signOut, ApiError } from './api.js';
import {
  Theme, Icons, renderShell, emptyState, escapeHtml,
  formatDate, reminderLabel, toast, confirmDanger,
} from './ui.js';
import { taskModal, getCategories } from './tasks-shared.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'tasks.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="new-task"]').innerHTML = `${Icons.plus}New task`;
$('[data-action="new-task"]').addEventListener('click', () => taskModal({ onSaved: load }));

/* --- Filter state --------------------------------------------------------- */
const filters = {
  date: '',
  status: 'pending',
  priority: '',
  category_id: '',
  search: '',
  sort: 'due_date',
  dir: 'asc',
  page: 1,
  per_page: 25,
};

document.querySelectorAll('[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-range]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));

    filters.date = btn.dataset.range;

    // "Overdue" only means anything among pending tasks.
    if (filters.date === 'overdue') {
      filters.status = 'pending';
      $('#f-status').value = 'pending';
    }

    filters.page = 1;
    load();
  });
});

const bind = (id, key, { resetPage = true } = {}) => {
  $(id).addEventListener('change', () => {
    filters[key] = $(id).value;
    if (key === 'sort') filters.dir = $(id).value === 'created_at' ? 'desc' : 'asc';
    if (resetPage) filters.page = 1;
    load();
  });
};

bind('#f-status', 'status');
bind('#f-priority', 'priority');
bind('#f-category', 'category_id');
bind('#f-sort', 'sort');

let searchTimer;
$('#f-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filters.search = event.target.value.trim();
    filters.page = 1;
    load();
  }, 280);
});

/* --- Load ----------------------------------------------------------------- */
(async () => {
  const categories = await getCategories();
  $('#f-category').insertAdjacentHTML('beforeend', categories.map((c) =>
    `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''));

  // "View tasks" on a goal card arrives as ?category=<id> — honour it once the
  // options exist, then reload so the list matches what the dropdown shows.
  const preset = new URLSearchParams(location.search).get('category');

  if (preset && categories.some((c) => String(c.id) === preset)) {
    filters.category_id = preset;
    $('#f-category').value = preset;
    load();
  }
})();

async function load() {
  const host = $('[data-slot="list"]');
  host.innerHTML = '<div style="padding:18px"><div class="skeleton" style="height:220px"></div></div>';

  try {
    const res = await Api.tasks.list(filters);
    render(res.data, res.meta);
  } catch (err) {
    console.error(err);
    toast('Could not load tasks.', 'error');
  }
}

function render(tasks, meta) {
  const host = $('[data-slot="list"]');

  $('[data-slot="subtitle"]').textContent = meta.total === 0
    ? 'Nothing matches these filters.'
    : `${meta.total} task${meta.total > 1 ? 's' : ''} matching.`;

  if (!tasks.length) {
    host.replaceChildren(emptyState({
      title: 'No tasks here',
      message: 'Either nothing matches these filters, or the queue really is empty.',
      actionLabel: 'New task',
      onAction: () => taskModal({ onSaved: load }),
    }));
    renderPager(meta);
    return;
  }

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width:38px"><span class="visually-hidden">Done</span></th>
            <th>Task</th>
            <th>Goal</th>
            <th>Priority</th>
            <th>Due</th>
            <th>Reminder</th>
            <th style="width:96px"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(row).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => toggle(btn.dataset.toggle, btn)));

  host.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const res = await Api.tasks.get(btn.dataset.edit);
      taskModal({ task: res.data, onSaved: load });
    }));

  host.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => remove(btn.dataset.delete, btn.dataset.title)));

  renderPager(meta);
}

/* Midnight means "no particular time" — showing 00:00 is noise. */
function dueLabel(t) {
  const time = t.due_time && t.due_time !== '00:00' ? `, ${t.due_time}` : '';
  return `${formatDate(t.due_at)}${time}`;
}

function row(t) {
  const done = t.status === 'completed';

  const due = !t.due_at
    ? '<span style="color:var(--text-muted)">—</span>'
    : t.is_overdue
      ? `<span class="pill pill--overdue">${Icons.alert} ${escapeHtml(formatDate(t.due_at))}</span>`
      : escapeHtml(dueLabel(t));

  const repeat = t.is_recurring
    ? `<span class="pill" style="border-color:var(--border-strong);color:var(--text-secondary)">
         ${Icons.refresh} ${escapeHtml(t.recurring_type ?? 'daily')}
       </span>`
    : '';

  return `
    <tr>
      <td>
        <button class="task-check" data-toggle="${t.id}" aria-pressed="${done}"
                aria-label="${done ? 'Reopen' : 'Complete'} “${escapeHtml(t.title)}”">${Icons.check}</button>
      </td>
      <td>
        <div class="${done ? 'task-title--done' : ''}" style="font-weight:600">${escapeHtml(t.title)}</div>
        ${t.description
          ? `<div style="font-size:.79rem;color:var(--text-muted);margin-top:2px">
               ${escapeHtml(t.description.slice(0, 90))}${t.description.length > 90 ? '…' : ''}
             </div>`
          : ''}
        ${repeat}
      </td>
      <td style="white-space:nowrap">
        <span class="cat-dot" style="background:${escapeHtml(t.category.color || 'var(--accent)')}"></span>
        ${escapeHtml(t.category.name ?? '—')}
      </td>
      <td><span class="pill pill--${t.priority}">${t.priority}</span></td>
      <td style="white-space:nowrap">${due}</td>
      <td style="font-size:.79rem;color:var(--text-muted);white-space:nowrap">
        ${escapeHtml(reminderLabel(t.notify_before_minutes))}
      </td>
      <td>
        <div class="rowactions">
          <button class="icon-btn" data-edit="${t.id}" aria-label="Edit task">${Icons.edit}</button>
          <button class="icon-btn" data-delete="${t.id}" data-title="${escapeHtml(t.title)}"
                  aria-label="Delete task">${Icons.trash}</button>
        </div>
      </td>
    </tr>`;
}

async function toggle(id, btn) {
  btn.disabled = true;
  try {
    const res = await Api.tasks.toggle(id);
    toast(res.message ?? 'Task updated.', 'ok');
    load();
  } catch (err) {
    toast(err instanceof ApiError ? err.detail : 'Could not update that task.', 'error');
    btn.disabled = false;
  }
}

function remove(id, title) {
  confirmDanger({
    title: 'Delete task',
    message: `“${title}” will be removed permanently. This cannot be undone.`,
    onConfirm: async () => {
      try {
        await Api.tasks.remove(id);
        toast('Task deleted.', 'ok');
        load();
      } catch {
        toast('Could not delete that task.', 'error');
      }
    },
  });
}

function renderPager(meta) {
  const host = $('[data-slot="pager"]');

  if (!meta || meta.total_pages <= 1) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = `
    <button class="btn btn--ghost btn--sm" data-page="prev" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button>
    <span style="font-size:.83rem;color:var(--text-muted)">Page ${meta.page} of ${meta.total_pages}</span>
    <button class="btn btn--ghost btn--sm" data-page="next"
            ${meta.page >= meta.total_pages ? 'disabled' : ''}>Next</button>`;

  host.querySelector('[data-page="prev"]')?.addEventListener('click', () => { filters.page--; load(); });
  host.querySelector('[data-page="next"]')?.addEventListener('click', () => { filters.page++; load(); });
}

load();
