import { Api, requireAuth, signOut, ApiError, Session } from './api.js';
import {
  Theme, Icons, renderShell, emptyState, escapeHtml,
  modal, toast, confirmDanger, copyToClipboard, formatDateTime,
} from './ui.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

const user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'vault.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

$('[data-action="new-entry"]').innerHTML = `${Icons.plus}New entry`;
$('[data-action="generate"]').innerHTML = `${Icons.key}Generate`;
$('[data-action="import"]').innerHTML = `${Icons.upload}Import CSV`;
$('[data-action="new-entry"]').addEventListener('click', () => entryModal({}));
$('[data-action="generate"]').addEventListener('click', generatorModal);
$('[data-action="import"]').addEventListener('click', () => $('[data-slot="import-file"]').click());
$('[data-slot="import-file"]').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) importCsv(file);
});

let entries = [];
let lockTimer;

/* --- Lock bar -------------------------------------------------------------
   The unlock token lives in memory only and expires after five minutes; the
   bar counts it down so the state is never a surprise.                      */
function renderLockbar() {
  const bar = $('[data-slot="lockbar"]');
  const unlocked = Session.vaultUnlocked;

  bar.dataset.state = unlocked ? 'unlocked' : 'locked';

  if (unlocked) {
    const seconds = Math.max(0, Math.round((Session.vaultExpiresAt - Date.now()) / 1000));
    bar.innerHTML = `
      ${Icons.unlock}
      <div>
        <b>Vault unlocked</b>
        <div style="font-size:.79rem;color:var(--text-secondary)">
          Re-locks automatically in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}
        </div>
      </div>
      <button class="btn btn--ghost btn--sm" data-action="lock">${Icons.lock}Lock now</button>`;

    bar.querySelector('[data-action="lock"]').addEventListener('click', () => {
      Session.lockVault();
      render();
      toast('Vault locked.', 'ok');
    });
  } else {
    bar.innerHTML = `
      ${Icons.lock}
      <div>
        <b>Vault locked</b>
        <div style="font-size:.79rem;color:var(--text-secondary)">
          Passwords stay encrypted until you unlock. Being signed in is not enough.
        </div>
      </div>
      <button class="btn btn--primary btn--sm" data-action="unlock">${Icons.unlock}Unlock</button>`;

    bar.querySelector('[data-action="unlock"]').addEventListener('click', unlockModal);
  }

  clearTimeout(lockTimer);

  if (unlocked) {
    lockTimer = setTimeout(() => {
      if (!Session.vaultUnlocked) {
        toast('Vault re-locked.', 'info');
        render();
      } else {
        renderLockbar();
      }
    }, 1000);
  }
}

