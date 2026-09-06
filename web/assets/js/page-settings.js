import { Api, requireAuth, signOut, ApiError, Session } from './api.js';
import { toSvg as qrSvg } from './qr.js';
import {
  Theme, Icons, renderShell, escapeHtml, modal,
  toast, confirmDanger, copyToClipboard, formatDateTime,
} from './ui.js';
import { initChatBox } from './chatbox.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);

let user = await requireAuth();
if (!user) throw new Error('redirecting');

renderShell({ active: 'settings.html', user });
document.querySelector('[data-logout]').addEventListener('click', signOut);
initChatBox();

function row({ title, body, action }) {
  return `
    <div class="setting-row">
      <div class="setting-row__text">
        <b>${title}</b>
        <p>${body}</p>
      </div>
      <div class="setting-row__action">${action}</div>
    </div>`;
}

/* --- Account -------------------------------------------------------------- */
function renderAccount() {
  $('[data-slot="account"]').innerHTML =
    row({
      title: escapeHtml(user.name || 'No name set'),
      body: escapeHtml(user.email),
      action: `<span style="font-size:.79rem;color:var(--text-muted)">
                 Joined ${escapeHtml(formatDateTime(user.created_at))}
               </span>`,
    })
    + row({
      title: 'Password',
      body: 'Changing it signs you out of every other device.',
      action: '<button class="btn btn--ghost btn--sm" data-action="change-password">Change</button>',
    });

  $('[data-action="change-password"]').addEventListener('click', changePasswordModal);
}

function changePasswordModal() {
  modal({
    title: 'Change password',
    confirmLabel: 'Update password',
    body: `
      <div class="field">
        <label for="p-current">Current password</label>
        <input type="password" id="p-current" autocomplete="current-password" required>
      </div>
      <div class="field">
        <label for="p-new">New password</label>
        <input type="password" id="p-new" autocomplete="new-password" minlength="8" required>
        <span class="field__hint">At least 8 characters.</span>
      </div>
      <div class="field">
        <label for="p-confirm">Confirm new password</label>
        <input type="password" id="p-confirm" autocomplete="new-password" required>
      </div>
      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const current = dlg.querySelector('#p-current').value;
      const next = dlg.querySelector('#p-new').value;

      if (next !== dlg.querySelector('#p-confirm').value) {
        errorBox.textContent = 'The two new passwords do not match.';
        errorBox.hidden = false;
        return false;
      }

      if (next.length < 8) {
        errorBox.textContent = 'The new password must be at least 8 characters.';
        errorBox.hidden = false;
        return false;
      }

      try {
        await Api.auth.changePassword(current, next);
        toast('Password updated. Signing you out…', 'ok');
        setTimeout(signOut, 1600);
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not change the password.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

/* --- Two-factor ----------------------------------------------------------- */
function renderTwoFactor() {
  const usingTotp = user.two_factor_enabled && user.two_factor_method === 'totp';

  $('[data-slot="twofa"]').innerHTML = row({
    title: usingTotp ? 'Authenticator app' : 'Email codes',
    body: usingTotp
      ? 'A rotating 6-digit code from your app is required at every sign-in.'
      : 'A one-time code is emailed to you at every sign-in.',
    action: `<span style="font-size:.8rem;color:${usingTotp ? 'var(--good)' : 'var(--warning)'}">
               <span class="status-dot" style="background:currentColor"></span>
               ${usingTotp ? 'Strong' : 'Basic'}
             </span>
             <button class="btn ${usingTotp ? 'btn--ghost' : 'btn--primary'} btn--sm"
                     data-action="${usingTotp ? 'disable-totp' : 'setup-totp'}">
               ${usingTotp ? 'Disable' : 'Set up app'}
             </button>`,
  });

  $('[data-action="setup-totp"]')?.addEventListener('click', setupTotpModal);
  $('[data-action="disable-totp"]')?.addEventListener('click', disableTotpModal);
}

async function setupTotpModal() {
  let setup;

  try {
    const res = await Api.auth.setupTotp();
    setup = res.data;
  } catch {
    toast('Could not start setup.', 'error');
    return;
  }

  // Encoded locally. The otpauth URI carries the TOTP shared secret, so it must
  // never be handed to a third-party chart-image service to draw.
  let qr;

  try {
    qr = qrSvg(setup.otpauth_uri, { size: 190 });
  } catch (err) {
    console.error(err);
    qr = '';
  }

  const { dialog } = modal({
    title: 'Set up your authenticator',
    confirmLabel: 'Confirm & enable',
    body: `
      <ol style="padding-left:19px;margin:0 0 18px;font-size:.86rem;color:var(--text-secondary);line-height:1.9">
        <li>Open Google Authenticator, Authy or 1Password.</li>
        <li>Scan this code, or type the key by hand.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>

      ${qr
        ? `<div class="qr-box">${qr}</div>`
        : `<div class="alert alert--info">${Icons.info}<div>
             Could not draw the QR code — type the setup key below by hand instead.
           </div></div>`}

      <div class="field">
        <label>Setup key</label>
        <div style="display:flex;gap:9px;align-items:center">
          <span class="secret" style="flex:1">${escapeHtml(setup.secret)}</span>
          <button type="button" class="icon-btn" data-action="copy-secret" aria-label="Copy key">${Icons.copy}</button>
        </div>
        <span class="field__hint">SHA-1 · 6 digits · 30-second period.</span>
      </div>

      <div class="field">
        <label for="t-code">Code from your app</label>
        <input type="text" id="t-code" class="otp-input" inputmode="numeric" maxlength="6"
               autocomplete="one-time-code" placeholder="000000">
      </div>

      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      try {
        await Api.auth.confirmTotp(dlg.querySelector('#t-code').value.trim());
        toast('Authenticator enabled.', 'ok');
        await reload();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'That code was not accepted.';
        errorBox.hidden = false;
        return false;
      }
    },
  });

  dialog.querySelector('[data-action="copy-secret"]').addEventListener('click', async () => {
    const ok = await copyToClipboard(setup.secret);
    toast(ok ? 'Key copied.' : 'Could not copy.', ok ? 'ok' : 'error');
  });

  dialog.querySelector('#t-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  });
}

