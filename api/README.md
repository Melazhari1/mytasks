# MyTasks API

RESTful JSON backend for the cross-platform task manager + credential vault.
Serves the web, desktop and mobile clients from one MySQL database.

**Zero dependencies.** No Composer, no vendor folder. JWT, TOTP and AES
encryption are implemented directly against PHP's `openssl` and `hash`
extensions, so this drops into a stock WAMP install and runs.

- PHP 8.1+ (tested on 8.4) with `pdo_mysql`, `openssl`, `mbstring`
- MySQL 5.7+ / MariaDB 10.4+

---

## Setup

```bash
# 1. Create the database and tables
mysql -u root -p < database/schema.sql

# 2. Generate APP_KEY and JWT_SECRET, writing them into a new .env
php tools/keygen.php --write

# 3. Edit .env if your MySQL credentials aren't the WAMP defaults
#    (root / empty password)

# 4. Check the security primitives are working
php tools/selftest.php

# 5. Optional — an account with demo data, so the dashboard isn't empty
php tools/seed-demo.php
```

### The demo account

`tools/seed-demo.php` creates a signed-up account with 6 goals, 25 tasks spread
across the last two weeks (some overdue, some done, four recurring) and 5
encrypted vault entries.

```
Email:     admin@mytasks.local
Password:  Admin123!
```

`--email=` / `--password=` / `--name=` override those; `--fresh` wipes that
account's data and re-seeds it.

Despite the name, **there is no admin role.** The API has no privilege levels at
all — every account is an ordinary user that can only ever reach its own rows,
enforced in the `WHERE` clause of every query. This is just a pre-filled account.

Two-factor still applies, so sign-in has a second step. With the default
`MAIL_DRIVER=log` the code isn't emailed — read it from the bottom of
`storage/logs/mail.log`. To skip that while you're looking around, set
`TWO_FACTOR_REQUIRED=false` in `.env`, and turn it back on before anyone else
can reach the app.

Then browse to `http://localhost/xxp/mytasks/api/health`. You should see
`{"status":"healthy","database":"ok",...}`.

If you get a 404, Apache's `mod_rewrite` is off. In WAMP: left-click the tray
icon → Apache → Apache modules → tick `rewrite_module`.

If you get a 500, check `storage/logs/php-error.log`.

### Two things that will bite you

**`APP_KEY` is not rotatable.** It encrypts every vault password. Change it
and every stored password becomes permanently unreadable. Back it up
separately from the database — an attacker with only the database dump cannot
decrypt anything, which is the entire point.

**Keep `APP_TIMEZONE` accurate.** The API pins the MySQL session timezone to
it on every connection, so PHP's clock and `NOW()` agree. If you insert rows
by hand through phpMyAdmin (which uses the server default), timestamps can
land an hour off from what the API expects.

---

## Architecture

```
api/
├── index.php                  front controller — CORS, error handling, dispatch
├── .htaccess                  rewrite everything to index.php, deny .env
├── .env                       secrets (never commit)
├── routes/api.php             every route in one readable file
├── database/schema.sql        full schema, import-ready
├── src/
│   ├── Core/                  Router, Request, Response, Database, Env, Autoloader
│   ├── Support/               Crypto, Jwt, Totp, Validator, RateLimiter, Mailer, Audit
│   ├── Middleware/            AuthMiddleware, VaultUnlockMiddleware
│   ├── Models/                data access — every query is a bound prepared statement
│   └── Controllers/           Auth, Category, Task, Vault
├── tools/
│   ├── keygen.php             generate APP_KEY / JWT_SECRET
│   ├── selftest.php           crypto + JWT + TOTP tests (no DB needed)
│   └── reminders.php          cron worker: fire due reminders, prune expired rows
└── storage/logs/              php-error.log, mail.log
```

### Security model

