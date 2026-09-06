/* =============================================================================
   Command chat — a floating widget for running simple text commands instead
   of clicking through forms: "add task Buy milk", "list tasks today", "done
   Buy milk".

   Two layers:
    1. A small fixed-grammar parser (COMMANDS below) — instant, no network,
       handles the documented syntax and a fair bit of natural phrasing
       ("add task do push ups in goal fitness for tomorrow") on its own.
    2. Anything that doesn't match falls back to POST /chat/interpret, which
       asks a LOCAL Ollama model (see api/src/Support/OllamaClient.php) to
       turn the message into a structured command. This never calls a cloud
       API — Ollama runs on the same machine as the API — and if it isn't
       running, the chat just says so and keeps working off layer 1.

   Voice, "talk to it Jarvis-style": click the mic once, speak, it stops
   itself once you go quiet, transcribes locally (a whisper.cpp server you
   run yourself — see api/README.md — not a cloud speech API), sends the
   message, and reads the reply back out loud automatically. Speaking
   replies for *typed* messages too is a separate, persisted preference
   (the header's speaker toggle) — voice turns always get read back
   regardless of that toggle, since if you asked by voice you want to hear
   the answer. Text-to-speech tries a locally-installed Piper first (see
   api/.env.example — a small CLI, not a server) for a natural-sounding
   voice; if it isn't set up, it falls back to the browser's own
   speechSynthesis, which is more robotic but needs no install.

   Wake word, "hey buddy"/"hey assistant": the header's ear icon turns on
   listenForWake() (voice.js) — a mic that stays open in the background and
   transcribes each utterance it hears locally (same whisper.cpp path as the
   mic button) purely to check it against a short fixed phrase list
   (matchWake()). Paused whenever the panel is already open (nothing to wake
   into, and it'd otherwise pick up the bot's own spoken replies), resumed
   when it closes. Opt-in and off by default since it's continuous mic
   access, unlike the mic button's one-shot recording.

   Mounted once per page via initChatBox() — see the bottom of every page-*.js
   file. Lives entirely in this module; nothing else reaches into its state.
   ========================================================================== */
import { Api, ApiError } from './api.js';
import { Icons, escapeHtml, formatDate } from './ui.js';
import { isMicSupported, recordUntilSilence, toWav, listenForWake, matchWake } from './voice.js';
import { T, detectLang, defaultLang } from './chat-strings.js';

const SPEAK_KEY = 'mytasks.chatbox.speak';
const WAKE_KEY = 'mytasks.chatbox.wake';
// If whisper.cpp is down, or a noisy mic keeps tripping the volume gate on
// sustained background noise (not just a brief blip — see minUtteranceMs in
// voice.js), wake listening can end up firing transcribe request after
// transcribe request that all fail. Left unchecked that's a flood that
// starves out the very voice input the user is trying to use. Stop after a
// few in a row instead of retrying forever.
const WAKE_MAX_CONSECUTIVE_FAILS = 3;

let panel, messageHost, form, input, toggleBtn, speakBtn, micBtn, wakeBtn;
let open = false;
let welcomed = false;
let categoriesCache = null;
let speakEnabled = localStorage.getItem(SPEAK_KEY) === '1';
let wakeEnabled = localStorage.getItem(WAKE_KEY) === '1';
let recording = null; // the { stop, done } handle from recordUntilSilence(), while a voice turn is in progress
let wakeSession = null; // the { stop } handle from listenForWake(), while wake-word listening is active

export function initChatBox() {
  if (document.querySelector('[data-chatbox]')) return; // already mounted this page load

  buildDom();
  wireEvents();
}

