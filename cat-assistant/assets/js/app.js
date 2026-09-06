/* =============================================================================
   Cat Assistant — a floating companion for MyTasks. Reuses the main app's
   own API client (../../../web/assets/js/api.js) for auth, tasks and goals,
   so this is the same account and the same data, just a different window
   for it. See cat-assistant/README.md for the how-and-why.
   ========================================================================== */
import { Api, ApiError, requireAuth } from '../../../web/assets/js/api.js';
import { escapeHtml } from '../../../web/assets/js/ui.js';
import {
  isMicSupported, recordUntilSilence, toWav, listenForWake, matchWake,
} from '../../../web/assets/js/voice.js';
import { T, detectLang, defaultLang } from '../../../web/assets/js/chat-strings.js';
import { Icons } from './icons.js';
import { catAvatar } from './avatar.js';
import { sendMessage } from './chat-engine.js';
import {
  loadSettings, saveSettings, resetSettings, applyAccent, PERSONALITIES, ACCENTS, DEFAULTS,
} from './settings.js';
import * as Pip from './pip.js';

const VIEW_SIZES = { mini: [340, 460], chat: [380, 560], settings: [700, 560] };

const TABS = [
  { id: 'general', label: 'General', icon: Icons.home },
  { id: 'appearance', label: 'Appearance', icon: Icons.palette },
  { id: 'ai', label: 'AI', icon: Icons.brain },
  { id: 'voice', label: 'Voice', icon: Icons.mic },
  { id: 'shortcuts', label: 'Shortcuts', icon: Icons.keyboard },
  { id: 'notifications', label: 'Notifications', icon: Icons.bell },
  { id: 'about', label: 'About', icon: Icons.info },
];

let settings = loadSettings();
let draft = { ...settings };
let root = null;
let currentView = 'mini';
let pipWindow = null;
let reminderTimer = null;
let voiceRecording = null; // the { stop, done } handle from recordUntilSilence(), while a voice turn is in progress
let wakeSession = null; // the { stop } handle from listenForWake(), while "hey buddy" listening is active
const notifiedTaskIds = new Set();

main();

async function main() {
  const user = await requireAuth('../web/index.html');
  if (!user) return; // requireAuth already redirected

  document.querySelector('[data-slot="launch-avatar"]').innerHTML = catAvatar(88);

  root = buildWidget();
  root.hidden = true;
  document.getElementById('widget-host').appendChild(root);

  const launchEl = document.querySelector('[data-slot="launch"]');
  const statusEl = document.querySelector('[data-slot="launch-status"]');
  const launchBtn = document.querySelector('[data-action="launch"]');
  const noteEl = document.querySelector('[data-slot="launch-note"]');

  statusEl.textContent = `Signed in as ${user.email ?? 'you'}.`;
  launchBtn.hidden = false;
  launchBtn.addEventListener('click', () => openAssistant(launchEl));

  if (!Pip.isSupported()) {
    noteEl.textContent = "This browser can't float a real always-on-top window, so it runs inline on the page instead.";
    noteEl.hidden = false;
  }

  refreshMiniBubble();

  if (settings.desktopNotifications && 'Notification' in window && Notification.permission === 'granted') {
    startReminderPolling();
  }

  syncWakeListening();
}

