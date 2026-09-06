# Cat Assistant

A floating companion for MyTasks — a small always-on-top window with a cat
avatar, a chat you can talk to in plain English, and a settings panel to
tune how it looks and sounds. It's a separate front-end folder, but it is
**not a separate app**: same account, same tasks, same goals, same
`api/`, just a different window for reaching them.

```
http://localhost/xxp/mytasks/cat-assistant/
```

Sign in through the main app first (`web/index.html`) — this page reuses
that session via the same HttpOnly refresh cookie
([requireAuth()](../web/assets/js/api.js)), so if you're already signed in
elsewhere in this browser it opens straight up; if not, it sends you to the
normal MyTasks sign-in page and back.

## Why a separate folder, not a page in `web/`

Visually it's a deliberately different look — navy and gold, its own cat
mark — so it reads as its own little app, the way the reference mockup for
this feature did, rather than another MyTasks screen. Keeping it in its own
folder with its own `assets/css/app.css` makes that possible without
touching the main app's design system at all. Under the hood it leans on
the main app wherever it can instead of duplicating it:

- **Auth, tasks, goals** — imports `Api`/`requireAuth` straight from
  [`../web/assets/js/api.js`](../web/assets/js/api.js). One client, one
  source of truth for how requests, tokens and refresh work.
- **Icons** — [`assets/js/icons.js`](assets/js/icons.js) re-exports the
  main app's `Icons` from `ui.js` and only adds the handful this app's
  Settings sidebar needs that don't exist there yet (home, palette, brain,
  keyboard, bell).
- **Chat parsing** — [`assets/js/chat-engine.js`](assets/js/chat-engine.js)
  is a presentation-free adaptation of `web/assets/js/chatbox.js`'s command
  grammar and local-LLM fallback (same `/chat/interpret` endpoint). It's a
  parallel copy rather than a shared import because chatbox.js owns its own
  DOM and this widget renders very differently (avatar bubbles, a confirm
  step the caller renders) — see the comment at the top of that file.
- **Voice** — imports recording/transcoding straight from
  [`../web/assets/js/voice.js`](../web/assets/js/voice.js) (`isMicSupported`,
  `recordUntilSilence`, `toWav`) and `Api.voice.transcribe` from `api.js`.
  No parallel copy here — the mic pipeline has no UI opinions baked in, so
  there was nothing app-specific to diverge on.

## "Always on top", for real

The mini window/chat/settings mockup implies a window that floats above
*other applications*, not just this browser tab. A normal web page can't do
that — but Chromium's
[Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
(Chrome/Edge 116+) genuinely can: it hands you a real floating `Window`,
and [`assets/js/pip.js`](assets/js/pip.js) moves the whole widget's live DOM
into it (not a copy — the same elements, so every event listener keeps
working) and copies this app's stylesheet across since that window starts
with a blank document.

Click **Open Cat Assistant** to pop it out — this has to be a real click,
browsers won't let a page open a floating window on load. The window
resizes itself as you switch between the mini/chat/settings views (each has
its own footprint), and closing that floating window (its own close button,
Alt+F4, etc.) moves the widget straight back into the page.

Anywhere Document PiP isn't available (Firefox, Safari, older Chromium),
it falls back automatically to an ordinary fixed-position widget docked to
the corner of the page — same widget, same features, just confined to this
tab like the main app's chat box.

## Settings — what's real and what's cosmetic

Every control in Settings actually does something; nothing is a mockup:

| Tab | What it does |
|---|---|
| **General** | Cat Name and Personality are sent to `/chat/interpret` (see below). "Keep always on top" and "Play sound effects" are real toggles. |
| **Appearance** | Five accent colors, applied live via a CSS custom property — no page reload. |
| **AI** | Read-only: explains the two-layer parser and that the LLM step is a local Ollama model, never a cloud API. |
| **Voice** | Click the mic and just talk — it stops itself once you go quiet and transcribes locally via a **whisper.cpp server** you run yourself (`../web/assets/js/voice.js` + `POST /voice/transcribe`, see the main README), not the browser's cloud-backed `SpeechRecognition`. Not English-only — a multilingual whisper.cpp model + `WHISPER_LANGUAGE` (see `api/README.md`) understands other languages, Arabic included. Replies are read back with a local **Piper** voice if you've set one up (`POST /voice/speak`), else the browser's on-device `speechSynthesis`. A voice turn is always read back out loud; "Speak replies aloud" is the separate, persisted preference for typed messages. "Listen for 'hey buddy'" is a third, off-by-default toggle: a background mic whenever the widget is idle — closed, or minimized to the bubble (`listenForWake()`, same voice.js) — that transcribes each utterance locally and opens the chat when it hears "hey buddy"/"hey assistant"; paused while you're actually in the chat or settings view. |
| **Shortcuts** | Informational: Enter to send, Esc to return to the mini view. No fake global hotkey — a web page can't register an OS-wide one. |
| **Notifications** | Real desktop notifications (`Notification` API, permission requested on toggle) for tasks becoming due or overdue, polling the existing `/tasks/reminders` endpoint every 5 minutes. This is deliberately the *only* thing it notifies about — chat replies only ever happen right after you send a message, so there's nothing to notify about there. |
| **About** | Static info. |

There's intentionally no "Start with Windows" toggle like the reference
mockup's — a browser tab can't launch itself at boot, and a checkbox that
silently did nothing would be worse than not having it.

Settings are device-only preferences (`localStorage`, key
`catAssistant.settings`) — the same reasoning as the main dashboard's widget
layout: this is UI flavor, not account data, so it doesn't round-trip
through the API. **Personality** and **Cat Name** are the exception — those
two are sent as plain `persona`/`name` fields on `/chat/interpret` so the
model's tone actually changes; see
[`ChatController::TONES`](../api/src/Controllers/ChatController.php). The
web app's own chat box never sends either field, so its behavior is
completely unchanged by anything set here.

## Layout

```
cat-assistant/
├── index.html              launch screen + widget host
└── assets/
    ├── css/app.css         navy/gold theme (copied into the PiP window at runtime)
    └── js/
        ├── app.js          wires everything: views, PiP, settings, voice, notifications
        ├── chat-engine.js  command grammar + local-LLM fallback (data only, no DOM)
        ├── pip.js          Document Picture-in-Picture open/resize/close + style copying
        ├── settings.js     localStorage-backed preferences
        ├── icons.js        icon set (extends the main app's)
        └── avatar.js       the cat-robot face, inline SVG
```
