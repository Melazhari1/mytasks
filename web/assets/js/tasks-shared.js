/* Task create/edit dialog, shared by the dashboard and the tasks page. */

import { Api, ApiError } from './api.js';
import { modal, toast, escapeHtml } from './ui.js';

let categoryCache = null;

export async function getCategories(force = false) {
  if (!categoryCache || force) {
    const res = await Api.categories.list(false);
    categoryCache = res.data;
  }
  return categoryCache;
}

const REMINDERS = [
  ['',     'No reminder'],
  ['0',    'At the deadline'],
  ['15',   '15 minutes before'],
  ['30',   '30 minutes before'],
  ['60',   '1 hour before'],
  ['180',  '3 hours before'],
  ['1440', '1 day before'],
  ['2880', '2 days before'],
];

export async function taskModal({ task = null, onSaved, presetCategory = null } = {}) {
  const categories = await getCategories();

  if (!categories.length) {
    return modal({
      title: 'Create a goal first',
      body: `<div class="alert alert--info">Every task belongs to a goal. Add one, then come back.</div>`,
      confirmLabel: 'Go to goals',
      onConfirm: () => { location.href = 'categories.html'; },
    });
  }

  const editing = Boolean(task);
  const selectedCategory = task?.category?.id ?? presetCategory ?? categories[0].id;

  const body = `
    <div class="field">
      <label for="t-title">Title</label>
      <input type="text" id="t-title" maxlength="255" required
             value="${escapeHtml(task?.title ?? '')}" placeholder="Edit the thumbnail">
    </div>

    <div class="form-row">
      <div class="field">
        <label for="t-category">Goal</label>
        <select id="t-category">
          ${categories.map((c) => `
            <option value="${c.id}" ${c.id === selectedCategory ? 'selected' : ''}>
              ${escapeHtml(c.name)}
            </option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label for="t-priority">Priority</label>
        <select id="t-priority">
          ${['low', 'medium', 'high'].map((p) => `
            <option value="${p}" ${p === (task?.priority ?? 'medium') ? 'selected' : ''}>
              ${p[0].toUpperCase()}${p.slice(1)}
            </option>`).join('')}
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="field">
        <label for="t-date">Due date</label>
        <input type="date" id="t-date" value="${escapeHtml(task?.due_date ?? '')}">
      </div>

      <div class="field">
        <label for="t-time">Due time</label>
        <input type="time" id="t-time" value="${escapeHtml(task?.due_time ?? '')}">
      </div>
    </div>

    <div class="field">
      <label for="t-remind">Reminder</label>
      <select id="t-remind">
        ${REMINDERS.map(([value, label]) => `
          <option value="${value}" ${String(task?.notify_before_minutes ?? '') === value ? 'selected' : ''}>
            ${label}
          </option>`).join('')}
      </select>
      <span class="field__hint">Reminders need a due date to count back from.</span>
    </div>

    <div class="field">
      <label class="checkline">
        <input type="checkbox" id="t-recurring" ${task?.is_recurring ? 'checked' : ''}>
        Repeats
      </label>
    </div>

    <div class="field" id="t-recur-wrap" ${task?.is_recurring ? '' : 'hidden'}>
      <label for="t-recur-type">Repeat every</label>
      <select id="t-recur-type">
        <option value="daily"  ${task?.recurring_type === 'daily'  ? 'selected' : ''}>Day</option>
        <option value="weekly" ${task?.recurring_type === 'weekly' ? 'selected' : ''}>Week</option>
      </select>
      <span class="field__hint">
        Completing a repeating task rolls its due date forward instead of closing it.
      </span>
    </div>

    <div class="field">
      <label for="t-notes">Notes</label>
      <textarea id="t-notes" maxlength="5000"
                placeholder="Optional">${escapeHtml(task?.description ?? '')}</textarea>
    </div>

    <div class="alert alert--error" data-slot="modal-error" hidden></div>`;

  const { dialog } = modal({
    title: editing ? 'Edit task' : 'New task',
    body,
    confirmLabel: editing ? 'Save changes' : 'Create task',
    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const title = dlg.querySelector('#t-title').value.trim();

      if (!title) {
        errorBox.textContent = 'A title is required.';
        errorBox.hidden = false;
        return false;
      }

      const recurring = dlg.querySelector('#t-recurring').checked;
      const date = dlg.querySelector('#t-date').value;
      const remind = dlg.querySelector('#t-remind').value;

      if (recurring && !date) {
        errorBox.textContent = 'A repeating task needs a due date to repeat from.';
        errorBox.hidden = false;
        return false;
      }

      if (remind !== '' && !date) {
        errorBox.textContent = 'A reminder needs a due date to count back from.';
        errorBox.hidden = false;
        return false;
      }

      const payload = {
        title,
        category_id: Number(dlg.querySelector('#t-category').value),
        priority: dlg.querySelector('#t-priority').value,
        description: dlg.querySelector('#t-notes').value.trim() || null,
        due_date: date || null,
        due_time: dlg.querySelector('#t-time').value || null,
        notify_before_minutes: remind === '' ? null : Number(remind),
        is_recurring: recurring,
        recurring_type: recurring ? dlg.querySelector('#t-recur-type').value : null,
      };

      try {
        if (editing) await Api.tasks.update(task.id, payload);
        else await Api.tasks.create(payload);

        toast(editing ? 'Task updated.' : 'Task created.', 'ok');
        onSaved?.();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not save the task.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  dialog.querySelector('#t-recurring').addEventListener('change', (e) => {
    dialog.querySelector('#t-recur-wrap').hidden = !e.target.checked;
  });
}