async function openAssistant(launchEl) {
  stopWakeListening(); // nothing to wake into once it's open, and it'd otherwise hear the bot's own replies
  launchEl.hidden = true;
  root.hidden = false;

  if (Pip.isSupported()) {
    try {
      const [w, h] = VIEW_SIZES[currentView];
      const request = Pip.openFloating(root, {
        width: w,
        height: h,
        onClose: () => {
          pipWindow = null;
          document.getElementById('widget-host').appendChild(root);
          root.hidden = true;
          launchEl.hidden = false;
          syncWakeListening();
        },
      });
      // The browser advertises the API but a request can still silently
      // hang (permission policy, no window manager, etc.) — never block
      // the UI on it forever; degrade to in-page instead.
      pipWindow = await withTimeout(request, 4000);
      if (pipWindow) {
        syncWakeListening(); // still idle (mini view) once actually open
        return;
      }
    } catch {
      // Fall through to the in-page fallback below.
    }
  }

  root.classList.add('widget--inpage');
  syncWakeListening();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function closeWidget() {
  if (pipWindow) {
    Pip.closeFloating(); // fires the onClose handler set up in openAssistant()
  } else {
    root.hidden = true;
    document.querySelector('[data-slot="launch"]').hidden = false;
    syncWakeListening();
  }
}

function switchView(view) {
  currentView = view;
  root.dataset.view = view;

  const [w, h] = VIEW_SIZES[view];
  if (pipWindow) {
    pipWindow.resizeTo(w, h);
  } else if (root.classList.contains('widget--inpage')) {
    // No real floating window to resize — resize the fixed-position widget itself.
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
  }

  if (view === 'chat') root.querySelector('#ca-input')?.focus();
  syncWakeListening();
}

async function refreshMiniBubble() {
  const bubble = root.querySelector('[data-slot="mini-bubble"]');
  if (!bubble) return;

  try {
    const res = await Api.tasks.summary();
    const s = res.data;

    if (s.overdue > 0) bubble.textContent = `${s.overdue} task${s.overdue > 1 ? 's are' : ' is'} overdue`;
    else if (s.due_today > 0) bubble.textContent = `${s.due_today} due today`;
    else bubble.textContent = 'Need something?';
  } catch {
    // Keep the default greeting — this is a nicety, not core functionality.
  }
}

/* --- Widget shell ------------------------------------------------------------ */
function buildWidget() {
  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.view = 'mini';
  applyAccent(el, settings.accent);

  el.innerHTML = `
    <section class="view view--mini">
      <div class="view__head">
        <div style="flex:1"></div>
        <div class="view__head-actions">
          <button type="button" class="icon-btn" data-action="close-widget" aria-label="Close">${Icons.x}</button>
        </div>
      </div>
      <div class="mini">
        <div class="mini__bubble" data-slot="mini-bubble">Need something?</div>
        <div class="mini__avatar">${catAvatar(112)}</div>
        <div class="mini__name" data-slot="mini-name">${escapeHtml(settings.name)}</div>
        <div class="mini__wake-status" data-slot="wake-status" hidden></div>
        <div class="mini__actions">
          <button type="button" class="icon-btn" data-action="open-chat" aria-label="Open chat">${Icons.chat}</button>
          <button type="button" class="icon-btn" data-action="open-settings" aria-label="Open settings">${Icons.settings}</button>
        </div>
      </div>
    </section>

    <section class="view view--chat">
      <div class="view__head">
        <div class="view__head-avatar">${catAvatar(28)}</div>
        <b data-slot="chat-name">${escapeHtml(settings.name)}</b>
        <div class="view__head-actions">
          <button type="button" class="icon-btn" data-action="back-to-mini" aria-label="Minimize">${Icons.minimize}</button>
          <button type="button" class="icon-btn" data-action="close-widget" aria-label="Close">${Icons.x}</button>
        </div>
      </div>
      <div class="chat-list-host" data-slot="chat-list"></div>
      <form class="chat-input-row" data-slot="chat-form">
        <label class="visually-hidden" for="ca-input">Message</label>
        <input type="text" id="ca-input" placeholder="Type your message…" autocomplete="off">
        <button type="button" class="icon-btn" data-mic hidden aria-label="Voice input">${Icons.mic}</button>
        <button type="submit" class="icon-btn" aria-label="Send">${Icons.send}</button>
      </form>
    </section>

    <section class="view view--settings">
      <div class="view__head">
        <div class="view__head-avatar">${catAvatar(28)}</div>
        <b data-slot="settings-name">${escapeHtml(settings.name)}</b>
        <div class="view__head-actions">
          <button type="button" class="icon-btn" data-action="back-to-mini" aria-label="Minimize">${Icons.minimize}</button>
          <button type="button" class="icon-btn" data-action="close-widget" aria-label="Close">${Icons.x}</button>
        </div>
      </div>
      <div class="settings-body">
        <nav class="settings-nav" data-slot="settings-nav"></nav>
        <div class="settings-panels" data-slot="settings-panels"></div>
      </div>
      <div class="settings-foot">
        <span class="save-flash" data-slot="save-flash">Saved</span>
        <button type="button" class="btn btn--ghost btn--sm" data-action="reset-settings">Reset to Default</button>
        <button type="button" class="btn btn--accent btn--sm" data-action="save-settings">Save Changes</button>
      </div>
    </section>`;

  wireGlobalButtons(el);
  wireChat(el);
  wireSettings(el);

  return el;
}

function wireGlobalButtons(el) {
  el.querySelectorAll('[data-action="open-chat"]').forEach((b) => b.addEventListener('click', () => switchView('chat')));
  el.querySelectorAll('[data-action="open-settings"]').forEach((b) => b.addEventListener('click', () => switchView('settings')));
  el.querySelectorAll('[data-action="back-to-mini"]').forEach((b) => b.addEventListener('click', () => switchView('mini')));
  el.querySelectorAll('[data-action="close-widget"]').forEach((b) => b.addEventListener('click', () => closeWidget()));

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentView !== 'mini') switchView('mini');
  });
}

