import { Api, ApiError, Session } from './api.js';
import { Theme, Icons, catMascot, catBadge, escapeHtml, toast } from './ui.js';

Theme.init();

const $ = (sel) => document.querySelector(sel);
const steps = {
  login:    $('[data-step="login"]'),
  verify:   $('[data-step="verify"]'),
  register: $('[data-step="register"]'),
};

const errorBox  = $('[data-slot="error"]');
const noticeBox = $('[data-slot="notice"]');

/* --- Static chrome -------------------------------------------------------- */
$('[data-slot="cat"]').innerHTML = catMascot({ size: 300 });
$('[data-slot="badge"]').innerHTML = catBadge({ size: 40 });

$('[data-slot="points"]').innerHTML = [
  ['shield', 'Two-factor by default', 'A code from your authenticator app or your inbox, every sign-in.'],
  ['vault',  'Encrypted vault',       'Passwords sealed with AES-256 before they ever reach the database.'],
  ['paw',    'One account, three apps', 'Web, desktop and mobile read from the same place.'],
].map(([icon, title, body]) => `
  <li>${Icons[icon]}<div><b>${title}</b><span>${body}</span></div></li>`).join('');

$('[data-theme-toggle]').addEventListener('click', Theme.toggle);

/* --- Step machine --------------------------------------------------------- */
let challengeToken = null;

function show(step) {
  Object.entries(steps).forEach(([name, form]) => { form.hidden = name !== step; });
  clearMessages();
  setTimeout(() => steps[step].querySelector('input:not([type=hidden])')?.focus(), 40);
}

function clearMessages() {
  errorBox.hidden = true;
  noticeBox.hidden = true;
}

function showError(message) {
  errorBox.innerHTML = `${Icons.alert}<div>${escapeHtml(message)}</div>`;
  errorBox.hidden = false;
  noticeBox.hidden = true;
}

function showNotice(message) {
  noticeBox.innerHTML = `${Icons.info}<div>${escapeHtml(message)}</div>`;
  noticeBox.hidden = false;
  errorBox.hidden = true;
}

document.querySelectorAll('[data-go]').forEach((link) => {
  link.addEventListener('click', (e) => { e.preventDefault(); show(link.dataset.go); });
});

/** Wrap a submit handler: disable the button, surface the error, re-enable. */
function onSubmit(form, handler) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();

    const button = form.querySelector('button[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';

    try {
      await handler(new FormData(form));
    } catch (err) {
      if (err instanceof ApiError) {
        showError(err.detail);
        if (err.code === 'too_many_requests' && err.payload?.retry_after) {
          showError(`${err.detail} (about ${Math.ceil(err.payload.retry_after / 60)} min)`);
        }
      } else {
        showError('Could not reach the API. Is Apache running, and is the api/ folder in place?');
        console.error(err);
      }
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

/* --- Step 1: credentials -------------------------------------------------- */
onSubmit(steps.login, async (data) => {
  const res = await Api.auth.login(data.get('email'), data.get('password'));
  const payload = res.data;

  // 2FA can be switched off server-side; then login returns tokens directly.
  if (!payload.two_factor_required) {
    return enter(payload);
  }

  challengeToken = payload.challenge_token;

  const isEmail = payload.method === 'email';
  $('[data-slot="verify-lead"]').textContent = payload.message
    ?? (isEmail ? 'We emailed you a code.' : 'Open your authenticator app.');
  $('[data-action="resend"]').hidden = !isEmail;

  show('verify');

  // With MAIL_DRIVER=log nothing is actually sent — say where to find the code
  // instead of leaving the user staring at an empty inbox.
  if (payload.debug_hint) showNotice(payload.debug_hint);
});

/* --- Step 2: the code ----------------------------------------------------- */
onSubmit(steps.verify, async () => {
  const code = $('#otp-code').value.trim();
  const res = await Api.auth.verify2fa(challengeToken, code, `Web · ${browserName()}`);
  enter(res.data);
});

$('[data-action="resend"]').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    await Api.auth.resendOtp(challengeToken);
    showNotice('A new code is on its way.');
  } catch (err) {
    showError(err instanceof ApiError ? err.detail : 'Could not resend the code.');
  } finally {
    setTimeout(() => { event.target.disabled = false; }, 20000);
  }
});

/* --- Registration --------------------------------------------------------- */
onSubmit(steps.register, async (data) => {
  await Api.auth.register({
    name: data.get('name') || null,
    email: data.get('email'),
    password: data.get('password'),
  });

  show('login');
  $('#login-email').value = data.get('email');
  showNotice('Account created. Sign in to continue.');
});

/* --- Landing -------------------------------------------------------------- */
function enter(payload) {
  Session.access = payload.access_token;
  Session.user = payload.user;
  location.replace('dashboard.html');
}

function browserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua))    return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/* Already signed in? Skip straight through. */
(async () => {
  if (!Session.access) return;
  try {
    await Api.auth.me();
    location.replace('dashboard.html');
  } catch {
    Session.clear();
  }
})();

/* Surface a dead API immediately rather than at first submit. */
Api.health().catch(() => {
  showError('The API is not responding. Check that Apache and MySQL are running.');
});

/* Numeric-only OTP field, auto-submitting when it's full. */
$('#otp-code').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  if (event.target.value.length === 6) {
    steps.verify.requestSubmit();
  }
});