| Concern | Approach |
| --- | --- |
| Account passwords | Argon2id (bcrypt cost 12 fallback), rehashed on login when params change |
| Vault passwords | AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC), keys split from `APP_KEY` via HKDF |
| TOTP secrets | Encrypted at rest with the same scheme — a DB dump can't mint valid codes |
| Access tokens | JWT HS256, 15 min, `alg=none` and algorithm confusion rejected |
| Refresh tokens | Opaque random strings, SHA-256 hashed in the DB, **rotated on every use** |
| 2FA | TOTP (RFC 6238, verified against the spec's test vectors) or emailed OTP |
| Biometrics | Device-held key in the secure enclave; server stores only the public half + a replay counter |
| Vault reads | Separate short-lived unlock token required on top of the access token |
| Brute force | Per-IP+email rate limiting, plus account lockout after N failures |
| SQL injection | Bound parameters everywhere; sort columns come from a whitelist map |
| Auditing | Every login, 2FA event and vault reveal written to `audit_logs` |

Ownership is enforced in the `WHERE` clause of every query — `... WHERE id = ?
AND user_id = ?` — so one user cannot reach another's rows even with a valid
token and a guessed ID.

---

## Authentication flows

### Standard login (all clients)

```
POST /auth/login          { email, password }
   └─> { two_factor_required: true, method: "totp"|"email", challenge_token }

POST /auth/verify-2fa     { challenge_token, code }
   └─> { access_token, refresh_token, user }
```

The challenge token is valid for 5 minutes and is only accepted by
`/auth/verify-2fa` — a stolen one cannot call anything else.

With `MAIL_DRIVER=log` (the default), emailed codes are written to
`storage/logs/mail.log` instead of being sent. Read them there during
development.

### Mobile biometric login

Enrol once from an already-authenticated session, then sign in with a
fingerprint or face scan alone:

```
POST /auth/biometric/enroll        { device_id, device_name, platform, public_key? }
   └─> { device_secret }   # returned exactly once — store it in the keystore

POST /auth/biometric-challenge     { device_id }
   └─> { challenge, challenge_token, sign_payload }

POST /auth/mobile-biometric-login  { challenge_token, proof, counter }
   └─> { access_token, refresh_token, user }
```

Two proof modes:

- **Signature mode** (recommended) — send a PEM `public_key` at enrolment. The
  device signs `sign_payload` with the matching private key, held in the Secure
  Enclave / StrongBox behind a biometric access-control flag.
- **HMAC mode** — omit `public_key` and the server mints a `device_secret`.
  Simpler, still never transmitted at rest, but weaker than hardware signing.

The biometric check happens entirely on the device. The server never receives
fingerprint or face data — only proof that the OS released the key. `counter`
must strictly increase, which kills replay attacks.

### Session lifetime

```
POST /auth/refresh    { refresh_token }   # or the HttpOnly cookie
POST /auth/logout     { refresh_token }
POST /auth/logout-all                     # revoke every session
```

Refresh tokens rotate: the presented token is revoked the moment it's used. If
a stolen token is replayed, it simply fails.

Web clients get the refresh token as an `HttpOnly; SameSite` cookie and should
ignore the copy in the body. Desktop and mobile clients, which have no cookie
jar, use the body copy and store it in the OS credential store.

---

## Endpoints

Everything below `/auth` requires `Authorization: Bearer <access_token>`.

### Auth

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account |
| POST | `/auth/login` | Email + password, returns a 2FA challenge |
| POST | `/auth/verify-2fa` | Exchange the code for tokens |
| POST | `/auth/resend-otp` | New email code |
| POST | `/auth/refresh` | Rotate the session |
| POST | `/auth/logout` | Revoke this session |
| POST | `/auth/logout-all` | Revoke all sessions |
| GET | `/auth/me` | Current user |
| POST | `/auth/change-password` | Change password, revokes other sessions |
| POST | `/auth/2fa/setup` | Generate a TOTP secret + `otpauth://` URI for the QR code |
| POST | `/auth/2fa/confirm` | Confirm enrolment with a live code |
| POST | `/auth/2fa/disable` | Back to email codes |
| POST | `/auth/biometric/enroll` | Enrol this device |
| POST | `/auth/biometric-challenge` | Get a nonce to sign |
| POST | `/auth/mobile-biometric-login` | Sign in with the proof |
| GET | `/auth/devices` | Enrolled devices |
| DELETE | `/auth/devices/{deviceId}` | Un-enrol a device |

### Categories (Goals)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/categories` | List, with per-category task counts |
| POST | `/categories` | Create — `{ name, icon, color }` |
| GET | `/categories/{id}` | Single category |
| PUT/PATCH | `/categories/{id}` | Update |
| DELETE | `/categories/{id}` | Delete (its tasks cascade) |
| DELETE | `/categories` | Delete every goal — and their tasks — at once |

`color` must be a hex value like `#4F46E5`. Names are unique per user.

### Social Ideas

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/social-ideas` | List, paginated, with `?search=`/`?status=`/`?platform=` |
| POST | `/social-ideas` | Create — `{ idea, links, status, platforms }` |
| GET | `/social-ideas/{id}` | Single idea |
| PUT/PATCH | `/social-ideas/{id}` | Update |
| DELETE | `/social-ideas/{id}` | Delete |

`idea` and `links` are free-form multiline text — newlines are preserved as
sent. `status` is one of `pending` (default) / `future` / `done`. `platforms`
is a list of keys from `SocialIdeaController::PLATFORMS` (`youtube`,
`facebook`, `instagram`, `tiktok`, `x`, `linkedin`, `pinterest`, `snapchat`,
`whatsapp`, `telegram`, `threads`, `reddit`) — an unknown `status` or
`platforms` entry is a 422 (or a 400 for a bad `?status=`/`?platform=` query
filter). `?platform=` takes exactly one platform key and matches ideas
tagged with it (an idea can carry several). Filters: `?search=`, `?status=`,
`?platform=`, `?sort=created_at|updated_at`, `?dir=asc|desc`,
`?page=`, `?per_page=` (default 12, max 100).

### Budget

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/budget/months` | List months (with per-month score), optional `?year=` |
| GET | `/budget/months/{year}/{month}` | One month — salary, entries, breakdown, score |
| PUT | `/budget/months/{year}/{month}` | Create-or-update the salary for that period |
| DELETE | `/budget/months/{year}/{month}` | Delete the month and its entries |
| POST | `/budget/months/{year}/{month}/entries` | Add an entry — `{ name, price, category }` |
| PUT | `/budget/entries/{id}` | Update an entry |
| DELETE | `/budget/entries/{id}` | Delete an entry |

One `budget_months` row per user per calendar month holds the salary;
`budget_entries` are the `(name, price, category)` lines against it, where
`category` is one of `need` / `want` / `save`. `GET`/`PUT` on a month never
404 for a period with no data yet — an unset month reads back as salary 0,
no entries, score `null` — but `POST .../entries` does create the month row
(salary 0) if it doesn't exist, so entries can be logged before a salary is.

The score compares real spending per category against the 50/30/20 rule:
for each category, `real_pct` is that category's spend ÷ salary; summing
`|real_pct - target_pct|` across need/want/save gives one "how far off the
standard split" number — 0 is a perfect match. That deviation scaled onto
0-5 and clamped is the score (`5 - deviation × 5`, floored at 0). No salary
set means no ratios to score, so `score` comes back `null` rather than a
misleading number. See `BudgetController::summarize()` for the exact math.

### Tasks

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/tasks` | List with filters |
| POST | `/tasks` | Create |
| GET | `/tasks/summary` | Dashboard counts |
| GET | `/tasks/reminders` | Reminders ready to fire |
| GET | `/tasks/{id}` | Single task |
| PUT/PATCH | `/tasks/{id}` | Update — mark done, change priority, reschedule |
| POST | `/tasks/{id}/toggle` | Flip pending/completed (for a checkbox tap) |
| DELETE | `/tasks/{id}` | Delete |

Filters: `?date=today|tomorrow|week|month|overdue|upcoming|none|YYYY-MM-DD`,
`?priority=low|medium|high`, `?status=pending|completed`, `?category_id=`,
`?search=`, `?sort=due_date|priority|created_at|title`, `?dir=asc|desc`,
`?page=`, `?per_page=`.

The schema stores one `DATETIME`, but the spec separates date and time, so the
API accepts both and always returns both:

```jsonc
// send either shape
{ "due_date": "2026-08-15", "due_time": "18:30" }
{ "due_at": "2026-08-15 18:30" }

// always get back
{ "due_date": "2026-08-15", "due_time": "18:30",
  "due_at": "2026-08-15 18:30:00",
  "notify_before_minutes": 60,
  "remind_at": "2026-08-15 17:30:00",   // computed for you
  "is_overdue": false }
```

Completing a **recurring** task doesn't close it — the due date rolls forward
one day or one week and the status returns to `pending`. If the task was badly
overdue, it skips to the next future slot rather than firing a burst of missed
reminders.

### Vault

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/vault` | List platforms + usernames — **never** passwords |
| POST | `/vault` | Store `{ platform_name, username, password, notes }` |
| GET | `/vault/generate-password` | Strong password generator (`?length=24&symbols=1`) |
| POST | `/vault/master-password` | Set a vault-specific master password |
| POST | `/vault/unlock` | Exchange master password / OTP for an unlock token |
| POST | `/vault/unlock/request-otp` | Email an unlock code instead |
| GET | `/vault/{id}` | Metadata for one entry |
| PUT/PATCH | `/vault/{id}` | Update, including rotating the password |
| DELETE | `/vault/{id}` | Delete |
| POST | `/vault/{id}/reveal` | **Decrypt and return one password** |
| GET | `/vault/export/all` | Decrypt everything (heavily rate limited) |

Reveal requires two things: a valid access token *and* a fresh unlock token.

```bash
# 1. unlock (5 min lifetime)
curl -X POST .../vault/unlock \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"password":"your-account-password"}'

# 2. reveal
curl -X POST .../vault/17/reveal \
  -H "Authorization: Bearer $ACCESS" \
  -H "X-Vault-Token: $VAULT_TOKEN"
```

Until a master password is set, `/vault/unlock` accepts the account password.
Once set, only the master password (or an emailed OTP) works. Every reveal is
rate limited and written to `audit_logs`.

---

## Response shape

Success:

```json
{ "data": { ... }, "meta": { "total": 42, "page": 1 } }
```

Failure:

```json
{ "error": "validation_failed",
  "message": "The submitted data is invalid.",
  "errors": { "email": ["The email must be a valid email address."] } }
```

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed JSON or a bad query parameter |
| 401 | `unauthorized` / `token_expired` | Missing, invalid or expired token |
| 403 | `forbidden` / `vault_locked` | Authenticated but not permitted; vault needs unlocking |
| 404 | `not_found` | No such route, or the row isn't yours |
| 405 | `method_not_allowed` | Right path, wrong verb |
| 409 | `conflict` | Duplicate email or category name |
| 422 | `validation_failed` | Field errors, all of them at once |
| 423 | `account_locked` | Too many failed logins |
| 429 | `too_many_requests` | Rate limited — see `retry_after` |
| 503 | `database_unavailable` | Can't reach MySQL |

---

## Reminders

`tools/reminders.php` finds tasks whose `notify_before_minutes` window has
opened, notifies once, marks them notified, and prunes expired tokens and OTPs.

Windows Task Scheduler, every minute:

```
C:\wamp64\bin\php\php8.3.0\php.exe C:\wamp64\www\xxp\mytasks\api\tools\reminders.php
```

Linux cron:

```
* * * * * php /var/www/mytasks/api/tools/reminders.php >> /var/log/mytasks-reminders.log
```

It sends email through `Mailer` by default. Swap the `notify()` function for
FCM or APNs when the mobile push channel is ready.

---

## Backups

`tools/backup.php` zips the whole project — `api/`, `web/`, everything — and
bundles a plain-SQL database dump inside as `database.sql`. No `mysqldump`
dependency; the dump is written straight through the same PDO connection the
app already uses.

```bash
php tools/backup.php                # local zip in api/storage/backups/
php tools/backup.php --upload       # also push to Google Drive
php tools/backup.php --keep=20      # local backups to retain (default 10)
```

Windows Task Scheduler, nightly:

```
C:\wamp64\bin\php\php8.x.x\php.exe C:\wamp64\www\xxp\mytasks\api\tools\backup.php --upload
```

The archive contains `api/.env` — `APP_KEY`, `JWT_SECRET`, the DB password —
because restoring the vault's encrypted passwords requires `APP_KEY`. Handle
every backup file exactly as carefully as `.env` itself. Set
`BACKUP_ZIP_PASSWORD` to AES-256 encrypt everything inside the zip with a
passphrase, particularly before it leaves this server for Drive.

**Google Drive** uses a service account, not your personal Google login —
no OAuth consent screen, no browser step:

1. In Google Cloud Console, create a service account and download its JSON key.
2. Share a Drive folder with the key's `client_email` (Editor access) — a
   service account has no storage quota of its own, so uploads fail without one.
3. Set `GOOGLE_SERVICE_ACCOUNT_FILE` (path to the key) and
   `GOOGLE_DRIVE_FOLDER_ID` (that folder's ID, from its URL) in `.env`.

### The Settings page button

There is no admin role in this API (see above) — every account is an
ordinary user. A full backup reaches every user's data, so it is not gated by
a normal access token alone: Settings → Backups asks for `BACKUP_KEY`, a
separate secret set in `.env`, before it will list, create or download
anything. Leave `BACKUP_KEY` blank to disable that surface entirely; the CLI
tool never needs it.

---

## Chat box AI fallback (optional, local)

The web client's command chat (`web/assets/js/chatbox.js`) parses most
commands itself, no network call involved. Anything it doesn't recognize is
POSTed to `/chat/interpret` ([ChatController](src/Controllers/ChatController.php)),
which asks a **locally-running [Ollama](https://ollama.com)** model to turn
the free-form message into a structured command. This is not a cloud
service — no API key, nothing leaves the machine `OLLAMA_URL` points at.

Setup:

```bash
# Install Ollama, then:
ollama pull llama3.1
ollama serve                  # listens on http://127.0.0.1:11434 by default
```

`.env`:

```
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1
OLLAMA_TIMEOUT=60
```

These already default to the values above, so if Ollama is running locally
with `llama3.1` pulled, no `.env` changes are needed at all. If Ollama isn't
running, `/chat/interpret` returns `503 ollama_unavailable` and the chat box
says so — the fixed-grammar parser it falls back from keeps working
regardless. [OllamaClient](src/Support/OllamaClient.php) never throws on a
failed call, by design, so a missing/unreachable Ollama degrades this one
feature rather than the request.

On the Windows installer, Ollama runs as a background service that starts
automatically and already owns port 11434 — running `ollama serve` yourself
on top of that fails with "Only one usage of each socket address..." (that's
expected; it just means Ollama is already up, nothing to fix). Check with
`curl http://127.0.0.1:11434/api/tags`.

A CPU-bound local model is genuinely slow — 10-25s for a single reply on
modest hardware, more under load, since a "small" LLM here still means
several billion parameters. That's why `OLLAMA_TIMEOUT` defaults to 60s
rather than the usual few seconds for a normal API call.

---

## Voice (optional, local)

Two independent, optional pieces — set up either, both, or neither. Without
them the mic button and speaker just don't appear / fall back to the
browser's own APIs; nothing else in the app is affected.

### Input: mic → text

The mic button in both chat UIs (`web/assets/js/voice.js`) records a clip
in the browser, stops itself once you go quiet, and uploads it to
`/voice/transcribe` ([VoiceController](src/Controllers/VoiceController.php)),
which forwards it to a **locally-running
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) server** for
transcription. Same reasoning as the Ollama fallback above: this is not a
cloud service, nothing leaves the machine `WHISPER_URL` points at.

This matters more here than for Ollama, because the alternative isn't
"nothing" — the browser's own `SpeechRecognition` API works with zero setup
at all, but in Chrome/Edge it silently sends your microphone audio to
Google's servers to transcribe it. This app doesn't use that; every word
you say to it goes to whisper.cpp on `WHISPER_URL` and nowhere else.

Setup — **clone this somewhere outside `www/`** (e.g. `C:\wamp64\whisper.cpp`,
a sibling of `www`, not inside it). It's a standalone server process, not
part of the site; anything under `www/` is reachable by URL unless
specifically blocked, and there's nothing guarding a folder Apache doesn't
already know about. If you do clone it inside the project anyway, the
`.htaccess` two levels up (`whisper.cpp/.htaccess`) blocks it the same way
`api/.htaccess` blocks `.env` — but outside `www/` is the real fix, since it
means there's nothing to remember to block in the first place.

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
sh ./models/download-ggml-model.sh base.en   # a small English model; try "small.en" for more accuracy
cmake -B build && cmake --build build --config Release
./build/bin/whisper-server -m models/ggml-base.en.bin --port 8081
```

(Windows needs a C++ toolchain for that `cmake --build` step — Visual
Studio's "Desktop development with C++" workload, or build under WSL. Check
whisper.cpp's own releases page first; a prebuilt Windows binary sometimes
means skipping the compile step entirely. Also on Windows: CMake's default
generator there is Visual Studio, a multi-config build, so the binary lands
in `build\bin\Release\whisper-server.exe`, not `build\bin\whisper-server` —
adjust the last line above accordingly. The binary itself has also been
renamed across whisper.cpp versions — `whisper-server` in current releases,
plain `server` in older ones; run `whisper-server --help` or check
`build/bin/` if the command above doesn't exist.)

`.env`:

```
WHISPER_URL=http://127.0.0.1:8081
WHISPER_TIMEOUT=60
WHISPER_LANGUAGE=auto
```

These already default to the values above. If whisper.cpp's server isn't
running, `/voice/transcribe` returns `503 whisper_unavailable` and the chat
says so plainly — typed messages and the mic-less parts of the app are
completely unaffected either way. [WhisperClient](src/Support/WhisperClient.php)
never throws on a failed call, same fails-soft contract as `OllamaClient`.

**Other languages (e.g. Arabic).** `base.en`/`small.en`/etc are **English-only**
models — no setting on this end can make one understand another language,
the vocabulary simply isn't in it. Download a **multilingual** model instead
(no `.en` in the name — `base`, `small`, `medium`, `large-v3`, ...; bigger
generally means meaningfully better accuracy on non-English speech, at the
cost of a slower transcription per clip) and point `-m` at it when starting
the server:

```bash
sh ./models/download-ggml-model.sh medium
./build/bin/whisper-server -m models/ggml-medium.bin --port 8081
```

`WHISPER_LANGUAGE=auto` (the default) then lets whisper.cpp detect Arabic,
English, French, etc. on its own, clip by clip — handy if you switch
between languages. Auto-detection is less reliable on very short clips
(a one- or two-word "hey buddy" wake phrase, say) than on a full sentence; if
it keeps guessing wrong, pin it to a fixed code instead, e.g. `WHISPER_LANGUAGE=ar`.

### Output: text → realistic speech

By default, the speaker (and every voice turn) reads replies aloud with the
browser's own `speechSynthesis` — zero setup, fully on-device, but clearly
synthetic. Set `PIPER_EXE_PATH` and `PIPER_MODEL_PATH` to switch to
**[Piper](https://github.com/rhasspy/piper)**, a small local neural
text-to-speech engine, for a much more natural voice — still fully private,
the reply text goes only to `PiperClient` on this machine, never a cloud API.

Unlike whisper.cpp, Piper ships as a plain CLI binary — no server to keep
running. `POST /voice/speak` ([VoiceController](src/Controllers/VoiceController.php))
shells out to it per request via `proc_open()` (an array command, so there's
no shell string to escape — the exact class of bug that bit the whisper.cpp
setup above) and streams back the WAV it writes.

Setup — download a Piper release for your OS from its releases page, plus
one voice: a matching pair of files sharing a name, e.g.
`en_US-lessac-medium.onnx` and `en_US-lessac-medium.onnx.json` (**both**
required, same folder — the `.json` holds the voice's phoneme config).
Piper's own voice samples page links every available voice if you want to
compare before picking one.

`.env`:

```
PIPER_EXE_PATH=C:\wamp64\piper\piper.exe
PIPER_MODEL_PATH=C:\wamp64\piper\en_US-lessac-medium.onnx
PIPER_TIMEOUT=20
```

Leave both blank (the default) to keep using the browser voice. If Piper
errors out or the paths are wrong, `/voice/speak` returns `503
piper_unavailable` and the frontend falls back to `speechSynthesis`
automatically — same fails-soft contract as whisper.cpp and Ollama.

---

## Before going to production

- [ ] `APP_DEBUG=false` and `APP_ENV=production`
- [ ] Serve over HTTPS, then set `REFRESH_COOKIE_SECURE=true`
- [ ] Replace `CORS_ALLOWED_ORIGINS=*` with your actual client origins
- [ ] Create a dedicated MySQL user — not `root` — with rights on this schema only
- [ ] Point `MAIL_DRIVER` at real SMTP so OTPs actually get delivered
- [ ] Back up `APP_KEY` somewhere separate from the database
- [ ] Confirm `.env` is not web-reachable: `curl https://your-host/.../api/.env` should 403