/* --- Chat view ----------------------------------------------------------------- */
function wireChat(el) {
  const list = el.querySelector('[data-slot="chat-list"]');
  const form = el.querySelector('[data-slot="chat-form"]');
  const input = form.querySelector('input');
  const micBtn = form.querySelector('[data-mic]');
  const submitBtn = form.querySelector('[type="submit"]');

  addBotBubble(list, T[defaultLang()].greetingWithName(escapeHtml(settings.name)));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitText(list, form, input, submitBtn, input.value.trim(), { forceSpeak: false });
  });

  if (isMicSupported()) {
    micBtn.hidden = false;
    micBtn.addEventListener('click', () => {
      if (voiceRecording) voiceRecording.stop();
      else startVoiceTurn(list, form, input, submitBtn, micBtn);
    });
  }
}

/** Shared by typed submits and voice turns — `forceSpeak` makes a voice
 *  turn's reply get read aloud regardless of the "Speak replies" setting. */
async function submitText(list, form, input, submitBtn, text, { forceSpeak }) {
  if (!text) return;

  const lang = detectLang(text);

  input.value = '';
  input.disabled = true;
  submitBtn.disabled = true;

  addUserBubble(list, text);
  const typing = addTyping(list);

  try {
    const result = await sendMessage(text, { personaKey: settings.personality, catName: settings.name });
    typing.remove();
    renderResult(list, result, forceSpeak);
  } catch {
    typing.remove();
    addBotBubble(list, T[lang].somethingWrong);
  } finally {
    input.disabled = false;
    submitBtn.disabled = false;
    input.focus();
  }
}

/** One voice "turn": record → stop on silence → transcribe locally (a
 *  whisper.cpp server, see api/README.md — not a cloud speech API) →
 *  auto-send → the reply gets read back regardless of the Voice setting. */
async function startVoiceTurn(list, form, input, submitBtn, micBtn) {
  micBtn.classList.add('active');

  try {
    voiceRecording = await recordUntilSilence();
  } catch {
    micBtn.classList.remove('active');
    addBotBubble(list, T[defaultLang()].micPermission);
    return;
  }

  const clip = await voiceRecording.done;
  voiceRecording = null;
  micBtn.classList.remove('active');
  micBtn.classList.add('busy');

  try {
    const wav = await toWav(clip);
    const text = await Api.voice.transcribe(wav);
    micBtn.classList.remove('busy');
    if (text) submitText(list, form, input, submitBtn, text, { forceSpeak: true });
  } catch (err) {
    micBtn.classList.remove('busy');
    addBotBubble(
      list,
      err instanceof ApiError && err.status === 503
        ? T[defaultLang()].whisperDown
        : T[defaultLang()].didntCatch
    );
  }
}

/* --- Wake word: a persistent background mic whenever the widget is idle
   (fully closed, or open but sitting on the mini view) — not while you're
   actually in the chat or settings view, off by default -------------------- */
function isIdle() {
  return root.hidden || currentView === 'mini';
}

/** Call after anything that changes root.hidden or currentView — starts or
 *  stops listening to match whether the widget is idle right now. */
function syncWakeListening() {
  if (settings.wakeWordEnabled && isIdle()) startWakeListening();
  else stopWakeListening();
}

