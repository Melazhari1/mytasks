/* =============================================================================
   API client.

   Token strategy
   --------------
   The access token lives in sessionStorage — it expires in 15 minutes and dies
   with the tab. The refresh token is an HttpOnly cookie the browser sends
   automatically and JavaScript can never read, which is the part that matters:
   an XSS bug can steal at most one short-lived access token, not a 30-day
   session. When a call comes back 401/token_expired we refresh once, then
   replay the original request.
   ========================================================================== */

const ACCESS_KEY = 'mytasks.access';
const USER_KEY   = 'mytasks.user';

/* Works wherever the app is mounted, from any sibling of api/ — not just
   web/, also cat-assistant/ (see ../../../cat-assistant/): strip the current
   file, then strip the one folder this page itself lives in, and that's the
   project root. /xxp/mytasks/web/… and /xxp/mytasks/cat-assistant/… both
   land on /xxp/mytasks/api. */
export const API_BASE = (() => {
  const parts = location.pathname.split('/');
  parts.pop(); // the file (or '' for a directory URL like ".../web/")
  parts.pop(); // this page's own folder
  return parts.join('/') + '/api';
})();

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || `Request failed (${status})`);
    this.status = status;
    this.code = payload?.error ?? 'error';
    this.errors = payload?.errors ?? null;
    this.payload = payload;
  }

  /** Flatten field errors into one readable line. */
  get detail() {
    if (!this.errors) return this.message;
    return Object.values(this.errors).flat().join(' ');
  }
}

export const Session = {
  get access()  { return sessionStorage.getItem(ACCESS_KEY); },
  set access(v) { v ? sessionStorage.setItem(ACCESS_KEY, v) : sessionStorage.removeItem(ACCESS_KEY); },

  get user() {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY) ?? 'null'); }
    catch { return null; }
  },
  set user(v) {
    v ? sessionStorage.setItem(USER_KEY, JSON.stringify(v)) : sessionStorage.removeItem(USER_KEY);
  },

  /* The vault unlock token is deliberately memory-only: it must not survive a
     reload, a new tab, or a screen the user walked away from. */
  vaultToken: null,
  vaultExpiresAt: 0,

  get vaultUnlocked() {
    return Boolean(Session.vaultToken) && Date.now() < Session.vaultExpiresAt;
  },

  unlockVault(token, expiresIn) {
    Session.vaultToken = token;
    Session.vaultExpiresAt = Date.now() + (expiresIn - 5) * 1000;
  },

  lockVault() {
    Session.vaultToken = null;
    Session.vaultExpiresAt = 0;
  },

  clear() {
    Session.access = null;
    Session.user = null;
    Session.lockVault();
  },
};

let refreshInFlight = null;

async function rawRequest(method, path, { body, headers = {}, auth = true } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',              // carries the HttpOnly refresh cookie
    headers: { Accept: 'application/json', ...headers },
  };

  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  if (auth && Session.access) {
    opts.headers.Authorization = `Bearer ${Session.access}`;
  }

  const response = await fetch(API_BASE + path, opts);

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;

  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = { message: text.slice(0, 200) }; }
  }

  if (!response.ok) throw new ApiError(response.status, payload);

  return payload;
}

async function request(method, path, options = {}) {
  try {
    return await rawRequest(method, path, options);
  } catch (err) {
    const isAuthCall = path.startsWith('/auth/refresh') || path.startsWith('/auth/login');
    const expired = err instanceof ApiError && err.status === 401 && options.auth !== false;

    if (!expired || isAuthCall) throw err;

    // One refresh attempt, shared across concurrent 401s so a page that fires
    // five requests at once doesn't burn five refresh tokens.
    refreshInFlight ??= rawRequest('POST', '/auth/refresh', { auth: false })
      .then((res) => {
        Session.access = res.data.access_token;
        Session.user = res.data.user;
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });

    const refreshed = await refreshInFlight;

    if (!refreshed) {
      Session.clear();
      throw err;
    }

    return rawRequest(method, path, options);
  }
}

