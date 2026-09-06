/* A small original cat-robot face — metallic head, triangular ears, glowing
   eyes — in the spirit of the reference mockup without reproducing its art.
   One inline SVG, sized by the caller; colors come from the CSS custom
   properties in app.css so it re-themes with the accent swatch picker. */
export function catAvatar(size = 40) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M18 30 L30 8 L40 30 Z" style="fill:var(--surface-3);stroke:var(--border-strong);stroke-width:2;stroke-linejoin:round"/>
      <path d="M82 30 L70 8 L60 30 Z" style="fill:var(--surface-3);stroke:var(--border-strong);stroke-width:2;stroke-linejoin:round"/>
      <rect x="4" y="42" width="12" height="24" rx="6" style="fill:var(--surface-3);stroke:var(--border-strong);stroke-width:2"/>
      <rect x="84" y="42" width="12" height="24" rx="6" style="fill:var(--surface-3);stroke:var(--border-strong);stroke-width:2"/>
      <rect x="14" y="24" width="72" height="62" rx="20" style="fill:var(--surface-2);stroke:var(--border-strong);stroke-width:2"/>
      <circle cx="37" cy="55" r="10" style="fill:var(--accent)"/>
      <circle cx="63" cy="55" r="10" style="fill:var(--accent)"/>
      <circle cx="37" cy="55" r="3.4" style="fill:var(--accent-ink)"/>
      <circle cx="63" cy="55" r="3.4" style="fill:var(--accent-ink)"/>
      <path d="M42 74 Q50 80 58 74" fill="none" style="stroke:var(--text-secondary);stroke-width:2.5;stroke-linecap:round"/>
    </svg>`;
}
