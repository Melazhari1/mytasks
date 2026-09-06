/* =============================================================================
   Voice input — shared by web/chatbox.js and cat-assistant/. Records a clip
   with the mic, auto-stops once you go quiet, and hand-rolls a WAV encode
   (mono, 16kHz) so it can be sent to a local whisper.cpp server — same
   "small enough to not need a library" spirit as the QR encoder and the
   Cat Assistant's WAV-free chart drawing.

   Why not just use the browser's SpeechRecognition, which needs none of
   this? Because in Chrome/Edge that API sends your audio to Google's
   servers to transcribe — this keeps it on WHISPER_URL only. See
   api/src/Support/WhisperClient.php and each app's README.
   ========================================================================== */

export function isMicSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

/**
 * Starts recording immediately. Auto-stops after `silenceMs` of quiet
 * following any speech, or after `maxMs` regardless — whichever comes
 * first. Returns `{ stop, done }`: call `stop()` to end it early (e.g. the
 * user clicks the mic button again); `done` resolves with the recorded clip
 * once it stops, one way or another.
 */
export async function recordUntilSilence({ maxMs = 20000, silenceMs = 1200, silenceThreshold = 0.02 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const levels = new Uint8Array(analyser.frequencyBinCount);

  let hasSpoken = false;
  let silenceStart = null;
  let stopped = false;

  const done = new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })), { once: true });
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pollId);
    clearTimeout(maxTimer);
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close().catch(() => {});
  };

  const pollId = setInterval(() => {
    analyser.getByteTimeDomainData(levels);

    let sumSquares = 0;
    for (let i = 0; i < levels.length; i++) {
      const v = (levels[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / levels.length);

    if (rms > silenceThreshold) {
      hasSpoken = true;
      silenceStart = null;
    } else if (hasSpoken) {
      silenceStart ??= Date.now();
      if (Date.now() - silenceStart > silenceMs) stop();
    }
  }, 100);

  const maxTimer = setTimeout(stop, maxMs);

  recorder.start();

  return { stop, done };
}

/** Decodes whatever MediaRecorder produced and re-encodes as 16-bit PCM WAV
 *  at 16kHz mono — the format whisper.cpp's server expects. */
export async function toWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  await decodeCtx.close();

  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);

  let monoSource = decoded;
  if (decoded.numberOfChannels > 1) {
    monoSource = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const out = monoSource.getChannelData(0);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < chData.length; i++) out[i] += chData[i] / decoded.numberOfChannels;
    }
  }

  const src = offline.createBufferSource();
  src.buffer = monoSource;
  src.connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), targetRate);
}

/**
 * Continuous "wake word" listening — keeps a single mic stream open (unlike
 * recordUntilSilence, which is one-shot and would flicker the browser's mic
 * indicator on and off for every utterance) and hands each speech-then-
 * silence clip it detects to `onUtterance`, then immediately starts
 * listening for the next one. Stays fully local: this module never
 * transcribes anything itself, it's transport-agnostic — callers decide how
 * (see chatbox.js / cat-assistant's app.js, both use Api.voice.transcribe,
 * i.e. local whisper.cpp, same as the mic button).
 */
export async function listenForWake({
  onUtterance, silenceMs = 700, silenceThreshold = 0.035, maxUtteranceMs = 8000, minUtteranceMs = 350,
} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const levels = new Uint8Array(analyser.frequencyBinCount);

  let stopped = false;
  let recorder = null;
  let chunks = [];
  let hasSpoken = false;
  let silenceStart = null;
  let utteranceTimer = null;
  let utteranceStartedAt = 0;

  const startUtterance = () => {
    chunks = [];
    utteranceStartedAt = Date.now();
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      clearTimeout(utteranceTimer);
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const duration = Date.now() - utteranceStartedAt;
      recorder = null;
      hasSpoken = false;
      silenceStart = null;
      // A noisy mic can trip the volume gate on a brief pop/click that never
      // was speech — sending that to whisper.cpp wastes a transcription
      // (and, worse, piles onto its single-request queue if it happens
      // often, starving out the transcription the user actually wanted).
      if (!stopped && duration >= minUtteranceMs) onUtterance(blob);
    }, { once: true });
    recorder.start();
    utteranceTimer = setTimeout(() => { if (recorder && recorder.state !== 'inactive') recorder.stop(); }, maxUtteranceMs);
  };

  const pollId = setInterval(() => {
    if (stopped) return;
    analyser.getByteTimeDomainData(levels);

    let sumSquares = 0;
    for (let i = 0; i < levels.length; i++) {
      const v = (levels[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / levels.length);

    if (rms > silenceThreshold) {
      if (!recorder) startUtterance();
      hasSpoken = true;
      silenceStart = null;
    } else if (hasSpoken && recorder) {
      silenceStart ??= Date.now();
      if (Date.now() - silenceStart > silenceMs) recorder.stop();
    }
  }, 100);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pollId);
    clearTimeout(utteranceTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close().catch(() => {});
  };

  return { stop };
}

// "Hey buddy" plus a few natural variants — matched at the start of a
// transcribed utterance only (not mid-sentence), so an unrelated remark
// that happens to mention it doesn't accidentally trigger it. "buddy" was
// picked over the earlier "niko" specifically for weak-mic reliability: a
// sharp plosive onset ("b") and a common, well-represented word transcribe
// far more reliably under low mic gain/noise than a soft nasal-start word.
const WAKE_PHRASES = [
  'hey buddy', 'hi buddy', 'ok buddy', 'okay buddy',
  'hey assistant', 'hi assistant', 'ok assistant', 'okay assistant',
];

/**
 * Checks a transcribed utterance for a wake phrase at its start. Returns
 * `{ matched: false }`, or `{ matched: true, remainder }` where `remainder`
 * is whatever was said right after the wake phrase (e.g. "hey buddy, add a
 * task" -> "add a task"), Alexa-style — empty string if it was just the
 * wake phrase on its own.
 */
export function matchWake(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normWords = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));

  for (const phrase of WAKE_PHRASES) {
    const phraseWords = phrase.split(' ');
    if (normWords.length >= phraseWords.length && phraseWords.every((pw, i) => normWords[i] === pw)) {
      return { matched: true, remainder: words.slice(phraseWords.length).join(' ').trim() };
    }
  }

  return { matched: false, remainder: '' };
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