/* --- Chrome ----------------------------------------------------------------- */
function buildDom() {
  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'chatbox-toggle';
  toggleBtn.setAttribute('aria-label', 'Open command chat');
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.innerHTML = Icons.chat;
  document.body.appendChild(toggleBtn);

  panel = document.createElement('div');
  panel.className = 'chatbox-panel';
  panel.hidden = true;
  panel.setAttribute('data-chatbox', '');
  panel.innerHTML = `
    <div class="chatbox-panel__head">
      <b>Commands</b>
      <button type="button" class="icon-btn" data-chatbox-wake aria-label="Listen for &quot;hey buddy&quot;" aria-pressed="false" hidden></button>
      <button type="button" class="icon-btn" data-chatbox-speak aria-label="Read replies aloud" aria-pressed="false" hidden></button>
      <button type="button" class="icon-btn" data-chatbox-close aria-label="Close chat"></button>
    </div>
    <div class="chatbox-panel__messages" data-chatbox-messages></div>
    <form class="chatbox-panel__input" data-chatbox-form>
      <label class="visually-hidden" for="chatbox-input">Command</label>
      <input type="text" id="chatbox-input" placeholder="add task Buy milk…" autocomplete="off">
      <button type="button" class="icon-btn" data-chatbox-mic aria-label="Voice input" hidden></button>
      <button type="submit" class="icon-btn" aria-label="Send"></button>
    </form>`;
  document.body.appendChild(panel);

  panel.querySelector('[data-chatbox-close]').innerHTML = Icons.x;
  panel.querySelector('button[type="submit"]').innerHTML = Icons.send;
  panel.querySelector('[data-chatbox-mic]').innerHTML = Icons.mic;

  messageHost = panel.querySelector('[data-chatbox-messages]');
  form = panel.querySelector('[data-chatbox-form]');
  input = panel.querySelector('input');
  wakeBtn = panel.querySelector('[data-chatbox-wake]');
  speakBtn = panel.querySelector('[data-chatbox-speak]');
  micBtn = panel.querySelector('[data-chatbox-mic]');

  if ('speechSynthesis' in window) {
    speakBtn.hidden = false;
    updateSpeakButton();
  }

  if (isMicSupported()) {
    micBtn.hidden = false;
    micBtn.addEventListener('click', () => (recording ? recording.stop() : startVoiceTurn()));

    wakeBtn.hidden = false;
    updateWakeButton();
    if (wakeEnabled) startWakeListening();
  }
}

function wireEvents() {
  toggleBtn.addEventListener('click', () => (open ? closeChat() : openChat()));
  panel.querySelector('[data-chatbox-close]').addEventListener('click', closeChat);

  wakeBtn.addEventListener('click', () => {
    wakeEnabled = !wakeEnabled;
    localStorage.setItem(WAKE_KEY, wakeEnabled ? '1' : '0');
    updateWakeButton();
    if (wakeEnabled) startWakeListening();
    else stopWakeListening();
  });

  speakBtn.addEventListener('click', () => {
    speakEnabled = !speakEnabled;
    localStorage.setItem(SPEAK_KEY, speakEnabled ? '1' : '0');
    updateSpeakButton();
    if (!speakEnabled) stopSpeaking();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) closeChat();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(input.value.trim(), { forceSpeak: false });
  });
}

/** Shared by typed submits and voice turns — `forceSpeak` makes a voice
 *  turn's reply get read aloud regardless of the header toggle. */
async function sendMessage(text, { forceSpeak }) {
  if (!text) return;

  const lang = detectLang(text);

  input.value = '';
  input.disabled = true;
  form.querySelector('[type="submit"]').disabled = true;

  addUserMessage(text);
  const typing = addTyping();

  try {
    const reply = await runCommand(text, lang);
    typing.remove();
    if (reply !== null) addBotMessage(reply, { forceSpeak });
  } catch (err) {
    typing.remove();
    addBotMessage(
      err instanceof ApiError ? escapeHtml(err.detail) : T[lang].somethingWrong,
      { forceSpeak }
    );
  } finally {
    input.disabled = false;
    form.querySelector('[type="submit"]').disabled = false;
    input.focus();
  }
}

/** One voice "turn": record → stop on silence → transcribe locally →
 *  auto-send → (the reply gets read back via sendMessage's forceSpeak). */
async function startVoiceTurn() {
  micBtn.classList.add('active');

  try {
    recording = await recordUntilSilence();
  } catch {
    micBtn.classList.remove('active');
    addBotMessage(T[defaultLang()].micPermission);
    return;
  }

  const clip = await recording.done;
  recording = null;
  micBtn.classList.remove('active');
  micBtn.classList.add('busy');

  try {
    const wav = await toWav(clip);
    const text = await Api.voice.transcribe(wav);
    micBtn.classList.remove('busy');
    if (text) sendMessage(text, { forceSpeak: true });
  } catch (err) {
    micBtn.classList.remove('busy');
    addBotMessage(
      err instanceof ApiError && err.status === 503
        ? T[defaultLang()].whisperDown
        : T[defaultLang()].didntCatch
    );
  }
}