function unlockModal() {
  const hasMaster = user.vault_locked_by_master_password;

  const { dialog } = modal({
    title: 'Unlock the vault',
    confirmLabel: 'Unlock',
    body: `
      <p class="card__sub" style="margin-bottom:16px">
        ${hasMaster
          ? 'Enter your master password, or send a one-time code to your email.'
          : 'No master password is set, so your account password unlocks the vault. You can set a dedicated one in Settings.'}
      </p>

      <div class="field">
        <label for="u-secret">${hasMaster ? 'Master password' : 'Account password'}</label>
        <input type="password" id="u-secret" autocomplete="current-password" placeholder="••••••••">
      </div>

      <div class="field">
        <label for="u-otp">Or a one-time code</label>
        <div style="display:flex;gap:9px">
          <input type="text" id="u-otp" inputmode="numeric" maxlength="6" placeholder="000000">
          <button type="button" class="btn btn--ghost" data-action="send-otp" style="white-space:nowrap">
            ${Icons.mail}Email me one
          </button>
        </div>
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const secret = dlg.querySelector('#u-secret').value;
      const otp = dlg.querySelector('#u-otp').value.trim();

      if (!secret && !otp) {
        errorBox.textContent = 'Enter a password or a one-time code.';
        errorBox.hidden = false;
        return false;
      }

      const payload = otp
        ? { otp }
        : hasMaster ? { master_password: secret } : { password: secret };

      try {
        await Api.vault.unlock(payload);
        toast('Vault unlocked for 5 minutes.', 'ok');
        render();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Unlock failed.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  dialog.querySelector('[data-action="send-otp"]').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await Api.vault.requestUnlockOtp();
      toast('Code sent. With MAIL_DRIVER=log, read it in api/storage/logs/mail.log.', 'info', 7000);
    } catch (err) {
      toast(err instanceof ApiError ? err.detail : 'Could not send a code.', 'error');
    } finally {
      setTimeout(() => { event.target.disabled = false; }, 15000);
    }
  });
}

/* --- List ----------------------------------------------------------------- */
async function load(search = '') {
  const host = $('[data-slot="list"]');
  host.innerHTML = '<div style="padding:18px"><div class="skeleton" style="height:200px"></div></div>';

  try {
    const res = await Api.vault.list(search || undefined);
    entries = res.data;
    render();
  } catch (err) {
    console.error(err);
    toast('Could not load the vault.', 'error');
  }
}

function render() {
  renderLockbar();

  const host = $('[data-slot="list"]');

  $('[data-slot="subtitle"]').textContent = entries.length
    ? `${entries.length} credential${entries.length > 1 ? 's' : ''} stored.`
    : 'Credentials, encrypted at rest.';

  if (!entries.length) {
    host.replaceChildren(emptyState({
      title: 'The vault is empty',
      message: 'Store a platform, a username and a password. The password is encrypted before it is saved.',
      actionLabel: 'Add a credential',
      onAction: () => entryModal({}),
    }));
    return;
  }

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Platform</th><th>Username</th><th>Password</th>
            <th>Last revealed</th><th style="width:96px"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((e) => `
            <tr data-row="${e.id}">
              <td>
                <div style="font-weight:600">${escapeHtml(e.platform_name)}</div>
                ${e.platform_url
                  ? `<a href="${escapeHtml(e.platform_url)}" target="_blank" rel="noopener noreferrer"
                        style="font-size:.77rem">${escapeHtml(shortUrl(e.platform_url))}</a>`
                  : ''}
                ${e.notes
                  ? `<div style="font-size:.77rem;color:var(--text-muted);margin-top:2px">
                       ${escapeHtml(e.notes.slice(0, 70))}${e.notes.length > 70 ? '…' : ''}
                     </div>`
                  : ''}
              </td>
              <td>
                <span class="secret">${escapeHtml(e.username)}</span>
                <button class="icon-btn" data-copy-user="${e.id}" style="margin-left:6px"
                        aria-label="Copy username">${Icons.copy}</button>
              </td>
              <td data-cell="pw-${e.id}">
                <span class="secret secret--masked">••••••••••</span>
              </td>
              <td style="font-size:.79rem;color:var(--text-muted);white-space:nowrap">
                ${escapeHtml(e.last_revealed_at ? formatDateTime(e.last_revealed_at) : 'Never')}
              </td>
              <td>
                <div class="rowactions">
                  <button class="icon-btn" data-reveal="${e.id}" aria-label="Reveal password">${Icons.eye}</button>
                  <button class="icon-btn" data-edit="${e.id}" aria-label="Edit entry">${Icons.edit}</button>
                  <button class="icon-btn" data-delete="${e.id}" aria-label="Delete entry">${Icons.trash}</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-reveal]').forEach((btn) =>
    btn.addEventListener('click', () => reveal(Number(btn.dataset.reveal), btn)));

  host.querySelectorAll('[data-copy-user]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const entry = entries.find((e) => e.id === Number(btn.dataset.copyUser));
      const ok = await copyToClipboard(entry.username);
      toast(ok ? 'Username copied.' : 'Could not copy.', ok ? 'ok' : 'error');
    }));

  host.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () =>
      entryModal({ entry: entries.find((e) => e.id === Number(btn.dataset.edit)) })));

  host.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () =>
      remove(entries.find((e) => e.id === Number(btn.dataset.delete)))));
}

