# MyTasks — web client

The browser front-end for the MyTasks API. Vanilla HTML, CSS and ES modules —
**no build step, no npm install, no framework**. Drop it in `www` and open it.

## Setup

1. Get the API running first (see `../api/README.md`) — this app is useless
   without it.
2. Open **http://localhost/xxp/mytasks/web/**

That's the whole setup. The client finds the API by stripping its own folder
off its URL, so `…/xxp/mytasks/web/` talks to `…/xxp/mytasks/api`. Move the
folder anywhere and it keeps working, as long as `api/` stays a sibling.
The same trick is how [`cat-assistant/`](../cat-assistant/) — a separate
floating-window companion, see its own README — talks to the same API.

No account yet? Click **Create one** on the sign-in screen. With
`MAIL_DRIVER=log` (the default) the 2FA code isn't emailed — read it from
`api/storage/logs/mail.log`. The sign-in screen tells you this when it applies.

### Running without Apache

`php -S 127.0.0.1:8080 -t .. ../dev-server.php`, then open
http://127.0.0.1:8080/web/ — `dev-server.php` does the job `.htaccess` does
under WAMP.

---

## Layout

```
web/
├── index.html          sign-in, 2FA, registration
├── dashboard.html      stat tiles + charts + what's next
├── tasks.html          filterable task list
├── categories.html     goals, with progress
├── social-ideas.html   social media idea/link cards, tagged by platform
├── budget.html         monthly salary + spending, scored against 50/30/20
├── vault.html          credentials, lock/unlock/reveal
├── settings.html       account, 2FA, vault lock, devices, theme, sessions
└── assets/
    ├── css/app.css     the whole design system, two themes
    └── js/
        ├── api.js      fetch client, token handling, route guards
        ├── ui.js       theme, mascot, icons, toasts, modals, formatting
        ├── charts.js   hand-rolled SVG charts
        ├── qr.js       QR encoder (see below)
        ├── chatbox.js  the command chat (see below)
        ├── tasks-shared.js  the task dialog, shared by two pages
        └── page-*.js   one per screen
```

---

## The command chat

A floating widget, bottom-right on every signed-in page (`chatbox.js`, mounted
by each `page-*.js` via `initChatBox()`). It has two layers:

```
add task Buy milk
add task Buy milk goal Groceries due tomorrow priority high
add task do push ups in goal fitness for friday
add goal Groceries
list tasks               (also: today / tomorrow / overdue / done / a goal name)
list goals
done Buy milk             marks a matching open task complete
delete task Buy milk
delete goal Groceries
```

**Layer 1 — a fixed-grammar parser**, entirely in the browser, no network
call, same spirit as the hand-rolled QR encoder and charts. `add task` flags
can come in any order and in a few natural phrasings — `goal`/`in goal`/
`under goal`, `priority`/`with priority`, `due`/`due on`/`due by`, or the
shorthand `for`/`on`/`by` immediately before a recognized date word (guarded
so ordinary titles like "Prepare slides **for** the client" aren't mangled —
only a title-ending trigger phrase followed by something that's actually a
date counts). Leave off the goal and the task files under whichever goal was
created most recently. Dates understand `today`, `tomorrow`, a weekday name
(next occurrence — not today, even if today is one), or `YYYY-MM-DD`.

`done` and `delete` match against your open (or all) tasks by a
case-insensitive substring on the title — ambiguous matches list the
candidates instead of guessing. Deletes always show a confirm/cancel pair
before touching anything.

**Layer 2 — a local LLM fallback.** Anything layer 1 doesn't recognize is
sent to the API's `POST /chat/interpret`
([ChatController](../api/src/Controllers/ChatController.php)), which asks a
**locally-running Ollama model** (`OLLAMA_URL` in `api/.env`, default
`llama3.1`) to turn the message into the same kind of structured command —
free-form phrasing like "remind me to call the dentist next monday" or
"what's overdue" works even though neither matches layer 1's grammar. This
is not a cloud API: Ollama runs on the same machine as the API, there's no
API key, and nothing about a message goes anywhere outside `OLLAMA_URL`. If
Ollama isn't installed or isn't running, `/chat/interpret` returns a 503 and
the chat says so plainly rather than pretending to understand — layer 1 still
works either way. See `api/README.md` for setup (`ollama pull llama3.1`,
`ollama serve`).