// If whisper.cpp is down, or a noisy mic keeps tripping the volume gate on
// sustained background noise (not just a brief blip — see minUtteranceMs in
// voice.js), wake listening can end up firing transcribe request after
// transcribe request that all fail. Left unchecked that's a flood that
// starves out the very voice input the user is trying to use. Stop after a
// few in a row instead of retrying forever.
const WAKE_MAX_CONSECUTIVE_FAILS = 3;
let wakeFailCount = 0;

async function startWakeListening() {
  if (wakeSession || !isIdle()) return;

  wakeFailCount = 0;
  try {
    wakeSession = await listenForWake({ onUtterance: handleWakeUtterance });
    updateWakeStatus('on');
  } catch {
    // Mic permission denied, no device, etc — turn the setting back off
    // rather than leaving it saved as "on" while nothing is listening.
    wakeSession = null;
    settings = saveSettings({ wakeWordEnabled: false });
    draft.wakeWordEnabled = false;
    updateWakeStatus('error');
  }
}

function stopWakeListening() {
  updateWakeStatus('off');
  if (!wakeSession) return;
  wakeSession.stop();
  wakeSession = null;
}

function updateWakeStatus(state) {
  document.querySelectorAll('[data-slot="wake-status"]').forEach((statusEl) => {
    statusEl.hidden = state === 'off';
    statusEl.textContent = state === 'on' ? T[defaultLang()].wakeListeningStatus
      : state === 'error' ? T[defaultLang()].wakeMicErrorWidget
      : state === 'paused' ? T[defaultLang()].wakePausedTooManyFailures
      : '';
  });
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

    const launchEl = document.querySelector('[data-slot="launch"]');
    if (root.hidden) await openAssistant(launchEl);
    switchView('chat');

    const list = root.querySelector('[data-slot="chat-list"]');
    const form = root.querySelector('[data-slot="chat-form"]');
    const input = form.querySelector('input');
    const submitBtn = form.querySelector('[type="submit"]');
    const micBtn = form.querySelector('[data-mic]');

    if (remainder) {
      submitText(list, form, input, submitBtn, remainder, { forceSpeak: true });
    } else {
      addBotBubble(list, T[defaultLang()].wakeYesListening);
      startVoiceTurn(list, form, input, submitBtn, micBtn);
    }
  } catch (err) {
    // A transcription hiccup on a background utterance isn't worth a chat
    // message (could just be ambient noise) — but log it, since a silent
    // 503 loop (whisper.cpp not running) would otherwise look exactly like
    // "hey buddy" just never being heard at all.
    console.warn('[wake] transcribe failed:', err instanceof ApiError ? `${err.status} ${err.detail}` : err);

    wakeFailCount++;
    if (wakeFailCount >= WAKE_MAX_CONSECUTIVE_FAILS) {
      settings = saveSettings({ wakeWordEnabled: false });
      draft.wakeWordEnabled = false;
      stopWakeListening();
      updateWakeStatus('paused');
    }
  }
}