function openChat() {
  open = true;
  panel.hidden = false;
  toggleBtn.setAttribute('aria-expanded', 'true');
  stopWakeListening(); // nothing to wake into once it's already open, and it'd hear the bot's own replies

  if (!welcomed) {
    welcomed = true;
    addBotMessage(T[defaultLang()].welcome);
  }

  setTimeout(() => input.focus(), 30);
}

function closeChat() {
  open = false;
  panel.hidden = true;
  toggleBtn.setAttribute('aria-expanded', 'false');
  if (wakeEnabled) startWakeListening();
}

/* --- Wake word: a persistent background mic, off by default ------------------- */
function updateWakeButton() {
  wakeBtn.innerHTML = Icons.ear;
  wakeBtn.classList.toggle('active', wakeEnabled);
  wakeBtn.setAttribute('aria-pressed', String(wakeEnabled));
}

let wakeFailCount = 0;

async function startWakeListening() {
  if (wakeSession || open) return;

  wakeFailCount = 0;
  try {
    wakeSession = await listenForWake({ onUtterance: handleWakeUtterance });
  } catch {
    // Mic permission denied, no device, etc — turn the toggle back off rather
    // than leaving it showing "on" while nothing is actually listening.
    wakeEnabled = false;
    localStorage.setItem(WAKE_KEY, '0');
    updateWakeButton();
    addBotMessage(T[defaultLang()].wakeMicError);
  }
}

function stopWakeListening() {
  if (!wakeSession) return;
  wakeSession.stop();
  wakeSession = null;
}

async function handleWakeUtterance(blob) {
  try {
    const wav = await toWav(blob);
    const text = await Api.voice.transcribe(wav);
    wakeFailCount = 0;
    console.log('[wake] heard:', JSON.stringify(text));
    if (!text) return;

    const { matched, remainder } = matchWake(text);
    if (!matched) return;

    stopWakeListening();
    if (!open) openChat();

    if (remainder) {
      sendMessage(remainder, { forceSpeak: true });
    } else {
      addBotMessage(T[defaultLang()].wakeYesListening);
      startVoiceTurn();
    }
  } catch (err) {
    // A transcription hiccup on a background utterance isn't worth a chat
    // message (could just be ambient noise) — but log it, since a silent
    // 503 loop (whisper.cpp not running) would otherwise look exactly like
    // "hey buddy" just never being heard at all.
    console.warn('[wake] transcribe failed:', err instanceof ApiError ? `${err.status} ${err.detail}` : err);

    wakeFailCount++;
    if (wakeFailCount >= WAKE_MAX_CONSECUTIVE_FAILS) {
      wakeEnabled = false;
      localStorage.setItem(WAKE_KEY, '0');
      updateWakeButton();
      stopWakeListening();
      addBotMessage(T[defaultLang()].wakePausedTooManyFailures);
    }
  }
}

/* --- Message rendering -------------------------------------------------------
   User text is inserted with textContent (never HTML). Bot replies are built
   from escapeHtml()-wrapped fragments by the command handlers below, then
   inserted as HTML so a reply can include a short <ul> list — same trust
   model the rest of the app already uses for markup it builds itself. */
function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg--user';
  el.textContent = text;
  messageHost.appendChild(el);
  scrollToEnd();
}

function addBotMessage(html, { forceSpeak = false } = {}) {
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg--bot';
  el.innerHTML = html;
  messageHost.appendChild(el);
  scrollToEnd();
  maybeSpeak(html, forceSpeak);
  return el;
}

function addTyping() {
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg--bot chat-msg--typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  messageHost.appendChild(el);
  scrollToEnd();
  return el;
}

function scrollToEnd() {
  messageHost.scrollTop = messageHost.scrollHeight;
}

/* --- Voice: real browser APIs, no backend involved ----------------------------- */
function updateSpeakButton() {
  speakBtn.innerHTML = speakEnabled ? Icons.volume : Icons.volumeOff;
  speakBtn.classList.toggle('active', speakEnabled);
  speakBtn.setAttribute('aria-pressed', String(speakEnabled));
}