**Voice — talk to it, Jarvis-style.** Click the mic once and just speak; it
stops recording itself once you go quiet (`assets/js/voice.js`, a small
volume monitor via the Web Audio API — no manual "stop" click needed),
transcribes the clip, sends it as your message, and reads the reply back out
loud automatically. Transcription is a **local
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) server** you run
yourself (`POST /voice/transcribe`, see `api/README.md`) — deliberately not
the browser's built-in `SpeechRecognition`, which in Chrome/Edge sends your
audio to Google's servers to transcribe it; whisper.cpp never leaves the
machine `WHISPER_URL` points at. It isn't English-only — with a multilingual
model and `WHISPER_LANGUAGE` (see `api/README.md`), it understands whatever
language you speak to it, Arabic included. Reading replies aloud tries a locally
installed **[Piper](https://github.com/rhasspy/piper)** voice first
(`POST /voice/speak`, see `api/README.md`) for a natural-sounding reply;
if it isn't set up, it falls back automatically to the browser's own
`speechSynthesis` — more robotic, but zero install, so speech always works.

The header's speaker icon is a separate, persisted preference for *typed*
messages — turn it on and every reply gets read aloud, not just the ones
you asked by voice. A voice turn always gets read back regardless of that
toggle: if you asked out loud, you want to hear the answer. The mic button
only appears in a browser that can record audio at all; if whisper.cpp's
server isn't running, using it says so plainly rather than pretending to
transcribe.

**Wake word — "hey buddy".** The header's ear icon (off by default) keeps a
mic open in the background — `listenForWake()` in `assets/js/voice.js` —
and transcribes each utterance it hears the same way, purely to check it
against a short fixed phrase list ("hey buddy", "hey assistant", a couple
variants). Say it and the panel opens on its own; say something right after
it in the same breath ("hey buddy, add task Buy milk") and that becomes the
first message, Alexa-style — otherwise it just starts a voice turn and
waits for you to say the command. Paused the moment the panel is already
open (nothing to wake into, and it'd otherwise hear the bot's own spoken
replies), resumed when it closes.

---

## How tokens are handled

The access token lives in `sessionStorage`: it expires in 15 minutes and dies
with the tab. The refresh token is an **HttpOnly cookie** that JavaScript can
never read — the browser attaches it automatically. An XSS bug can therefore
steal at most one short-lived access token, not a 30-day session.

When any call returns 401, the client refreshes once and replays the original
request. Concurrent 401s share a single refresh so a page firing five requests
doesn't burn five refresh tokens.

The **vault unlock token is memory-only**. It is never written to storage, so it
cannot survive a reload, a new tab, or a machine someone walked away from.

The refresh cookie's path is derived from where the API actually sits, so
moving the project can't silently break session refresh.

---

## The design

Built from the poster: near-black surfaces, a violet rim light, a faint circuit
grid, and a hooded cat with glowing eyes.

**The mascot is the supplied artwork** (`assets/img/`), served through
`ui.js` → `catMascot` (the full character, on the sign-in screen and in every
empty state) and `catBadge` (a head-and-eyes crop, for the sidebar mark and
avatars — at 38px the glowing eyes are what carry it).

It is **framed, not cut out.** The artwork was drawn on a near-black backdrop
and its blue rim light bleeds continuously into it, so there is no clean edge to
key on — matting it leaves a ragged halo, and a tighter threshold clips the rim
light that gives the character its shape. Framing keeps the art intact: on dark
the frame melts into the surface, on light it reads as a deliberate poster
panel. Corners are rounded in CSS, so the files stay JPEG with no alpha channel
to pay for and no matte fringing.

Image paths resolve from `import.meta.url`, not relative to the page, so they
keep working from any HTML file at any folder depth.

**Light mode is a selected palette, not an inversion.** Every token — surfaces,
text, chart series — is re-picked for the light surface. Dark is the default;
your choice is remembered.

---

## The charts

Hand-rolled SVG in `charts.js` — a line chart, a horizontal bar chart, and a
completion meter. No chart library.

Colours come from CSS custom properties, so switching theme **re-draws** every
chart against the new surface rather than filtering the old one. The chart
palette was validated by computation, not by eye:

| Role | Light | Dark |
| --- | --- | --- |
| Series 1 (Created) | `#6d4fe0` | `#8b7cf6` |
| Series 2 (Completed) | `#0092b6` | `#17a2c2` |
| Priority high / medium / low | `#5232c4` / `#7d5ce8` / `#a692f0` | `#a795ff` / `#7a68e2` / `#4b3fa8` |

Both series pairs clear every gate in both modes — colour-blind separation
(all-pairs ΔE 13.4 light / 9.4 dark against a target of 8), the normal-vision
floor (20.1 / 16.8 against a floor of 15), the lightness band, the chroma floor,
and 3:1 contrast against the chart surface. Priority is a single violet hue
stepped light→dark, because low/medium/high is an *ordered* scale, not three
unrelated categories.

Rules the charts hold themselves to:

- Gridlines and axes are solid hairlines — never dashed, never heavy.
- The **step** is rounded, not the max, so an axis reads 0·1·2·3·4·5 rather than
  0·1·3·4·5.
- Bars are anchored square to the baseline with a 4px rounded data-end.
- Direct labels are selective: the endpoint of a line, the value beside a bar —
  never a number on every point.
- A legend appears whenever there are two or more series, and never for one.
- **Every chart ships a data table.** "Show data table" under each one gives the
  numbers without needing to see colour at all.
- Every chart has a hover layer: a crosshair and shared tooltip on the line
  chart, per-bar tooltips with share-of-total on the bars.
- Charts are drawn in real pixels and re-drawn on resize, so an 11px label is
  11px on a phone too.
- Goal colours are yours to pick and are used only as labels — charts never read
  them, so no choice you make there can render a chart unreadable.

---

## The QR code

`qr.js` is a small QR encoder (byte mode, ECC level L, versions 1–13) written
for one reason: the obvious way to draw the 2FA enrolment QR is to hand the
`otpauth://` URI to a public chart-image service, and **that URI contains the
TOTP shared secret**. Doing it that way emails a third party the one value that
makes two-factor worth having. This keeps it on the device.

It was verified against a reference encoder — matrices are bit-identical across
all 13 versions at 37 boundary lengths, and every generated code decodes
byte-exact through a real QR reader.

---

## Browser support

Anything current. It uses ES modules, `<dialog>`, CSS custom properties,
`ResizeObserver` and `color-mix()` — Chrome/Edge 111+, Firefox 113+, Safari
16.4+. No transpiler, no polyfills.

Clipboard copy needs a secure context; `http://localhost` counts, a plain-http
LAN address does not, so there's a `document.execCommand` fallback for that case.
