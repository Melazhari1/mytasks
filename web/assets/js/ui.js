/* =============================================================================
   Shared UI: theme, mascot, icons, toasts, modals, formatting.
   No framework, no build step — just an ES module.
   ========================================================================== */

/* --- Theme ----------------------------------------------------------------
   Dark is the default because that is the mascot's world. The stored choice
   wins over the OS preference; with nothing stored we follow the OS.        */
export const Theme = {
  KEY: 'mytasks.theme',

  init() {
    // Dark is the brand default, not an OS-derived guess — the whole design
    // was drawn for the dark surface. A stored choice always wins, so a light
    // preference survives once the user actually expresses it.
    Theme.apply(localStorage.getItem(Theme.KEY) ?? 'dark');
  },

  current() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  },

  apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.innerHTML = theme === 'light' ? Icons.moon : Icons.sun;
      btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
      btn.title = btn.getAttribute('aria-label');
    });
    // Charts read their colours from CSS custom properties, so a theme change
    // means every chart has to be re-drawn against the new surface.
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  },

  toggle() {
    const next = Theme.current() === 'light' ? 'dark' : 'light';
    localStorage.setItem(Theme.KEY, next);
    Theme.apply(next);
  },

  /** Resolved value of a CSS custom property — how charts get their colours. */
  token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },
};

/* --- Mascot ---------------------------------------------------------------
   The hooded cat artwork.

   Paths are resolved from this module's own URL rather than written relative
   to the page, so the images keep working no matter which HTML file — or which
   folder depth — pulls them in.

   The artwork was drawn on a near-black backdrop and its rim light bleeds into
   that backdrop, so it is used framed rather than cut out: matting it leaves a
   ragged halo where the glow fades. On the dark theme the frame melts into the
   surface; on the light theme it reads as a deliberate poster panel.          */
const IMG = (file) => new URL(`../img/${file}`, import.meta.url).href;

export function catMascot({ size = 200, alt = 'MyTasks — a hooded cat with glowing eyes' } = {}) {
  return `<img class="cat-art" src="${IMG('cat-hero.jpg')}" alt="${escapeHtml(alt)}"
               width="${size}" height="${size}" loading="lazy" decoding="async">`;
}

/* Head-only crop, for the sidebar mark and avatars. */
export function catBadge({ size = 38, alt = '' } = {}) {
  return `<img class="cat-mark" src="${IMG('cat-badge.jpg')}" alt="${escapeHtml(alt)}"
               width="${size}" height="${size}" loading="eager" decoding="async"
               ${alt === '' ? 'aria-hidden="true"' : ''}>`;
}


/* --- Icons (24×24 stroke, currentColor) ---------------------------------- */
const ico = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;