let currentAudio = null; // the Piper clip currently playing, if any

async function maybeSpeak(html, force = false) {
  if ((!force && !speakEnabled) || !('speechSynthesis' in window)) return;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = tmp.textContent.trim();
  if (!text) return;

  stopSpeaking();

  try {
    const blob = await Api.voice.speak(text);
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.addEventListener('ended', () => URL.revokeObjectURL(url));
    currentAudio.addEventListener('error', () => URL.revokeObjectURL(url));
    await currentAudio.play();
  } catch {
    // Piper isn't set up or errored — fall back to the on-device voice.
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  window.speechSynthesis.cancel();
}

/** For destructive actions (delete). Renders its own Yes/Cancel buttons. */
function addBotConfirm(promptHtml, { confirmLabel, onConfirm, lang }) {
  const el = addBotMessage(`
    <div>${promptHtml}</div>
    <div class="chat-confirm">
      <button type="button" class="btn btn--danger btn--sm" data-confirm>${escapeHtml(confirmLabel)}</button>
      <button type="button" class="btn btn--ghost btn--sm" data-cancel>Cancel</button>
    </div>`);

  const confirmBtn = el.querySelector('[data-confirm]');
  const cancelBtn = el.querySelector('[data-cancel]');
  const controls = el.querySelector('.chat-confirm');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      const result = await onConfirm();
      controls.outerHTML = `<div class="chat-msg__done">${result}</div>`;
    } catch (err) {
      controls.outerHTML = `<div class="chat-msg__done">`
        + `${err instanceof ApiError ? escapeHtml(err.detail) : T[lang].couldNotComplete}</div>`;
    }

    scrollToEnd();
  });

  cancelBtn.addEventListener('click', () => {
    controls.outerHTML = `<div class="chat-msg__done">${T[lang].cancelled}</div>`;
    scrollToEnd();
  });
}

/* --- Command grammar ---------------------------------------------------------
   Order matters — more specific patterns first. Each handler returns either
   an HTML string (shown as the bot's reply) or null (it already rendered its
   own message, e.g. a delete confirmation with buttons). `lang` ('en'/'ar')
   is detected once per message (see sendMessage) and threaded through every
   handler below so replies come back in whichever language you wrote in —
   see chat-strings.js. */
const COMMANDS = [
  { test: /^(?:help|\?)$/i, run: async (m, lang) => T[lang].helpText },
  { test: /^add\s+goal\s+(.+)$/i, run: (m, lang) => addGoal(m[1].trim(), lang) },
  { test: /^add\s+task\s+(.+)$/i, run: (m, lang) => addTask(m[1], lang) },
  { test: /^list\s+goals$/i, run: (m, lang) => listGoals(lang) },
  { test: /^list\s+tasks?(?:\s+(.+))?$/i, run: (m, lang) => listTasks(m[1]?.trim() ?? null, lang) },
  { test: /^(?:done|complete|finish)\s+(.+)$/i, run: (m, lang) => completeTask(m[1].trim(), lang) },
  { test: /^(?:delete|remove)\s+task\s+(.+)$/i, run: (m, lang) => deleteTaskFlow(m[1].trim(), lang) },
  { test: /^(?:delete|remove|clear)\s+all\s+(?:my\s+)?goals$/i, run: (m, lang) => deleteAllGoalsFlow(lang) },
  { test: /^(?:delete|remove)\s+goal\s+(.+)$/i, run: (m, lang) => deleteGoalFlow(m[1].trim(), lang) },
];

async function runCommand(text, lang) {
  for (const command of COMMANDS) {
    const match = text.match(command.test);
    if (match) return command.run(match, lang);
  }

  return interpretWithLlm(text, lang);
}

/**
 * The fixed grammar above didn't match — ask the local Ollama model (via the
 * API's /chat/interpret, see ChatController) to figure out what was meant.
 * Fails soft in every direction: a 503 means Ollama isn't running, anything
 * else (network error, an "unknown" intent) falls back to the same generic
 * reply layer 1 would have given.
 */
async function interpretWithLlm(text, lang) {
  let parsed;

  try {
    const res = await Api.chat.interpret(text);
    parsed = res.data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      return T[lang].ollamaFallbackDown;
    }
    return T[lang].fallback;
  }

  if (!parsed || !parsed.intent || parsed.intent === 'unknown') return T[lang].fallback;

  return runInterpreted(parsed, lang);
}

