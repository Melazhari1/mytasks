/* Device-only preferences for the Cat Assistant widget — same reasoning as
   the dashboard's widget layout in the main app: this is UI flavor, not
   account data, so it lives in localStorage rather than round-tripping
   through the API. Only `personality` and `name` ever leave this device —
   as plain fields on /chat/interpret, so ChatController can pick the right
   tone. Everything else here is purely cosmetic/client-side. */

const STORAGE_KEY = 'catAssistant.settings';

export const DEFAULTS = Object.freeze({
  name: 'Cat Assistant',
  personality: 'friendly',
  alwaysOnTop: true,
  soundEffects: true,
  desktopNotifications: false,
  speakReplies: false,
  wakeWordEnabled: false,
  accent: 'gold',
});

export const PERSONALITIES = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'playful', label: 'Playful' },
  { value: 'blunt', label: 'Blunt' },
];

export const ACCENTS = [
  { value: 'gold', label: 'Gold', color: '#f2b90c' },
  { value: 'blue', label: 'Blue', color: '#5b8def' },
  { value: 'green', label: 'Green', color: '#3ecf8e' },
  { value: 'pink', label: 'Pink', color: '#ef6fa9' },
  { value: 'violet', label: 'Violet', color: '#a78bfa' },
];

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function resetSettings() {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULTS };
}

/** Applies `accent` as CSS custom properties on the given root element. */
export function applyAccent(root, accentValue) {
  const accent = ACCENTS.find((a) => a.value === accentValue) ?? ACCENTS[0];
  root.style.setProperty('--accent', accent.color);
}