const get  = (p, o)    => request('GET', p, o);
const post = (p, b, o) => request('POST', p, { ...o, body: b });
const put  = (p, b, o) => request('PUT', p, { ...o, body: b });
const del  = (p, o)    => request('DELETE', p, o);

const qs = (params) => {
  const usable = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '');

  return usable.length ? '?' + new URLSearchParams(usable) : '';
};

/* --- Endpoints ------------------------------------------------------------ */
export const Api = {
  health: () => get('/health', { auth: false }),

  auth: {
    register: (data)               => post('/auth/register', data, { auth: false }),
    login: (email, password)       => post('/auth/login', { email, password }, { auth: false }),
    verify2fa: (challengeToken, code, deviceName) =>
      post('/auth/verify-2fa', { challenge_token: challengeToken, code, device_name: deviceName }, { auth: false }),
    resendOtp: (challengeToken)    => post('/auth/resend-otp', { challenge_token: challengeToken }, { auth: false }),
    refresh: ()                    => post('/auth/refresh', undefined, { auth: false }),
    logout: ()                     => post('/auth/logout'),
    logoutAll: ()                  => post('/auth/logout-all'),
    me: ()                         => get('/auth/me'),
    changePassword: (current, next) =>
      post('/auth/change-password', { current_password: current, new_password: next }),

    setupTotp: ()      => post('/auth/2fa/setup'),
    confirmTotp: (code) => post('/auth/2fa/confirm', { code }),
    disableTotp: (password) => post('/auth/2fa/disable', { password }),

    enrollDevice: (data)   => post('/auth/biometric/enroll', data),
    devices: ()            => get('/auth/devices'),
    revokeDevice: (id)     => del(`/auth/devices/${encodeURIComponent(id)}`),
  },

  categories: {
    list: (withCounts = true) => get(`/categories${withCounts ? '' : '?with_counts=0'}`),
    create: (data)  => post('/categories', data),
    update: (id, data) => put(`/categories/${id}`, data),
    remove: (id)    => del(`/categories/${id}`),
    removeAll: ()   => del('/categories'),
  },

  tasks: {
    list: (filters)  => get(`/tasks${qs(filters)}`),
    get: (id)        => get(`/tasks/${id}`),
    create: (data)   => post('/tasks', data),
    update: (id, data) => put(`/tasks/${id}`, data),
    toggle: (id)     => post(`/tasks/${id}/toggle`),
    remove: (id)     => del(`/tasks/${id}`),
    summary: ()      => get('/tasks/summary'),
    reminders: ()    => get('/tasks/reminders'),
  },

  socialIdeas: {
    list: (filters)  => get(`/social-ideas${qs(filters)}`),
    get: (id)        => get(`/social-ideas/${id}`),
    create: (data)   => post('/social-ideas', data),
    update: (id, data) => put(`/social-ideas/${id}`, data),
    remove: (id)     => del(`/social-ideas/${id}`),
  },

  budget: {
    listMonths: (year)      => get(`/budget/months${qs({ year })}`),
    getMonth: (year, month) => get(`/budget/months/${year}/${month}`),
    setSalary: (year, month, salary) => put(`/budget/months/${year}/${month}`, { salary }),
    removeMonth: (year, month) => del(`/budget/months/${year}/${month}`),
    addEntry: (year, month, data) => post(`/budget/months/${year}/${month}/entries`, data),
    updateEntry: (id, data) => put(`/budget/entries/${id}`, data),
    removeEntry: (id) => del(`/budget/entries/${id}`),
  },

  vault: {
    list: (search)  => get(`/vault${qs({ search })}`),
    create: (data)  => post('/vault', data),
    update: (id, data) => put(`/vault/${id}`, data),
    remove: (id)    => del(`/vault/${id}`),
    generate: (length = 20, symbols = true) =>
      get(`/vault/generate-password${qs({ length, symbols: symbols ? 1 : 0 })}`),
    setMasterPassword: (accountPassword, masterPassword) =>
      post('/vault/master-password', { account_password: accountPassword, master_password: masterPassword }),
    requestUnlockOtp: () => post('/vault/unlock/request-otp'),

    async unlock(payload) {
      const res = await post('/vault/unlock', payload);
      Session.unlockVault(res.data.vault_token, res.data.expires_in);
      return res.data;
    },

    reveal(id) {
      if (!Session.vaultUnlocked) {
        throw new ApiError(403, { error: 'vault_locked', message: 'Unlock the vault first.' });
      }
      return post(`/vault/${id}/reveal`, undefined, { headers: { 'X-Vault-Token': Session.vaultToken } });
    },
  },

  /* Fallback path for the command chat: only called when its own local
     parser doesn't recognize a message. See api/src/Controllers/ChatController.php.
     `persona`/`name` are optional tone overrides — the web chat box never
     sends them (server defaults to "friendly"/"the MyTasks cat"); the Cat
     Assistant companion app (../cat-assistant/) does, from its Settings. */
  chat: {
    interpret: (message, persona, name) =>
      post('/chat/interpret', { message, ...(persona ? { persona } : {}), ...(name ? { name } : {}) }),
  },

  /* The mic button: uploads a WAV clip (see assets/js/voice.js) to a local
     whisper.cpp server via VoiceController — never a cloud speech API. */
  voice: {
    async transcribe(wavBlob) {
      const formData = new FormData();
      formData.append('audio', wavBlob, 'audio.wav');

      const response = await fetch(`${API_BASE}/voice/transcribe`, {
        method: 'POST',
        credentials: 'same-origin',
        // No Content-Type here — the browser sets the multipart boundary itself.
        headers: Session.access ? { Authorization: `Bearer ${Session.access}` } : {},
        body: formData,
      });

      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 200) }; }
      }

      if (!response.ok) throw new ApiError(response.status, payload);

      return payload.data.text;
    },

    /* The speaker: asks a locally-installed Piper (see api/.env.example) to
       read `text` aloud, returned as a WAV blob. 503s when Piper isn't set
       up — callers fall back to the browser's own speechSynthesis then. */
    async speak(text) {
      const response = await fetch(`${API_BASE}/voice/speak`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(Session.access ? { Authorization: `Bearer ${Session.access}` } : {}),
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* not JSON */ }
        throw new ApiError(response.status, payload);
      }

      return response.blob();
    },
  },

  /* Gated by a separate BACKUP_KEY (server .env), not the caller's own
     access token — see api/src/Middleware/BackupKeyMiddleware.php. */
  backup: {
    list: (key)      => get('/backup', { headers: { 'X-Backup-Key': key } }),
    create: (key, uploadToDrive) =>
      post('/backup', { upload_to_drive: uploadToDrive }, { headers: { 'X-Backup-Key': key } }),
    remove: (key, filename) => del(`/backup/${encodeURIComponent(filename)}`, { headers: { 'X-Backup-Key': key } }),

    /* Binary response — bypasses the JSON-oriented request() helper above. */
    async download(key, filename) {
      const response = await fetch(`${API_BASE}/backup/${encodeURIComponent(filename)}/download`, {
        credentials: 'same-origin',
        headers: {
          'X-Backup-Key': key,
          ...(Session.access ? { Authorization: `Bearer ${Session.access}` } : {}),
        },
      });

      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* not JSON */ }
        throw new ApiError(response.status, payload);
      }

      return response.blob();
    },
  },
};

/* --- Route guards --------------------------------------------------------- */

/** Call at the top of every signed-in page. Redirects to login if there's no session.
 *  `loginUrl` is relative to the calling page — pages outside web/ (e.g.
 *  ../cat-assistant/) must pass their own path back to web/index.html. */
export async function requireAuth(loginUrl = 'index.html') {
  if (!Session.access) {
    try {
      const res = await Api.auth.refresh();
      Session.access = res.data.access_token;
      Session.user = res.data.user;
    } catch {
      location.replace(loginUrl);
      return null;
    }
  }

  try {
    const me = await Api.auth.me();
    Session.user = me.data;
    return me.data;
  } catch {
    Session.clear();
    location.replace(loginUrl);
    return null;
  }
}

export async function signOut() {
  try { await Api.auth.logout(); } catch { /* the cookie may already be gone */ }
  Session.clear();
  location.replace('index.html');
}