/** Dispatches a structured result from /chat/interpret to the same handlers
 *  the fixed-grammar commands above use. */
async function runInterpreted(parsed, lang) {
  switch (parsed.intent) {
    case 'help':
      return T[lang].helpText;
    case 'chat':
      return escapeHtml((parsed.reply ?? '').trim()) || T[lang].chatFallback;
    case 'add_goal':
      return addGoal((parsed.goal ?? parsed.title ?? '').trim(), lang);
    case 'add_task':
      return addTaskFromFields({
        title: (parsed.title ?? '').trim(),
        due: parsed.due_date ?? null,
        priority: parsed.priority ?? null,
        goal: parsed.goal ?? null,
      }, lang);
    case 'list_goals':
      return listGoals(lang);
    case 'list_tasks':
      return listTasks(parsed.filter ?? null, lang);
    case 'done': {
      const fragment = (parsed.fragment ?? parsed.title ?? '').trim();
      return fragment ? completeTask(fragment, lang) : T[lang].whichTaskDone;
    }
    case 'delete_task': {
      const fragment = (parsed.fragment ?? parsed.title ?? '').trim();
      return fragment ? deleteTaskFlow(fragment, lang) : T[lang].whichTaskDelete;
    }
    case 'delete_goal': {
      const fragment = (parsed.fragment ?? parsed.goal ?? '').trim();
      return fragment ? deleteGoalFlow(fragment, lang) : T[lang].whichGoalDelete;
    }
    case 'delete_all_goals':
      return deleteAllGoalsFlow(lang);
    default:
      return T[lang].fallback;
  }
}

/* --- Shared lookups ----------------------------------------------------------- */
async function getCategories(force = false) {
  if (categoriesCache && !force) return categoriesCache;
  const res = await Api.categories.list(true);
  categoriesCache = res.data;
  return categoriesCache;
}

function findCategory(categories, name) {
  const needle = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === needle)
    ?? categories.find((c) => c.name.toLowerCase().includes(needle));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "today" / "tomorrow" / a weekday (full or 3-letter) / "YYYY-MM-DD". */
function resolveDuePhrase(phrase) {
  const p = phrase.trim().toLowerCase();
  if (p === 'today') return isoDate(new Date());

  if (p === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return isoDate(d);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;

  // A bare weekday means "the next one" — if today already is that day, a
  // week out, not today; say "today" if today is what you mean.
  const weekday = p.length >= 3 ? WEEKDAYS.findIndex((w) => w.startsWith(p)) : -1;

  if (weekday !== -1) {
    const d = new Date();
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7));
    return isoDate(d);
  }

  return null;
}

/**
 * "do push ups in goal fitness for tomorrow" or the older, stricter
 * "Buy milk goal Groceries due tomorrow priority high" — both work. Flags
 * can come in any order; the first recognized trigger ends the title.
 *
 * `goal`/`priority` triggers (in goal, under goal, with priority, priority…)
 * are distinctive enough to spot safely anywhere in the sentence — their
 * value runs to the next trigger or the end of the string, same as before.
 *
 * `for`/`on`/`by` are NOT distinctive — those are ordinary words a title can
 * legitimately contain ("Prepare slides for the client"). They only count as
 * a due-date trigger when immediately followed by a word this parser actually
 * recognizes as a date (today, tomorrow, a weekday, or YYYY-MM-DD), and only
 * that one word is consumed — never "everything after it" — so the rest of
 * a sentence can't be silently swallowed into an unresolved due date.
 */
const DATE_WORD = 'today|tomorrow|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?'
  + '|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\\d{4}-\\d{2}-\\d{2}';

const TRIGGER_PATTERN = new RegExp(
  '\\b(?:'
  + '(?<goal1>in\\s+goal)'
  + '|(?<goal2>under\\s+goal)'
  + '|(?<goal3>for\\s+goal)'
  + '|(?<goal4>goal)'
  + '|(?<priority1>with\\s+priority)'
  + '|(?<priority2>at\\s+priority)'
  + '|(?<priority3>priority)'
  + '|(?<due1>due\\s+on)'
  + '|(?<due2>due\\s+by)'
  + '|(?<due3>due)'
  + `|(?:for|on|by)\\s+(?<dueWord>${DATE_WORD})`
  + ')\\b',
  'gi'
);