async function reveal(id, btn) {
  if (!Session.vaultUnlocked) {
    toast('Unlock the vault first.', 'error');
    unlockModal();
    return;
  }

  const cell = $(`[data-cell="pw-${id}"]`);
  btn.disabled = true;

  try {
    const res = await Api.vault.reveal(id);
    const password = res.data.password;

    cell.innerHTML = `
      <span class="secret" data-plain>${escapeHtml(password)}</span>
      <button class="icon-btn" data-copy style="margin-left:6px" aria-label="Copy password">${Icons.copy}</button>`;

    cell.querySelector('[data-copy]').addEventListener('click', async () => {
      const ok = await copyToClipboard(password);
      toast(ok ? 'Password copied. Clear your clipboard when you are done.' : 'Could not copy.',
        ok ? 'ok' : 'error');
    });

    btn.innerHTML = Icons.eyeOff;
    btn.setAttribute('aria-label', 'Hide password');
    btn.disabled = false;

    const hide = () => {
      cell.innerHTML = '<span class="secret secret--masked">••••••••••</span>';
      btn.innerHTML = Icons.eye;
      btn.setAttribute('aria-label', 'Reveal password');
      btn.replaceWith(btn.cloneNode(true));
      render();
    };

    btn.addEventListener('click', hide, { once: true });

    // Never leave a password sitting on screen indefinitely.
    setTimeout(() => { if (document.contains(cell)) hide(); }, 30000);
  } catch (err) {
    toast(err instanceof ApiError ? err.detail : 'Could not reveal that password.', 'error');
    btn.disabled = false;

    if (err instanceof ApiError && (err.status === 403 || err.code === 'vault_locked')) {
      Session.lockVault();
      renderLockbar();
    }
  }
}