function disableTotpModal() {
  modal({
    title: 'Disable authenticator',
    confirmLabel: 'Disable',
    body: `
      <div class="alert alert--error">
        ${Icons.alert}
        <div>You will fall back to emailed codes, which are weaker — anyone with
             access to your inbox can complete a sign-in.</div>
      </div>
      <div class="field">
        <label for="d-password">Confirm with your password</label>
        <input type="password" id="d-password" autocomplete="current-password" required>
      </div>
      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      try {
        await Api.auth.disableTotp(dlg.querySelector('#d-password').value);
        toast('Authenticator disabled.', 'ok');
        await reload();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not disable it.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

/* --- Vault ---------------------------------------------------------------- */
function renderVault() {
  const hasMaster = user.vault_locked_by_master_password;

  $('[data-slot="vault"]').innerHTML = row({
    title: 'Master password',
    body: hasMaster
      ? 'A dedicated password unlocks the vault, separate from your account password.'
      : 'Not set — your account password currently unlocks the vault.',
    action: `<span style="font-size:.8rem;color:${hasMaster ? 'var(--good)' : 'var(--text-muted)'}">
               <span class="status-dot" style="background:currentColor"></span>
               ${hasMaster ? 'Set' : 'Not set'}
             </span>
             <button class="btn ${hasMaster ? 'btn--ghost' : 'btn--primary'} btn--sm"
                     data-action="master">${hasMaster ? 'Change' : 'Set up'}</button>`,
  });

  $('[data-action="master"]').addEventListener('click', masterPasswordModal);
}

function masterPasswordModal() {
  modal({
    title: 'Master password',
    confirmLabel: 'Save',
    body: `
      <p class="card__sub" style="margin-bottom:16px">
        Used only to unlock the vault. Make it different from your account password —
        that is the whole point of having it.
      </p>
      <div class="field">
        <label for="m-account">Your account password</label>
        <input type="password" id="m-account" autocomplete="current-password" required>
      </div>
      <div class="field">
        <label for="m-master">New master password</label>
        <input type="password" id="m-master" autocomplete="new-password" minlength="8" required>
      </div>
      <div class="field">
        <label for="m-confirm">Confirm master password</label>
        <input type="password" id="m-confirm" autocomplete="new-password" required>
      </div>
      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const master = dlg.querySelector('#m-master').value;

      if (master !== dlg.querySelector('#m-confirm').value) {
        errorBox.textContent = 'The two master passwords do not match.';
        errorBox.hidden = false;
        return false;
      }

      try {
        await Api.vault.setMasterPassword(dlg.querySelector('#m-account').value, master);
        Session.lockVault();
        toast('Master password set.', 'ok');
        await reload();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not set it.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

/* --- Devices -------------------------------------------------------------- */
async function renderDevices() {
  const host = $('[data-slot="devices"]');
  host.innerHTML = '<div class="skeleton" style="height:60px"></div>';

  let devices = [];
  try {
    const res = await Api.auth.devices();
    devices = res.data;
  } catch {
    host.innerHTML = '<p class="card__sub" style="margin:0">Could not load your devices.</p>';
    return;
  }

  if (!devices.length) {
    host.innerHTML = row({
      title: 'No devices enrolled',
      body: 'Enrol a phone from the mobile app to unlock it with a fingerprint or face scan.',
      action: `<span style="font-size:.8rem;color:var(--text-muted)">
                 <span class="status-dot" style="background:currentColor"></span>None</span>`,
    });
    return;
  }

  host.innerHTML = devices.map((d) => row({
    title: escapeHtml(d.device_name || d.device_id),
    body: `${escapeHtml(d.platform)} · last used ${escapeHtml(d.last_used_at ? formatDateTime(d.last_used_at) : 'never')}`,
    action: `<button class="btn btn--ghost btn--sm" data-revoke="${escapeHtml(d.device_id)}">Remove</button>`,
  })).join('');

  host.querySelectorAll('[data-revoke]').forEach((btn) =>
    btn.addEventListener('click', () => {
      confirmDanger({
        title: 'Remove device',
        message: 'That phone will need a full password and 2FA sign-in before it can use biometrics again.',
        confirmLabel: 'Remove',
        onConfirm: async () => {
          try {
            await Api.auth.revokeDevice(btn.dataset.revoke);
            toast('Device removed.', 'ok');
            renderDevices();
          } catch {
            toast('Could not remove that device.', 'error');
          }
        },
      });
    }));
}

/* --- Appearance ----------------------------------------------------------- */
function renderAppearance() {
  $('[data-slot="appearance"]').innerHTML = row({
    title: 'Theme',
    body: 'Charts re-step their colours for whichever surface you choose.',
    action: `
      <div class="segmented" role="group" aria-label="Theme">
        <button data-theme-set="dark"  aria-pressed="${Theme.current() === 'dark'}">Dark</button>
        <button data-theme-set="light" aria-pressed="${Theme.current() === 'light'}">Light</button>
      </div>`,
  });

  document.querySelectorAll('[data-theme-set]').forEach((btn) =>
    btn.addEventListener('click', () => {
      localStorage.setItem(Theme.KEY, btn.dataset.themeSet);
      Theme.apply(btn.dataset.themeSet);
      renderAppearance();
    }));
}

/* --- Sessions ------------------------------------------------------------- */
function renderSessions() {
  $('[data-slot="sessions"]').innerHTML =
    row({
      title: 'This browser',
      body: 'Ends the session here only.',
      action: '<button class="btn btn--ghost btn--sm" data-action="signout">Sign out</button>',
    })
    + row({
      title: 'Every device',
      body: 'Revokes all refresh tokens — web, desktop and mobile all have to sign in again.',
      action: '<button class="btn btn--danger btn--sm" data-action="signout-all">Sign out everywhere</button>',
    });

  $('[data-action="signout"]').addEventListener('click', signOut);

  $('[data-action="signout-all"]').addEventListener('click', () => {
    confirmDanger({
      title: 'Sign out everywhere',
      message: 'Every signed-in device will be logged out, including this one.',
      confirmLabel: 'Sign out everywhere',
      onConfirm: async () => {
        try {
          await Api.auth.logoutAll();
          toast('All sessions revoked.', 'ok');
          setTimeout(signOut, 1200);
        } catch {
          toast('Could not revoke sessions.', 'error');
        }
      },
    });
  });
}

/* --- Backups ---------------------------------------------------------------
   No admin role exists in this app (see api/README.md), so a full backup —
   every user's data plus api/.env — is gated by a separate BACKUP_KEY from
   the server's .env, not by just being signed in. The key lives in a plain
   module variable, never in storage, and is asked for once per page load —
   the same "second gate" pattern the vault uses for its unlock token.      */
let backupKey = null;
let backupOpen = false;
let driveConfigured = false;

function renderBackups() {
  const host = $('[data-slot="backups"]');

  if (!backupOpen) {
    host.innerHTML = row({
      title: 'Locked',
      body: 'Requires the operator-only backup key from the API\'s .env, not your account password.',
      action: '<button class="btn btn--ghost btn--sm" data-action="backup-unlock">Unlock</button>',
    });
    $('[data-action="backup-unlock"]').addEventListener('click', backupUnlockModal);
    return;
  }

  host.innerHTML = `
    <div class="setting-row">
      <div class="setting-row__text">
        <b>Create a new backup</b>
        <p>Zips the whole project plus a database dump. Can take a while for a large install.</p>
      </div>
      <div class="setting-row__action">
        <button class="btn btn--primary btn--sm" data-action="backup-run">${Icons.database}Run backup</button>
      </div>
    </div>
    <div data-slot="backup-list"></div>`;

  $('[data-action="backup-run"]').addEventListener('click', runBackupModal);
  loadBackupList();
}

function backupUnlockModal() {
  modal({
    title: 'Unlock backups',
    confirmLabel: 'Continue',
    body: `
      <p class="card__sub" style="margin-bottom:16px">
        This is a server-operator feature. It is gated by <code>BACKUP_KEY</code> in the API's
        <code>.env</code> — a separate secret from your account password, because a backup covers
        every user's data, not just yours.
      </p>
      <div class="field">
        <label for="bk-key">Backup key</label>
        <input type="password" id="bk-key" autocomplete="off" required>
      </div>
      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;
      const key = dlg.querySelector('#bk-key').value;

      try {
        const res = await Api.backup.list(key);
        backupKey = key;
        backupOpen = true;
        driveConfigured = res.data.drive_configured;
        renderBackups();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Could not verify that key.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

async function loadBackupList() {
  const host = $('[data-slot="backup-list"]');
  host.innerHTML = '<div class="skeleton" style="height:60px;margin-top:12px"></div>';

  try {
    const res = await Api.backup.list(backupKey);
    driveConfigured = res.data.drive_configured;
    renderBackupList(res.data.backups);
  } catch {
    host.innerHTML = '<p class="card__sub" style="margin:12px 0 0">Could not load the backup list.</p>';
  }
}

function renderBackupList(backups) {
  const host = $('[data-slot="backup-list"]');

  if (!backups.length) {
    host.innerHTML = '<p class="card__sub" style="margin:12px 0 0">No backups yet.</p>';
    return;
  }

  host.innerHTML = backups.map((b) => row({
    title: escapeHtml(b.filename),
    body: `${formatBytes(b.size)} · ${escapeHtml(formatDateTime(b.created_at))}`,
    action: `
      <button class="icon-btn" data-download="${escapeHtml(b.filename)}" aria-label="Download ${escapeHtml(b.filename)}">${Icons.download}</button>
      <button class="icon-btn" data-delete-backup="${escapeHtml(b.filename)}" aria-label="Delete ${escapeHtml(b.filename)}">${Icons.trash}</button>`,
  })).join('');

  host.querySelectorAll('[data-download]').forEach((btn) =>
    btn.addEventListener('click', () => downloadBackup(btn.dataset.download)));

  host.querySelectorAll('[data-delete-backup]').forEach((btn) =>
    btn.addEventListener('click', () => deleteBackup(btn.dataset.deleteBackup)));
}

function runBackupModal() {
  modal({
    title: 'Create a backup',
    confirmLabel: 'Run backup',
    body: `
      <p class="card__sub" style="margin-bottom:16px">
        Zips api/, web/ and everything else under the project root, alongside a full database
        dump. The archive includes <code>.env</code> — treat every backup file exactly as
        carefully as that file.
      </p>
      <div class="field">
        <label class="checkline">
          <input type="checkbox" id="bk-drive" ${driveConfigured ? '' : 'disabled'}>
          Also upload to Google Drive
        </label>
        ${driveConfigured ? '' : '<span class="field__hint">Set GOOGLE_SERVICE_ACCOUNT_FILE in .env to enable this.</span>'}
      </div>
      <p data-slot="backup-progress" style="margin-top:4px;font-size:.82rem;color:var(--text-secondary)"></p>
      <div class="alert alert--error" data-slot="modal-error" hidden></div>`,

    onConfirm: async (dlg) => {
      const errorBox = dlg.querySelector('[data-slot="modal-error"]');
      errorBox.hidden = true;

      const progress = dlg.querySelector('[data-slot="backup-progress"]');
      const uploadToDrive = dlg.querySelector('#bk-drive').checked;

      progress.textContent = uploadToDrive
        ? 'Zipping the project, dumping the database, then uploading — this can take a while…'
        : 'Zipping the project and dumping the database — this can take a while…';

      try {
        const res = await Api.backup.create(backupKey, uploadToDrive);
        toast(
          `Backup created (${formatBytes(res.data.size)})${res.data.drive ? ', uploaded to Drive.' : '.'}`,
          'ok',
        );
        loadBackupList();
      } catch (err) {
        errorBox.textContent = err instanceof ApiError ? err.detail : 'Backup failed.';
        errorBox.hidden = false;
        return false;
      }
    },
  });
}

async function downloadBackup(filename) {
  try {
    const blob = await Api.backup.download(backupKey, filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    toast('Could not download that backup.', 'error');
  }
}

function deleteBackup(filename) {
  confirmDanger({
    title: 'Delete backup',
    message: `“${filename}” will be permanently deleted from the server. This cannot be undone.`,
    onConfirm: async () => {
      try {
        await Api.backup.remove(backupKey, filename);
        toast('Backup deleted.', 'ok');
        loadBackupList();
      } catch {
        toast('Could not delete that backup.', 'error');
      }
    },
  });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 || size >= 10 ? 0 : 1)} ${units[i]}`;
}

async function reload() {
  const res = await Api.auth.me();
  user = res.data;
  Session.user = user;
  renderAll();
}

function renderAll() {
  renderAccount();
  renderTwoFactor();
  renderVault();
  renderBackups();
  renderAppearance();
  renderSessions();
  renderDevices();
}

renderAll();