const TRIGGER_GROUP_FLAGS = {
  goal1: 'goal', goal2: 'goal', goal3: 'goal', goal4: 'goal',
  priority1: 'priority', priority2: 'priority', priority3: 'priority',
  due1: 'due', due2: 'due', due3: 'due',
};

function parseTaskFlags(text) {
  const matches = [...text.matchAll(TRIGGER_PATTERN)];

  if (!matches.length) return { title: text.trim(), due: null, priority: null, goal: null };

  const title = text.slice(0, matches[0].index).trim();
  const flags = {};

  matches.forEach((m, i) => {
    const groups = m.groups ?? {};
    let flag = null;
    let value = null;

    if (groups.dueWord !== undefined) {
      // The whole match ("for tomorrow") is consumed, and the value is
      // exactly the date word — nothing trailing gets pulled in.
      flag = 'due';
      value = groups.dueWord;
    } else {
      const groupName = Object.keys(TRIGGER_GROUP_FLAGS).find((name) => groups[name] !== undefined);
      flag = groupName ? TRIGGER_GROUP_FLAGS[groupName] : null;

      if (flag) {
        const start = m.index + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        value = text.slice(start, end).trim();
      }
    }

    if (flag && value && !(flag in flags)) flags[flag] = value;
  });

  return { title, due: flags.due ?? null, priority: flags.priority ?? null, goal: flags.goal ?? null };
}

/* --- Handlers ------------------------------------------------------------- */
async function addGoal(name, lang) {
  if (!name) return T[lang].addGoalMissingName;

  await Api.categories.create({ name });
  await getCategories(true);

  return T[lang].goalCreated(escapeHtml(name));
}

async function addTask(raw, lang) {
  return addTaskFromFields(parseTaskFlags(raw), lang);
}

async function addTaskFromFields({ title, due, priority, goal }, lang) {
  if (!title) return T[lang].taskMissingTitle;

  const categories = await getCategories();

  if (!categories.length) return T[lang].noGoalsYetForTask;

  let category;

  if (goal) {
    category = findCategory(categories, goal);
    if (!category) return T[lang].goalNotFound(escapeHtml(goal));
  } else {
    // No goal named — file it under whichever goal was created most recently.
    category = [...categories].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  }

  const payload = { category_id: category.id, title };

  if (priority && ['low', 'medium', 'high'].includes(priority.toLowerCase())) {
    payload.priority = priority.toLowerCase();
  }

  let dueNote = '';

  if (due) {
    const resolved = resolveDuePhrase(due);
    if (resolved) {
      payload.due_date = resolved;
      dueNote = T[lang].dueNoteResolved(escapeHtml(resolved));
    } else {
      dueNote = T[lang].dueNoteUnresolved(escapeHtml(due));
    }
  }

  await Api.tasks.create(payload);

  return T[lang].taskAdded(escapeHtml(title), escapeHtml(category.name), dueNote);
}

async function listGoals(lang) {
  const categories = await getCategories(true);

  if (!categories.length) return T[lang].noGoalsYet;

  const rows = categories.map((c) => `
    <li>${escapeHtml(c.icon || '🎯')} ${escapeHtml(c.name)}
      <span class="chat-msg__meta">${T[lang].openCount(c.stats?.pending ?? 0)}</span></li>`).join('');

  return `<b>${T[lang].yourGoals}</b><ul class="chat-list">${rows}</ul>`;
}

