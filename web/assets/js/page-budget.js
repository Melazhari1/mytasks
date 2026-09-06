import { Api, requireAuth, signOut, ApiError } from './api.js';
import {
  Theme, Icons, renderShell, escapeHtml,
  modal, toast, confirmDanger, BUDGET_CATEGORIES, categoryPill, scoreColor,
} from './ui.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'budget.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="new-entry"]').innerHTML = `${Icons.plus}Add entry`;
$('[data-action="new-entry"]').addEventListener('click', () => entryModal({ onSaved: load }));

/* --- Period state ------------------------------------------------------------- */
const now = new Date();
const period = { year: now.getFullYear(), month: now.getMonth() + 1 };

const yearSelect = $('#b-year');
for (let y = now.getFullYear() - 3; y <= now.getFullYear() + 1; y++) {
  yearSelect.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
}
yearSelect.value = String(period.year);
$('#b-month').value = String(period.month);

$('#b-month').addEventListener('change', (e) => { period.month = Number(e.target.value); load(); });
$('#b-year').addEventListener('change', (e) => { period.year = Number(e.target.value); load(); });

$('[data-action="save-salary"]').addEventListener('click', async () => {
  const value = Number($('#b-salary').value);

  if (!Number.isFinite(value) || value < 0) {
    toast('Enter a valid salary.', 'error');
    return;
  }

  try {
    await Api.budget.setSalary(period.year, period.month, value);
    toast('Salary saved.', 'ok');
    load();
  } catch (err) {
    toast(err instanceof ApiError ? err.detail : 'Could not save the salary.', 'error');
  }
});

/* --- Load / render ------------------------------------------------------------- */
let current = null;

async function load() {
  try {
    const res = await Api.budget.getMonth(period.year, period.month);
    current = res.data;
    render(current);
  } catch (err) {
    console.error(err);
    toast('Could not load this month’s budget.', 'error');
  }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function render(data) {
  $('[data-slot="subtitle"]').textContent =
    `${MONTH_NAMES[data.month - 1]} ${data.year} — salary ${money(data.salary)}, ${money(data.total_spent)} logged.`;

  $('#b-salary').value = data.salary || '';

  renderScore(data);
  renderBreakdown(data);
  renderEntries(data.entries);
}

function renderScore(data) {
  const tile = $('.tile');
  const color = scoreColor(data.score);
  tile.style.setProperty('--tile-accent', color);

  $('[data-slot="score"]').innerHTML = `${data.score ?? '—'}<span class="budget-score__scale"> / 5</span>`;
  $('[data-slot="score"]').style.color = color;

  const note = $('[data-slot="score-note"]');
  if (data.score === null) {
    note.textContent = 'Set a salary to get a score.';
  } else if (data.score >= 4.5) {
    note.textContent = 'Right on the 50/30/20 split.';
  } else if (data.score >= 3.5) {
    note.textContent = 'Close to the plan, minor drift.';
  } else if (data.score >= 2) {
    note.textContent = 'Noticeable drift from the standard split.';
  } else {
    note.textContent = 'Way off the 50/30/20 split this month.';
  }
}

function renderBreakdown(data) {
  const host = $('[data-slot="breakdown"]');

  host.innerHTML = BUDGET_CATEGORIES.map((c) => {
    const cat = data.categories[c.key];
    const realWidth = Math.min(100, Math.max(0, cat.real_pct * 100));
    const targetLeft = cat.target_pct * 100;

    return `
      <div class="breakdown-row">
        ${categoryPill(c.key)}
        <div class="breakdown-row__bar" title="${escapeHtml(c.label)}: ${money(cat.real_amount)} vs target ${money(cat.target_amount)}">
          <div class="breakdown-row__real" style="width:${realWidth}%;background:${c.color}"></div>
          <div class="breakdown-row__target" style="left:${targetLeft}%"></div>
        </div>
        <div class="breakdown-row__nums">
          <b>${money(cat.real_amount)}</b> / ${money(cat.target_amount)} target
        </div>
      </div>`;
  }).join('');
}

function renderEntries(entries) {
  const host = $('[data-slot="entries"]');

  if (!entries.length) {
    host.innerHTML = `<div style="padding:24px 20px;color:var(--text-muted);text-align:center">
                         No entries yet for this month. Add what you spent, tagged need / want / save.
                       </div>`;
    return;
  }

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>Name</th><th>Category</th><th>Price</th><th style="width:96px"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>
          ${entries.map(row).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const entry = entries.find((e) => e.id === Number(btn.dataset.edit));
      entryModal({ entry, onSaved: load });
    }));

  host.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const entry = entries.find((e) => e.id === Number(btn.dataset.delete));
      remove(entry);
    }));
}

function row(entry) {
  return `
    <tr>
      <td style="font-weight:600">${escapeHtml(entry.name)}</td>
      <td>${categoryPill(entry.category)}</td>
      <td>${money(entry.price)}</td>
      <td>
        <div class="rowactions">
          <button class="icon-btn" data-edit="${entry.id}" aria-label="Edit ${escapeHtml(entry.name)}">${Icons.edit}</button>
          <button class="icon-btn" data-delete="${entry.id}" aria-label="Delete ${escapeHtml(entry.name)}">${Icons.trash}</button>
        </div>
      </td>
    </tr>`;
}

function money(n) {
  return `${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD`;
}

/* --- Create / edit entry modal -------------------------------------------------- */
function entryModal({ entry = null, onSaved }) {
  const editing = Boolean(entry);

  const { dialog } = modal({
    title: editing ? 'Edit entry' : 'New entry',
    confirmLabel: editing ? 'Save changes' : 'Add entry',
    body: `
      <div class="field">
        <label for="e-name">Name</label>
        <input type="text" id="e-name" maxlength="150" required
               value="${escapeHtml(entry?.name ?? '')}" placeholder="Rent, groceries, savings transfer…">
      </div>

      <div class="form-row">
        <div class="field">
          <label for="e-price">Price</label>
          <input type="number" id="e-price" min="0" step="0.01" required value="${entry?.price ?? ''}">
        </div>

        <div class="field">
          <label for="e-category">Category</label>
          <select id="e-category">
            ${BUDGET_CATEGORIES.map((c) => `
              <option value="${c.key}" ${(entry?.category ?? 'need') === c.key ? 'selected' : ''}>
                ${escapeHtml(c.label)}
              </option>`).join('')}
          </select>
        </div>
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const name = dlg.querySelector('#e-name').value.trim();
      const price = Number(dlg.querySelector('#e-price').value);

      if (!name) {
        errorBox.textContent = 'A name is required.';
        errorBox.hidden = false;
        return false;
      }

      if (!Number.isFinite(price) || price < 0) {
        errorBox.textContent = 'Enter a valid price.';
        errorBox.hidden = false;
        return false;
      }

      const payload = { name, price, category: dlg.querySelector('#e-category').value };

      try {
        if (editing) await Api.budget.updateEntry(entry.id, payload);
        else await Api.budget.addEntry(period.year, period.month, payload);

        toast(editing ? 'Entry updated.' : 'Entry added.', 'ok');
        onSaved?.();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not save that entry.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

function remove(entry) {
  confirmDanger({
    title: 'Delete entry',
    message: `“${entry.name}” will be removed permanently. This cannot be undone.`,
    onConfirm: async () => {
      try {
        await Api.budget.removeEntry(entry.id);
        toast('Entry deleted.', 'ok');
        load();
      } catch {
        toast('Could not delete that entry.', 'error');
      }
    },
  });
}

load();
