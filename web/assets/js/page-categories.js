import { Api, requireAuth, signOut, ApiError } from './api.js';
import {
  Theme, Icons, renderShell, emptyState, escapeHtml,
  modal, toast, confirmDanger,
} from './ui.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'categories.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="new-category"]').innerHTML = `${Icons.plus}New goal`;
$('[data-action="new-category"]').addEventListener('click', () => categoryModal({}));

let selectMode = false;
let selected = new Set();
let currentCategories = [];

$('[data-action="toggle-select"]').addEventListener('click', () => {
  selectMode = !selectMode;
  selected.clear();
  render(currentCategories);
});

$('[data-action="select-all"]').addEventListener('click', () => {
  if (selected.size === currentCategories.length) selected.clear();
  else currentCategories.forEach((c) => selected.add(c.id));
  render(currentCategories);
});

$('[data-action="delete-selected"]').addEventListener('click', () => {
  if (selected.size) removeMany([...selected], currentCategories);
});

/* A goal's colour is decoration, not data encoding — the charts don't read it,
   so the user is free to pick anything. These are the on-brand starting points. */
const SWATCHES = [
  '#8b7cf6', '#22d3ee', '#f472b6', '#fbbf24',
  '#34d399', '#f87171', '#60a5fa', '#a78bfa',
  '#2dd4bf', '#fb923c', '#c084fc', '#94a3b8',
];

const GLYPHS = ['🎬', '💰', '🏠', '💪', '📚', '💼', '🎯', '🧪', '🎨', '🛒', '✈️', '🐾', '🎮', '🍳', '🌱', '⚙️'];

async function load() {
  const grid = $('[data-slot="grid"]');
  grid.innerHTML = Array.from({ length: 3 }, () =>
    '<div class="skeleton" style="height:150px;border-radius:14px"></div>').join('');

  try {
    const res = await Api.categories.list(true);
    render(res.data);
  } catch (err) {
    console.error(err);
    toast('Could not load your goals.', 'error');
  }
}

function render(categories) {
  currentCategories = categories;
  const grid = $('[data-slot="grid"]');

  $('[data-action="toggle-select"]').textContent = selectMode ? 'Cancel' : 'Select';
  $('[data-action="new-category"]').hidden = selectMode;
  updateBulkBar();

  $('[data-slot="subtitle"]').textContent = categories.length
    ? `${categories.length} goal${categories.length > 1 ? 's' : ''}.`
    : 'The buckets your tasks live in.';

  if (!categories.length) {
    grid.replaceChildren(emptyState({
      title: 'No goals yet',
      message: 'Goals group your tasks — YouTube, Finance, House Chores, whatever you are working on.',
      actionLabel: 'Create your first goal',
      onAction: () => categoryModal({}),
    }));
    grid.style.display = 'block';
    return;
  }

  grid.style.display = '';
  grid.innerHTML = categories.map((c) => card(c, selectMode, selected)).join('');

  grid.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const cat = categories.find((c) => c.id === Number(btn.dataset.edit));
      categoryModal({ category: cat });
    }));

  grid.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const cat = categories.find((c) => c.id === Number(btn.dataset.delete));
      remove(cat);
    }));

  grid.querySelectorAll('[data-select]').forEach((box) =>
    box.addEventListener('change', () => {
      const id = Number(box.dataset.select);
      if (box.checked) selected.add(id);
      else selected.delete(id);
      box.closest('.goal').classList.toggle('goal--selected', box.checked);
      updateBulkBar();
    }));
}

function updateBulkBar() {
  const bar = $('[data-slot="bulk-bar"]');
  bar.hidden = !selectMode;
  if (!selectMode) return;

  $('[data-slot="bulk-count"]').textContent =
    `${selected.size} selected`;
  $('[data-action="select-all"]').textContent =
    currentCategories.length && selected.size === currentCategories.length ? 'Deselect all' : 'Select all';
  $('[data-action="delete-selected"]').disabled = selected.size === 0;
}

