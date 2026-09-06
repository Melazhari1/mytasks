/* Cat Assistant's own small icon set — same 24×24 stroke/currentColor idiom
   as web/assets/js/ui.js (so a CSS color just works), extended with the
   handful of glyphs this app's Settings sidebar needs that the main app's
   icon set doesn't have (home, palette, brain, keyboard, bell). `mic` and
   `volume`/`volumeOff` now live in the shared set (web/chatbox.js needs them
   too, for its own voice controls) and are inherited via the spread below. */
import { Icons as SharedIcons } from '../../../web/assets/js/ui.js';

const ico = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const Icons = {
  ...SharedIcons,
  home: ico('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/><path d="M9 20v-6h6v6"/>'),
  palette: ico('<path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a3 3 0 0 0 3-3 8 8 0 0 0-8-8Z"/><circle cx="7.5" cy="12" r="1.2"/><circle cx="9.5" cy="7.5" r="1.2"/><circle cx="14.5" cy="7.5" r="1.2"/><circle cx="16.5" cy="12" r="1.2"/>'),
  brain: ico('<path d="M9 4a2.5 2.5 0 0 0-2.5 2.5V7a2.5 2.5 0 0 0-1.5 4.5A2.5 2.5 0 0 0 6.5 16v.5A2.5 2.5 0 0 0 9 19"/><path d="M15 4a2.5 2.5 0 0 1 2.5 2.5V7a2.5 2.5 0 0 1 1.5 4.5A2.5 2.5 0 0 1 17.5 16v.5A2.5 2.5 0 0 1 15 19"/><path d="M9 4v15M15 4v15M6.5 9h2.5M6.5 14h2.5M15 9h2.5M15 14h2.5"/>'),
  keyboard: ico('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>'),
  bell: ico('<path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
};