async function listTasks(filterWord, lang) {
  const filters = { per_page: 8, sort: 'due_date', dir: 'asc', status: 'pending' };
  let label = T[lang].openTasks;

  if (filterWord) {
    const w = filterWord.toLowerCase();

    if (['today', 'tomorrow', 'week', 'month', 'overdue', 'upcoming'].includes(w)) {
      filters.date = w;
      label = T[lang].tasksFiltered(w);
    } else if (['done', 'completed'].includes(w)) {
      filters.status = 'completed';
      filters.sort = 'created_at';
      filters.dir = 'desc';
      label = T[lang].completedTasks;
    } else if (!['pending', 'open'].includes(w)) {
      const categories = await getCategories();
      const category = findCategory(categories, w);

      if (category) {
        filters.category_id = category.id;
        label = T[lang].tasksInGoal(category.name);
      } else {
        filters.search = filterWord;
        label = T[lang].tasksMatching(filterWord);
      }
    }
  }

  const res = await Api.tasks.list(filters);
  const tasks = res.data;

  if (!tasks.length) return `<b>${escapeHtml(label)}</b><div class="chat-msg__meta">${T[lang].nothingHere}</div>`;

  const rows = tasks.map((t) => {
    const mark = t.status === 'completed' ? '✓' : t.is_overdue ? '⚠' : '•';
    const due = t.due_date ? ` — ${escapeHtml(formatDate(t.due_at))}` : '';
    return `<li>${mark} ${escapeHtml(t.title)}${due}
      <span class="chat-msg__meta">(${escapeHtml(t.priority)}, ${escapeHtml(t.category?.name ?? '—')})</span></li>`;
  }).join('');

  const more = res.meta?.total > tasks.length
    ? `<div class="chat-msg__meta">${T[lang].moreCount(res.meta.total - tasks.length)}</div>`
    : '';

  return `<b>${escapeHtml(label)}</b><ul class="chat-list">${rows}</ul>${more}`;
}

async function completeTask(fragment, lang) {
  const res = await Api.tasks.list({ status: 'pending', search: fragment, per_page: 20 });
  const matches = res.data;

  if (!matches.length) return T[lang].taskNotFoundOpen(escapeHtml(fragment));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((t) => `<li>${escapeHtml(t.title)}</li>`).join('');
    return `${T[lang].ambiguousOpenTask}<ul class="chat-list">${rows}</ul>`;
  }

  const task = matches[0];
  const done = await Api.tasks.toggle(task.id);

  return done.message ? escapeHtml(done.message) : T[lang].taskMarkedDone(escapeHtml(task.title));
}

async function deleteTaskFlow(fragment, lang) {
  const res = await Api.tasks.list({ search: fragment, per_page: 20 });
  const matches = res.data;

  if (!matches.length) return T[lang].taskNotFound(escapeHtml(fragment));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((t) => `<li>${escapeHtml(t.title)}</li>`).join('');
    return `${T[lang].ambiguousTask}<ul class="chat-list">${rows}</ul>`;
  }

  const task = matches[0];

  addBotConfirm(T[lang].confirmDeleteTask(escapeHtml(task.title)), {
    confirmLabel: T[lang].confirmYesDelete,
    lang,
    onConfirm: async () => {
      await Api.tasks.remove(task.id);
      return T[lang].taskDeleted(escapeHtml(task.title));
    },
  });

  return null;
}

async function deleteGoalFlow(fragment, lang) {
  const categories = await getCategories(true);
  const needle = fragment.toLowerCase();
  const matches = categories.filter((c) => c.name.toLowerCase().includes(needle));

  if (!matches.length) return T[lang].goalNotFoundDelete(escapeHtml(fragment));

  if (matches.length > 1) {
    const rows = matches.slice(0, 6).map((c) => `<li>${escapeHtml(c.name)}</li>`).join('');
    return `${T[lang].ambiguousGoal}<ul class="chat-list">${rows}</ul>`;
  }

  const category = matches[0];
  const count = category.stats?.total ?? 0;
  const warning = T[lang].confirmDeleteGoal(escapeHtml(category.name), count);

  addBotConfirm(warning, {
    confirmLabel: T[lang].confirmYesDelete,
    lang,
    onConfirm: async () => {
      await Api.categories.remove(category.id);
      await getCategories(true);
      return T[lang].goalDeleted(escapeHtml(category.name));
    },
  });

  return null;
}

async function deleteAllGoalsFlow(lang) {
  const categories = await getCategories(true);

  if (!categories.length) return T[lang].noGoalsToDelete;

  addBotConfirm(T[lang].confirmDeleteAllGoals(categories.length), {
    confirmLabel: T[lang].confirmYesDeleteAll,
    lang,
    onConfirm: async () => {
      const count = categories.length;
      await Api.categories.removeAll();
      await getCategories(true);
      return T[lang].allGoalsDeleted(count);
    },
  });

  return null;
}