export const Icons = {
  dashboard: ico('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  tasks:     ico('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/>'),
  folder:    ico('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  vault:     ico('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1.4"/>'),
  settings:  ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'),
  logout:    ico('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  plus:      ico('<path d="M12 5v14M5 12h14"/>'),
  check:     ico('<path d="m4 12 5 5L20 6"/>'),
  edit:      ico('<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2 2 0 0 1 2.8 2.8L12 14.6 8 15.6l1-4Z"/>'),
  trash:     ico('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
  eye:       ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:    ico('<path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  copy:      ico('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  lock:      ico('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  unlock:    ico('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.6-2"/>'),
  clock:     ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  alert:     ico('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17.5v.01"/>'),
  info:      ico('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>'),
  flame:     ico('<path d="M12 2s5 5 5 9a5 5 0 0 1-10 0c0-1.5.8-3 .8-3S6 10 6 13a6 6 0 0 0 12 0c0-5-6-11-6-11Z"/>'),
  sun:       ico('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon:      ico('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
  x:         ico('<path d="M18 6 6 18M6 6l12 12"/>'),
  search:    ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  shield:    ico('<path d="M12 3 4 6v6c0 4.5 3.2 8.4 8 9.5 4.8-1.1 8-5 8-9.5V6Z"/>'),
  phone:     ico('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18.5h2"/>'),
  key:       ico('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2 2 2 2-2 2-2-2-2 2"/>'),
  refresh:   ico('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  paw:       ico('<ellipse cx="7" cy="8" rx="2" ry="2.6"/><ellipse cx="12" cy="6.4" rx="2" ry="2.8"/><ellipse cx="17" cy="8" rx="2" ry="2.6"/><path d="M12 12c3 0 5.5 2.2 5.5 4.6 0 1.9-1.6 2.9-3.2 2.9-1 0-1.6-.5-2.3-.5s-1.3.5-2.3.5c-1.6 0-3.2-1-3.2-2.9C6.5 14.2 9 12 12 12Z"/>'),
  chevron:   ico('<path d="m9 6 6 6-6 6"/>'),
  mail:      ico('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m2.5 6.5 9.5 7 9.5-7"/>'),
  upload:    ico('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  download:  ico('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
  database:  ico('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  grip:      ico('', '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></g>'),
  maximize:  ico('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  minimize:  ico('<path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4"/>'),
  chat:      ico('<path d="M21 11.5a8.38 8.38 0 0 1-4.9 7.6 8.5 8.5 0 0 1-9.3-1.8L3 21l1.9-4.8a8.5 8.5 0 0 1 6.1-13.6h.5a8.48 8.48 0 0 1 9.5 9v-.1Z"/>'),
  send:      ico('<path d="m3 11 18-8-8 18-2-8-8-2Z"/>'),
  mic:       ico('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4M9 22h6"/>'),
  volume:    ico('<path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 6a9 9 0 0 1 0 12"/>'),
  volumeOff: ico('<path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="m17 9 5 6M22 9l-5 6"/>'),
  ear:       ico('<path d="M8 15a3 3 0 0 0 3 3c1 0 1.7-.4 2.2-1"/><path d="M6.5 18.5C4 16 3 13.5 3 10.5 3 6 6.5 2.5 11 2.5S19 6 19 10c0 1.5-.5 2-1 3.5s-.5 2 0 3 .5 3-1.5 3-2-1.5-2-3v-2a4.5 4.5 0 0 0-9 0"/>'),
  bulb:      ico('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2.3h6c0-1.1.4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>'),
  link:      ico('<path d="M10 13a5 5 0 0 0 7.5.4l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.4l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>'),
  wallet:    ico('<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-4"/><path d="M14 12h6v4h-6a2 2 0 0 1 0-4Z"/>'),
};

/* --- Social platforms (idea cards) -----------------------------------------
   No icon font/CDN (see the artifact "self-contained only" rule this project
   follows throughout) — each platform is a small coloured initial/glyph
   badge instead of a brand SVG. Keys here are exactly what the API accepts
   (SocialIdeaController::PLATFORMS) — keep the two lists in sync. */
export const SOCIAL_PLATFORMS = [
  { key: 'youtube',   label: 'YouTube',   glyph: '▶',  bg: '#FF0000', fg: '#fff' },
  { key: 'facebook',  label: 'Facebook',  glyph: 'f',  bg: '#1877F2', fg: '#fff' },
  { key: 'instagram', label: 'Instagram', glyph: 'IG', bg: 'linear-gradient(45deg,#f58529,#dd2a7b,#8134af,#515bd4)', fg: '#fff' },
  { key: 'tiktok',    label: 'TikTok',    glyph: '♪',  bg: '#000000', fg: '#fff' },
  { key: 'x',         label: 'X',         glyph: 'X',  bg: '#000000', fg: '#fff' },
  { key: 'linkedin',  label: 'LinkedIn',  glyph: 'in', bg: '#0A66C2', fg: '#fff' },
  { key: 'pinterest', label: 'Pinterest', glyph: 'P',  bg: '#E60023', fg: '#fff' },
  { key: 'snapchat',  label: 'Snapchat',  glyph: 'S',  bg: '#FFFC00', fg: '#000' },
  { key: 'whatsapp',  label: 'WhatsApp',  glyph: 'W',  bg: '#25D366', fg: '#fff' },
  { key: 'telegram',  label: 'Telegram',  glyph: '✈',  bg: '#26A5E4', fg: '#fff' },
  { key: 'threads',   label: 'Threads',   glyph: '@',  bg: '#000000', fg: '#fff' },
  { key: 'reddit',    label: 'Reddit',    glyph: 'r',  bg: '#FF4500', fg: '#fff' },
];

export function socialBadge(key, { size = 26 } = {}) {
  const p = SOCIAL_PLATFORMS.find((s) => s.key === key);
  if (!p) return '';

  return `<span class="social-badge" title="${escapeHtml(p.label)}" aria-label="${escapeHtml(p.label)}"
                style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${p.bg};color:${p.fg}">
            ${escapeHtml(p.glyph)}
          </span>`;
}

/* --- Idea status (Social Ideas cards) --------------------------------------
   Same three semantic colours the rest of the app already uses for pills
   (warning/accent/good) — see .pill--pending/.pill--completed in app.css —
   reused here rather than inventing a fourth palette. Keys must match
   SocialIdeaController::STATUSES. */
export const IDEA_STATUSES = [
  { key: 'pending', label: 'Pending', color: 'var(--warning)', soft: 'var(--warning-soft)' },
  { key: 'future',  label: 'Future',  color: 'var(--accent)',  soft: 'var(--accent-soft)' },
  { key: 'done',    label: 'Done',    color: 'var(--good)',    soft: 'var(--good-soft)' },
];

export function statusPill(key) {
  const s = IDEA_STATUSES.find((x) => x.key === key) ?? IDEA_STATUSES[0];

  return `<span class="pill" style="color:${s.color};border-color:${s.color};background:${s.soft}">
            ${escapeHtml(s.label)}
          </span>`;
}

/* --- Budget categories (the 50/30/20 rule) ---------------------------------
   Keys and pct must match BudgetController::CATEGORIES / STANDARD. */
export const BUDGET_CATEGORIES = [
  { key: 'need', label: 'Need', pct: 0.5, color: 'var(--accent)',  soft: 'var(--accent-soft)' },
  { key: 'want', label: 'Want', pct: 0.3, color: 'var(--warning)', soft: 'var(--warning-soft)' },
  { key: 'save', label: 'Save', pct: 0.2, color: 'var(--good)',    soft: 'var(--good-soft)' },
];

export function categoryPill(key) {
  const c = BUDGET_CATEGORIES.find((x) => x.key === key) ?? BUDGET_CATEGORIES[0];

  return `<span class="pill" style="color:${c.color};border-color:${c.color};background:${c.soft}">
            ${escapeHtml(c.label)}
          </span>`;
}

/** 0-5 -> one of the app's three semantic colours, for the score display. */
export function scoreColor(score) {
  if (score === null || score === undefined) return 'var(--text-muted)';
  if (score >= 4) return 'var(--good)';
  if (score >= 2.5) return 'var(--warning)';
  return 'var(--critical)';
}

/* --- Toasts -------------------------------------------------------------- */
let toastHost;

export function toast(message, kind = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }

  const icon = kind === 'ok' ? Icons.check : kind === 'error' ? Icons.alert : Icons.info;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.innerHTML = `${icon}<div>${escapeHtml(message)}</div>`;
  toastHost.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* --- Modal --------------------------------------------------------------- */
export function modal({ title, body, confirmLabel = 'Save', cancelLabel = 'Cancel', onConfirm, wide = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  if (wide) dlg.style.width = 'min(680px, calc(100vw - 32px))';

  dlg.innerHTML = `
    <form method="dialog">
      <div class="modal__head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${Icons.x}</button>
      </div>
      <div class="modal__body">${body}</div>
      <div class="modal__foot">
        <button type="button" class="btn btn--ghost" data-close>${escapeHtml(cancelLabel)}</button>
        ${onConfirm ? `<button type="button" class="btn btn--primary" data-confirm>${escapeHtml(confirmLabel)}</button>` : ''}
      </div>
    </form>`;

  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  const confirmBtn = dlg.querySelector('[data-confirm]');

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      try {
        const keepOpen = await onConfirm(dlg);
        if (keepOpen !== false) close();
      } finally {
        confirmBtn.disabled = false;
      }
    });
  }

  setTimeout(() => dlg.querySelector('input, select, textarea')?.focus(), 40);

  return { dialog: dlg, close };
}

export function confirmDanger({ title, message, confirmLabel = 'Delete', onConfirm }) {
  return modal({
    title,
    body: `<div class="alert alert--error">${Icons.alert}<div>${escapeHtml(message)}</div></div>`,
    confirmLabel,
    onConfirm: async (dlg) => {
      dlg.querySelector('[data-confirm]').classList.replace('btn--primary', 'btn--danger');
      await onConfirm();
    },
  });
}

/* --- Formatting ---------------------------------------------------------- */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '—';

  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  if (sameDay(d, today))     return 'Today';
  if (sameDay(d, tomorrow))  return 'Tomorrow';
  if (sameDay(d, yesterday)) return 'Yesterday';

  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '—';

  return `${formatDate(iso)}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function reminderLabel(minutes) {
  if (minutes === null || minutes === undefined) return 'No reminder';
  if (minutes === 0)    return 'At the deadline';
  if (minutes < 60)     return `${minutes} min before`;
  if (minutes < 1440)   return `${Math.round(minutes / 60)} h before`;
  return `${Math.round(minutes / 1440)} day(s) before`;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; http://localhost counts, but a
    // LAN IP over plain http does not. Fall back to the old selection trick.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* --- App chrome ---------------------------------------------------------- */
const NAV = [
  { href: 'dashboard.html',  label: 'Dashboard',  icon: 'dashboard' },
  { href: 'tasks.html',      label: 'Tasks',      icon: 'tasks' },
  { href: 'categories.html', label: 'Goals',      icon: 'folder' },
  { href: 'social-ideas.html', label: 'Social Ideas', icon: 'bulb' },
  { href: 'budget.html',     label: 'Budget',     icon: 'wallet' },
  { href: 'vault.html',      label: 'Vault',      icon: 'vault' },
  { href: 'settings.html',   label: 'Settings',   icon: 'settings' },
];

export function renderShell({ active, user }) {
  const page = active ?? location.pathname.split('/').pop();

  document.querySelector('[data-shell="sidebar"]').innerHTML = `
    <div class="sidebar__brand">
      ${catBadge({ size: 38 })}
      <div class="sidebar__brand-name">My<em>Tasks</em></div>
    </div>
    <nav class="nav" aria-label="Main">
      ${NAV.map((item) => `
        <a href="${item.href}" ${item.href === page ? 'aria-current="page"' : ''}>
          ${Icons[item.icon]}<span>${item.label}</span>
        </a>`).join('')}
    </nav>
    <div class="sidebar__foot">
      <div class="userchip">
        ${catBadge({ size: 28 })}
        <span class="userchip__mail">${escapeHtml(user?.email ?? '')}</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" data-theme-toggle></button>
        <button class="icon-btn" data-logout aria-label="Sign out" title="Sign out">${Icons.logout}</button>
      </div>
    </div>`;

  document.querySelectorAll('[data-theme-toggle]').forEach((b) =>
    b.addEventListener('click', Theme.toggle));

  Theme.apply(Theme.current());
}

export function emptyState({ title, message, actionLabel, onAction }) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `
    ${catMascot({ size: 128, alt: '' })}
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
    ${actionLabel ? `<button class="btn btn--primary">${Icons.plus}${escapeHtml(actionLabel)}</button>` : ''}`;

  if (onAction) wrap.querySelector('button')?.addEventListener('click', onAction);

  return wrap;
}