/* --- Create / edit -------------------------------------------------------- */
function entryModal({ entry = null }) {
  const editing = Boolean(entry);

  const { dialog } = modal({
    title: editing ? 'Edit credential' : 'New credential',
    confirmLabel: editing ? 'Save changes' : 'Save securely',
    body: `
      <div class="field">
        <label for="v-platform">Platform</label>
        <input type="text" id="v-platform" maxlength="150" required
               value="${escapeHtml(entry?.platform_name ?? '')}" placeholder="GitHub">
      </div>

      <div class="field">
        <label for="v-url">Website <span style="text-transform:none;font-weight:400">(optional)</span></label>
        <input type="url" id="v-url" maxlength="255"
               value="${escapeHtml(entry?.platform_url ?? '')}" placeholder="https://github.com">
      </div>

      <div class="field">
        <label for="v-username">Username or email</label>
        <input type="text" id="v-username" maxlength="150" required autocomplete="off"
               value="${escapeHtml(entry?.username ?? '')}" placeholder="melazhari">
      </div>

      <div class="field">
        <label for="v-password">Password</label>
        <div style="display:flex;gap:9px">
          <input type="password" id="v-password" maxlength="1000" autocomplete="new-password"
                 placeholder="${editing ? 'Leave blank to keep the current one' : '••••••••'}">
          <button type="button" class="icon-btn" data-action="peek" aria-label="Show password"></button>
          <button type="button" class="btn btn--ghost" data-action="gen" style="white-space:nowrap">
            ${Icons.refresh}Generate
          </button>
        </div>
      </div>

      <div class="field">
        <label for="v-notes">Notes</label>
        <textarea id="v-notes" maxlength="5000"
                  placeholder="Recovery email, security questions…">${escapeHtml(entry?.notes ?? '')}</textarea>
      </div>

      <div class="alert alert--info">
        ${Icons.shield}
        <div>Encrypted with AES-256 before it reaches the database. Not even the list view can read it back.</div>
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const platform = dlg.querySelector('#v-platform').value.trim();
      const username = dlg.querySelector('#v-username').value.trim();
      const password = dlg.querySelector('#v-password').value;

      if (!platform || !username) {
        errorBox.textContent = 'Platform and username are both required.';
        errorBox.hidden = false;
        return false;
      }

      if (!editing && !password) {
        errorBox.textContent = 'A password is required.';
        errorBox.hidden = false;
        return false;
      }

      const payload = {
        platform_name: platform,
        platform_url: dlg.querySelector('#v-url').value.trim() || null,
        username,
        notes: dlg.querySelector('#v-notes').value.trim() || null,
      };

      if (password) payload.password = password;

      try {
        if (editing) await Api.vault.update(entry.id, payload);
        else await Api.vault.create(payload);

        toast(editing ? 'Credential updated.' : 'Credential stored.', 'ok');
        load($('#v-search').value.trim());
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not save.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  const field = dialog.querySelector('#v-password');
  const peek = dialog.querySelector('[data-action="peek"]');
  peek.innerHTML = Icons.eye;

  peek.addEventListener('click', () => {
    const showing = field.type === 'text';
    field.type = showing ? 'password' : 'text';
    peek.innerHTML = showing ? Icons.eye : Icons.eyeOff;
  });

  dialog.querySelector('[data-action="gen"]').addEventListener('click', async () => {
    try {
      const res = await Api.vault.generate(20, true);
      field.type = 'text';
      field.value = res.data.password;
      peek.innerHTML = Icons.eyeOff;
    } catch {
      toast('Could not generate a password.', 'error');
    }
  });
}

function remove(entry) {
  confirmDanger({
    title: 'Delete credential',
    message: `The stored password for “${entry.platform_name}” will be destroyed. There is no recovery.`,
    onConfirm: async () => {
      try {
        await Api.vault.remove(entry.id);
        toast('Credential deleted.', 'ok');
        load($('#v-search').value.trim());
      } catch {
        toast('Could not delete that entry.', 'error');
      }
    },
  });
}

/* --- Import from CSV --------------------------------------------------------
   Reads the file entirely client-side and reuses the normal POST /vault create
   call per row — the server never sees a CSV, only the same shape it already
   validates and encrypts one entry at a time.

   Column names are matched by alias so exports from Chrome, Bitwarden, or a
   hand-rolled sheet all work without the user renaming headers. A file with no
   recognisable header falls back to a fixed column order. */
const CSV_ALIASES = {
  platform_name: ['platform', 'platform_name', 'name', 'title', 'site', 'account'],
  platform_url:  ['url', 'platform_url', 'login_uri', 'website', 'site_url'],
  username:      ['username', 'login_username', 'user', 'email', 'login'],
  password:      ['password', 'login_password', 'pass'],
  notes:         ['notes', 'note', 'extra', 'comment', 'comments'],
};
const CSV_FALLBACK_ORDER = ['platform_name', 'platform_url', 'username', 'password', 'notes'];

/** Minimal RFC 4180 parser: quoted fields, "" escapes, CRLF or LF. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* swallow, \n ends the row */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function parseVaultCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(CSV_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = idx;
  }

  const hasHeader = map.platform_name !== undefined || map.username !== undefined || map.password !== undefined;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) CSV_FALLBACK_ORDER.forEach((field, idx) => { map[field] = idx; });

  return dataRows.map((cols) => ({
    platform_name: (cols[map.platform_name] ?? '').trim(),
    platform_url:  (cols[map.platform_url] ?? '').trim(),
    username:      (cols[map.username] ?? '').trim(),
    password:      (cols[map.password] ?? '').trim(),
    notes:         (cols[map.notes] ?? '').trim(),
  }));
}

async function importCsv(file) {
  const text = await file.text();
  const rows = parseVaultCsv(text);

  const valid = rows.filter((r) => r.platform_name && r.username && r.password);
  const skipped = rows.length - valid.length;

  if (!valid.length) {
    toast('No usable rows found. Expect columns for platform, username and password.', 'error');
    return;
  }

  modal({
    title: 'Import from CSV',
    confirmLabel: `Import ${valid.length}`,
    body: `
      <p class="card__sub">
        Found <b>${valid.length}</b> credential${valid.length > 1 ? 's' : ''} in “${escapeHtml(file.name)}”.
        ${skipped ? `${skipped} row${skipped > 1 ? 's' : ''} skipped — missing platform, username or password.` : ''}
      </p>
      <div class="alert alert--info">
        ${Icons.shield}
        <div>Each password is encrypted before it reaches the database, the same as adding one by hand.</div>
      </div>
      <p data-slot="import-progress" style="margin-top:12px;font-size:.85rem;color:var(--text-secondary)"></p>`,

    onConfirm: async (dlg) => {
      const progress = dlg.querySelector('[data-slot="import-progress"]');
      let done = 0;
      let failed = 0;

      for (const entry of valid) {
        progress.textContent = `Importing ${done + 1} of ${valid.length}…`;

        try {
          await Api.vault.create({
            platform_name: entry.platform_name,
            platform_url: entry.platform_url || null,
            username: entry.username,
            password: entry.password,
            notes: entry.notes || null,
          });
        } catch {
          failed++;
        }

        done++;
      }

      if (failed === valid.length) toast('Could not import any of those credentials.', 'error');
      else if (failed) toast(`Imported ${valid.length - failed} of ${valid.length}. ${failed} failed.`, 'error');
      else toast(`Imported ${valid.length} credential${valid.length > 1 ? 's' : ''}.`, 'ok');

      load($('#v-search').value.trim());
    },
  });
}

/* --- Standalone generator ------------------------------------------------- */
function generatorModal() {
  const { dialog } = modal({
    title: 'Password generator',
    cancelLabel: 'Close',
    body: `
      <div class="field">
        <label for="g-length">Length: <span data-slot="g-len">20</span></label>
        <input type="range" id="g-length" min="8" max="64" value="20" style="padding:0">
      </div>

      <div class="field">
        <label class="checkline"><input type="checkbox" id="g-symbols" checked> Include symbols</label>
      </div>

      <div class="field">
        <label>Result</label>
        <div style="display:flex;gap:9px;align-items:center">
          <span class="secret" data-slot="g-out" style="flex:1">—</span>
          <button type="button" class="icon-btn" data-action="g-copy" aria-label="Copy">${Icons.copy}</button>
        </div>
      </div>

      <button type="button" class="btn btn--primary btn--block" data-action="g-run">
        ${Icons.refresh}Generate
      </button>

      <p class="field__hint" style="margin-top:14px">
        Generated server-side from a cryptographic RNG, not <code>Math.random()</code>.
      </p>`,
  });

  const out = dialog.querySelector('[data-slot="g-out"]');
  const lengthInput = dialog.querySelector('#g-length');

  lengthInput.addEventListener('input', () => {
    dialog.querySelector('[data-slot="g-len"]').textContent = lengthInput.value;
  });

  const run = async () => {
    try {
      const res = await Api.vault.generate(Number(lengthInput.value), dialog.querySelector('#g-symbols').checked);
      out.textContent = res.data.password;
    } catch {
      toast('Could not generate a password.', 'error');
    }
  };

  dialog.querySelector('[data-action="g-run"]').addEventListener('click', run);
  dialog.querySelector('[data-action="g-copy"]').addEventListener('click', async () => {
    if (out.textContent === '—') return;
    const ok = await copyToClipboard(out.textContent);
    toast(ok ? 'Copied.' : 'Could not copy.', ok ? 'ok' : 'error');
  });

  run();
}

function shortUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

let searchTimer;
$('#v-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(event.target.value.trim()), 280);
});

load();
