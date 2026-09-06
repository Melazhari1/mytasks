/* =============================================================================
   Real "always on top" via the Document Picture-in-Picture API (Chromium
   116+): a genuine floating OS-level window, not just a CSS layer above the
   rest of this page. https://developer.chrome.com/docs/web-platform/document-picture-in-picture

   Only works from a user gesture (a click), can't self-open on page load,
   and only exists in Chromium browsers — isSupported() lets the caller fall
   back to an ordinary in-page fixed-position widget everywhere else.
   ========================================================================== */

export function isSupported() {
  return 'documentPictureInPicture' in window;
}

/**
 * Opens (or resizes, if already open) the floating window and moves
 * `root` into it. Copies every stylesheet from the current document across —
 * a PiP window has its own blank document — and calls `onClose` once when
 * the user closes that floating window (its OS-drawn close button, Alt+F4,
 * etc.), so the caller can move `root` back and update its own UI state.
 *
 * Returns the PiP `Window`, or null if the browser doesn't support this.
 */
export async function openFloating(root, { width, height, onClose }) {
  if (!isSupported()) return null;

  const existing = window.documentPictureInPicture.window;

  if (existing) {
    existing.resizeTo(width, height);
    return existing;
  }

  const pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });

  copyStylesInto(pipWindow);
  pipWindow.document.body.style.margin = '0';
  pipWindow.document.body.appendChild(root);

  pipWindow.addEventListener('pagehide', () => onClose(), { once: true });

  return pipWindow;
}

export function resizeFloating(width, height) {
  window.documentPictureInPicture?.window?.resizeTo(width, height);
}

export function closeFloating() {
  window.documentPictureInPicture?.window?.close();
}

function copyStylesInto(pipWindow) {
  [...document.styleSheets].forEach((sheet) => {
    try {
      const rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      const style = pipWindow.document.createElement('style');
      style.textContent = rules;
      pipWindow.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet (none expected here, same-origin only) — link it instead.
      if (!sheet.href) return;
      const link = pipWindow.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      pipWindow.document.head.appendChild(link);
    }
  });
}