function card(c, selectMode, selected) {
  const stats = c.stats ?? { total: 0, pending: 0, completed: 0 };
  const pct = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;
  const color = c.color || '#8b7cf6';
  const isSelected = selected.has(c.id);

  return `
    <article class="goal${isSelected ? ' goal--selected' : ''}" style="--goal-color:${escapeHtml(color)}">
      <div class="goal__top">
        <div class="goal__icon">${escapeHtml(c.icon || '🎯')}</div>
        <div style="min-width:0">
          <div class="goal__name">${escapeHtml(c.name)}</div>
          <div class="goal__count">${stats.total} task${stats.total === 1 ? '' : 's'}</div>
        </div>
        <div class="goal__actions">
          ${selectMode
            ? `<input type="checkbox" class="goal__select" data-select="${c.id}"
                      ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(c.name)}">`
            : `<button class="icon-btn" data-edit="${c.id}" aria-label="Edit ${escapeHtml(c.name)}">${Icons.edit}</button>
               <button class="icon-btn" data-delete="${c.id}" aria-label="Delete ${escapeHtml(c.name)}">${Icons.trash}</button>`}
        </div>
      </div>

      <div class="goal__rail" role="img"
           aria-label="${pct}% complete: ${stats.completed} of ${stats.total}">
        <span style="width:${pct}%"></span>
      </div>

      <div class="goal__legend">
        <span>${stats.pending} open</span>
        <span><b style="color:var(--text-primary)">${pct}%</b> done</span>
      </div>

      <a class="btn btn--ghost btn--sm" style="margin-top:14px;width:100%"
         href="tasks.html?category=${c.id}">View tasks</a>
    </article>`;
}

function categoryModal({ category = null }) {
  const editing = Boolean(category);
  const color = category?.color || SWATCHES[0];
  const icon = category?.icon || GLYPHS[0];

  const { dialog } = modal({
    title: editing ? 'Edit goal' : 'New goal',
    confirmLabel: editing ? 'Save changes' : 'Create goal',
    body: `
      <div class="field">
        <label for="c-name">Name</label>
        <input type="text" id="c-name" maxlength="100" required
               value="${escapeHtml(category?.name ?? '')}" placeholder="YouTube">
      </div>

      <div class="field">
        <label>Icon</label>
        <div class="icon-picker" role="group" aria-label="Icon">
          ${GLYPHS.map((g) => `
            <button type="button" class="icon-opt" data-icon="${g}"
                    aria-pressed="${g === icon}" aria-label="Icon ${g}">${g}</button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Colour</label>
        <div class="swatches" role="group" aria-label="Colour">
          ${SWATCHES.map((s) => `
            <button type="button" class="swatch" data-color="${s}" style="background:${s}"
                    aria-pressed="${s.toLowerCase() === color.toLowerCase()}"
                    aria-label="Colour ${s}"></button>`).join('')}
        </div>
        <span class="field__hint">
          Goal colours label your goals — charts use their own validated palette,
          so nothing you pick here can make a chart unreadable.
        </span>
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const name = dlg.querySelector('#c-name').value.trim();

      if (!name) {
        errorBox.textContent = 'A name is required.';
        errorBox.hidden = false;
        return false;
      }

      const payload = {
        name,
        icon: dlg.querySelector('[data-icon][aria-pressed="true"]')?.dataset.icon ?? null,
        color: dlg.querySelector('[data-color][aria-pressed="true"]')?.dataset.color ?? null,
      };

      try {
        if (editing) await Api.categories.update(category.id, payload);
        else await Api.categories.create(payload);

        toast(editing ? 'Goal updated.' : 'Goal created.', 'ok');
        load();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not save the goal.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  const single = (selector, attr) => {
    dialog.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll(selector).forEach((b) =>
          b.setAttribute('aria-pressed', String(b === btn)));
      });
    });
  };

  single('[data-icon]');
  single('[data-color]');
}

function remove(category) {
  const count = category.stats?.total ?? 0;

  confirmDanger({
    title: 'Delete goal',
    message: count
      ? `“${category.name}” and its ${count} task${count > 1 ? 's' : ''} will be deleted permanently.`
      : `“${category.name}” will be deleted permanently.`,
    onConfirm: async () => {
      try {
        await Api.categories.remove(category.id);
        toast('Goal deleted.', 'ok');
        load();
      } catch {
        toast('Could not delete that goal.', 'error');
      }
    },
  });
}

function removeMany(ids, categories) {
  const picked = categories.filter((c) => ids.includes(c.id));
  const totalTasks = picked.reduce((sum, c) => sum + (c.stats?.total ?? 0), 0);

  confirmDanger({
    title: `Delete ${ids.length} goal${ids.length > 1 ? 's' : ''}`,
    message: totalTasks
      ? `${ids.length} goals and their ${totalTasks} task${totalTasks > 1 ? 's' : ''} total will be deleted permanently.`
      : `${ids.length} goal${ids.length > 1 ? 's' : ''} will be deleted permanently.`,
    confirmLabel: `Delete ${ids.length}`,
    onConfirm: async () => {
      const results = await Promise.allSettled(ids.map((id) => Api.categories.remove(id)));
      const failed = results.filter((r) => r.status === 'rejected').length;

      if (failed === ids.length) toast('Could not delete the selected goals.', 'error');
      else if (failed) toast(`Deleted ${ids.length - failed} of ${ids.length}. ${failed} failed.`, 'error');
      else toast(`${ids.length} goal${ids.length > 1 ? 's' : ''} deleted.`, 'ok');

      selectMode = false;
      selected.clear();
      load();
    },
  });
}

load();