function renderResult(list, result, forceSpeak = false) {
  if (result.confirm) {
    addBotConfirmBubble(list, result.confirm);
    return;
  }

  if (result.html !== null) {
    addBotBubble(list, result.html);
    maybeSpeak(result.html, forceSpeak);
    playPing();
  }
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addUserBubble(list, text) {
  const row = document.createElement('div');
  row.className = 'bubble-row bubble-row--user';
  row.innerHTML = `<div class="bubble">${escapeHtml(text)}<time>${nowLabel()}</time></div>`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return row;
}

function addBotBubble(list, html) {
  const row = document.createElement('div');
  row.className = 'bubble-row bubble-row--bot';
  row.innerHTML = `<div class="bubble-row__avatar">${catAvatar(24)}</div><div class="bubble">${html}<time>${nowLabel()}</time></div>`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return row;
}

function addTyping(list) {
  const row = document.createElement('div');
  row.className = 'bubble-row bubble-row--bot';
  row.innerHTML = `<div class="bubble-row__avatar">${catAvatar(24)}</div>`
    + `<div class="bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return row;
}

function addBotConfirmBubble(list, { promptHtml, confirmLabel, run }) {
  const row = addBotBubble(list, `
    <div>${promptHtml}</div>
    <div class="confirm-row">
      <button type="button" class="btn btn--danger btn--sm" data-confirm>${escapeHtml(confirmLabel)}</button>
      <button type="button" class="btn btn--ghost btn--sm" data-cancel>Cancel</button>
    </div>`);

  const confirmBtn = row.querySelector('[data-confirm]');
  const cancelBtn = row.querySelector('[data-cancel]');
  const controls = row.querySelector('.confirm-row');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      const doneText = await run();
      controls.outerHTML = `<div class="chat-msg__meta">${doneText}</div>`;
    } catch {
      controls.outerHTML = '<div class="chat-msg__meta">Could not complete that.</div>';
    }

    list.scrollTop = list.scrollHeight;
  });

  cancelBtn.addEventListener('click', () => {
    controls.outerHTML = '<div class="chat-msg__meta">Cancelled.</div>';
  });
}

/* --- Voice: local speech-to-text (whisper.cpp) + local text-to-speech (Piper),
   falling back to the browser's own speechSynthesis when Piper isn't set up --- */
let currentAudio = null; // the Piper clip currently playing, if any

async function maybeSpeak(html, force = false) {
  if ((!force && !settings.speakReplies) || !('speechSynthesis' in window)) return;

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

function playPing() {
  if (!settings.soundEffects) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {
    // No audio output available — skip silently, it's a nicety.
  }
}

/* --- Settings view --------------------------------------------------------------- */
function wireSettings(el) {
  renderSettingsPanels(el);

  el.querySelector('[data-action="save-settings"]').addEventListener('click', () => {
    settings = saveSettings(draft);
    applySettingsToUi(el);
    flashSaved(el);
  });

  el.querySelector('[data-action="reset-settings"]').addEventListener('click', () => {
    settings = resetSettings();
    draft = { ...settings };
    applySettingsToUi(el);
    renderSettingsPanels(el);
  });
}

function renderSettingsPanels(el) {
  const nav = el.querySelector('[data-slot="settings-nav"]');
  const panels = el.querySelector('[data-slot="settings-panels"]');
  const activeTab = nav.querySelector('button.active')?.dataset.tab ?? 'general';

  nav.innerHTML = TABS.map((t) => `
    <button type="button" data-tab="${t.id}" class="${t.id === activeTab ? 'active' : ''}">
      ${t.icon}<span>${escapeHtml(t.label)}</span>
    </button>`).join('');

  panels.innerHTML = TABS.map((t) => `
    <div class="settings-panel ${t.id === activeTab ? 'active' : ''}" data-panel="${t.id}">${panelHtml(t.id)}</div>`
  ).join('');

  nav.onclick = (event) => {
    const btn = event.target.closest('[data-tab]');
    if (!btn) return;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    panels.querySelectorAll('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
  };

  wireGeneralPanel(el);
  wireAppearancePanel(el);
  wireVoicePanel(el);
  wireNotificationsPanel(el);
}

function panelHtml(id) {
  switch (id) {
    case 'general':
      return `
        <h2>General Settings</h2>
        <div class="field">
          <label for="ca-name">Cat Name</label>
          <input type="text" id="ca-name" maxlength="30" value="${escapeHtml(draft.name)}">
        </div>
        <div class="field">
          <label for="ca-personality">Personality</label>
          <select id="ca-personality">
            ${PERSONALITIES.map((p) => `<option value="${p.value}" ${p.value === draft.personality ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <div class="field-row__text"><b>Keep always on top</b><span>Opens in a real floating window, where your browser supports it</span></div>
          <label class="toggle"><input type="checkbox" id="ca-always-top" ${draft.alwaysOnTop ? 'checked' : ''}><span class="toggle__track"></span></label>
        </div>
        <div class="field-row">
          <div class="field-row__text"><b>Play sound effects</b><span>A short sound when I reply</span></div>
          <label class="toggle"><input type="checkbox" id="ca-sound" ${draft.soundEffects ? 'checked' : ''}><span class="toggle__track"></span></label>
        </div>`;

    case 'appearance':
      return `
        <h2>Appearance</h2>
        <p class="hint">Pick an accent color.</p>
        <div class="accent-swatches" data-slot="accent-swatches">
          ${ACCENTS.map((a) => `<button type="button" class="accent-swatch ${a.value === draft.accent ? 'active' : ''}" data-accent="${a.value}" style="background:${a.color}" aria-label="${escapeHtml(a.label)}"></button>`).join('')}
        </div>`;

    case 'ai':
      return `
        <h2>AI</h2>
        <div class="info-card">
          I understand plain commands instantly, on this device, with no network call at all.
          Anything I can't parse that way is sent to a <b>local Ollama model</b> running on the
          MyTasks server — never a cloud API, nothing leaves that machine. The Personality you
          pick under General shapes how that model replies.
        </div>`;

    case 'voice':
      return `
        <h2>Voice</h2>
        <div class="field-row">
          <div class="field-row__text"><b>Speak replies aloud</b><span>For typed messages — uses a local Piper voice if you've set one up, otherwise your browser's built-in text-to-speech</span></div>
          <label class="toggle"><input type="checkbox" id="ca-speak" ${draft.speakReplies ? 'checked' : ''}><span class="toggle__track"></span></label>
        </div>
        <p class="hint" data-slot="voice-note" style="margin-top:14px"></p>
        <div class="info-card" style="margin-top:14px">
          The mic button next to the chat box records until you go quiet, then transcribes
          <b>locally</b> — a whisper.cpp server you run yourself (see the main README), not a
          cloud speech API. A voice turn always gets read back out loud, regardless of the
          toggle above — if you asked by voice, you want to hear the answer.
        </div>
        <div class="info-card" style="margin-top:14px">
          By default the reply is read with your browser's own voice — free, instant, a bit
          robotic. Set <code>PIPER_EXE_PATH</code>/<code>PIPER_MODEL_PATH</code> in
          <code>api/.env</code> (see <code>api/.env.example</code>) to switch to a much more
          natural-sounding local Piper voice instead — still fully private, nothing leaves
          this machine.
        </div>
        <div class="field-row" style="margin-top:14px">
          <div class="field-row__text"><b>Listen for "hey buddy"</b><span>Keeps the mic open in the background whenever this is idle (closed, or minimized to the bubble) so saying "hey buddy" (or "hey assistant") opens the chat, Alexa-style</span></div>
          <label class="toggle"><input type="checkbox" id="ca-wake" ${draft.wakeWordEnabled ? 'checked' : ''}><span class="toggle__track"></span></label>
        </div>
        <p class="hint" data-slot="wake-note" style="margin-top:14px"></p>
        <div class="info-card" style="margin-top:14px">
          Each utterance it hears while listening is transcribed the same way as the mic
          button — locally, via whisper.cpp — purely to check it against a short wake-phrase
          list. Nothing is sent anywhere while it's just background noise or an unrelated
          conversation; this only turns on once you explicitly enable it here.
        </div>`;

    case 'shortcuts':
      return `
        <h2>Shortcuts</h2>
        <div class="info-card">
          <b>Enter</b> — send a message<br>
          <b>Esc</b> — back to the mini view<br><br>
          These work while the assistant window itself is focused — a browser page can't
          register a truly global, OS-wide hotkey the way a desktop app can.
        </div>`;

    case 'notifications':
      return `
        <h2>Notifications</h2>
        <div class="field-row">
          <div class="field-row__text"><b>Desktop notifications</b><span>Alerts you here when a task becomes due or overdue, even while minimized</span></div>
          <label class="toggle"><input type="checkbox" id="ca-notify" ${draft.desktopNotifications ? 'checked' : ''}><span class="toggle__track"></span></label>
        </div>
        <p class="hint" data-slot="notify-note" style="margin-top:14px"></p>`;

    case 'about':
      return `
        <h2>About</h2>
        <div class="info-card">
          <b>Cat Assistant</b> — a floating companion for MyTasks.<br><br>
          Uses your existing MyTasks account and data — same tasks, same goals, same API,
          just a different window for it.<br><br>
          Nothing here talks to any service beyond your own MyTasks API and, optionally, a
          local Ollama model on that same server.
        </div>`;

    default:
      return '';
  }
}

function wireGeneralPanel(el) {
  const nameInput = el.querySelector('#ca-name');
  const personalitySelect = el.querySelector('#ca-personality');
  const alwaysTop = el.querySelector('#ca-always-top');
  const sound = el.querySelector('#ca-sound');

  nameInput?.addEventListener('input', () => { draft.name = nameInput.value.trim() || DEFAULTS.name; });
  personalitySelect?.addEventListener('change', () => { draft.personality = personalitySelect.value; });
  alwaysTop?.addEventListener('change', () => { draft.alwaysOnTop = alwaysTop.checked; });
  sound?.addEventListener('change', () => { draft.soundEffects = sound.checked; });
}

function wireAppearancePanel(el) {
  const host = el.querySelector('[data-slot="accent-swatches"]');
  if (!host) return;

  host.onclick = (event) => {
    const btn = event.target.closest('[data-accent]');
    if (!btn) return;
    draft.accent = btn.dataset.accent;
    host.querySelectorAll('.accent-swatch').forEach((s) => s.classList.toggle('active', s === btn));
    applyAccent(el, draft.accent);
  };
}

function wireVoicePanel(el) {
  const speak = el.querySelector('#ca-speak');
  speak?.addEventListener('change', () => { draft.speakReplies = speak.checked; });

  const note = el.querySelector('[data-slot="voice-note"]');
  if (note) {
    note.textContent = isMicSupported()
      ? ''
      : "This browser can't record audio (no getUserMedia/MediaRecorder), so the mic button is hidden — speaking replies aloud still works everywhere modern.";
  }

  const wake = el.querySelector('#ca-wake');
  wake?.addEventListener('change', () => {
    // Takes effect once saved and the widget goes idle (mini view or fully
    // closed) — the settings view itself is never idle, so there's nothing
    // to start/stop right this moment.
    draft.wakeWordEnabled = wake.checked;
  });

  const wakeNote = el.querySelector('[data-slot="wake-note"]');
  if (wakeNote) {
    wakeNote.textContent = isMicSupported()
      ? ''
      : "This browser can't record audio (no getUserMedia/MediaRecorder), so wake-word listening isn't available here.";
  }
}

function wireNotificationsPanel(el) {
  const toggle = el.querySelector('#ca-notify');
  const note = el.querySelector('[data-slot="notify-note"]');
  if (!toggle) return;

  const refreshNote = () => {
    if (!('Notification' in window)) {
      note.textContent = "This browser doesn't support desktop notifications.";
    } else if (Notification.permission === 'denied') {
      note.textContent = 'Notifications are blocked for this site in your browser settings.';
    } else {
      note.textContent = '';
    }
  };
  refreshNote();

  toggle.addEventListener('change', async () => {
    if (toggle.checked && 'Notification' in window && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toggle.checked = false;
        refreshNote();
        return;
      }
    }

    draft.desktopNotifications = toggle.checked;

    if (draft.desktopNotifications) startReminderPolling();
    else stopReminderPolling();
  });
}

function flashSaved(el) {
  const flash = el.querySelector('[data-slot="save-flash"]');
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 1600);
}

function applySettingsToUi(el) {
  applyAccent(el, settings.accent);
  el.querySelectorAll('[data-slot="mini-name"], [data-slot="chat-name"], [data-slot="settings-name"]')
    .forEach((n) => { n.textContent = settings.name; });
}

/* --- Task-due desktop notifications --------------------------------------------
   The only thing this app could plausibly notify about unprompted — chat
   replies only ever happen right after you send a message, so there's
   nothing to "notify" about there. */
function startReminderPolling() {
  if (reminderTimer) return;
  checkReminders();
  reminderTimer = setInterval(checkReminders, 5 * 60 * 1000);
}

function stopReminderPolling() {
  clearInterval(reminderTimer);
  reminderTimer = null;
}

async function checkReminders() {
  try {
    const res = await Api.tasks.reminders();

    for (const task of res.data ?? []) {
      if (notifiedTaskIds.has(task.id)) continue;
      notifiedTaskIds.add(task.id);
      // eslint-disable-next-line no-new
      new Notification(settings.name, { body: task.title });
    }
  } catch {
    // Background nicety — quietly skip this round on any failure.
  }
}
