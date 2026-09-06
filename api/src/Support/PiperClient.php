<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Talks to a locally-installed Piper (https://github.com/rhasspy/piper) to
 * turn a reply into a natural-sounding WAV clip. Piper ships as a plain CLI
 * binary, not a server, so this shells out to it per request via proc_open()
 * with an array command — no shell string to escape, same reason WhisperClient
 * avoids curl: no extra dependency, no SDK.
 *
 * This is the local, higher-quality counterpart to the browser's built-in
 * speechSynthesis: that works with zero install and is already fully
 * on-device, but the voices are noticeably robotic. Piper's neural voices
 * sound much more natural while staying just as private — text never leaves
 * this machine.
 *
 * Opt-in and fails soft: if PIPER_EXE_PATH/PIPER_MODEL_PATH aren't set, or
 * the binary errors out, synthesize() returns null rather than throwing, so
 * VoiceController turns that into a plain 503 the chat already knows how to
 * fall back from (same contract as OllamaClient / WhisperClient).
 */
final class PiperClient
{
    private string $exePath;
    private string $modelPath;
    private string $modelPathAr;
    private int $timeoutSeconds;

    public function __construct()
    {
        $this->exePath = Env::get('PIPER_EXE_PATH', '') ?? '';
        $this->modelPath = Env::get('PIPER_MODEL_PATH', '') ?? '';
        // Optional: a second, Arabic-specific voice. Piper voices are
        // per-language (trained on one language's phonemes), so the
        // default PIPER_MODEL_PATH — normally English — would mispronounce
        // Arabic text badly. When this isn't set, Arabic text still gets
        // spoken (better than nothing), just in the default voice.
        $this->modelPathAr = Env::get('PIPER_MODEL_PATH_AR', '') ?? '';
        $this->timeoutSeconds = Env::int('PIPER_TIMEOUT', 20);
    }

    public function isConfigured(): bool
    {
        return $this->exePath !== '' && $this->modelPath !== ''
            && is_file($this->exePath) && is_file($this->modelPath);
    }

    /**
     * @param string $lang 'ar' picks the Arabic voice if PIPER_MODEL_PATH_AR
     *     is set and exists, otherwise falls back to the default voice —
     *     same for any other value.
     * @return string|null Raw WAV bytes, or null if unavailable/failed.
     */
    public function synthesize(string $text, string $lang = 'en'): ?string
    {
        $text = trim($text);
        if ($text === '' || !$this->isConfigured()) {
            return null;
        }

        $modelPath = $lang === 'ar' && $this->modelPathAr !== '' && is_file($this->modelPathAr)
            ? $this->modelPathAr
            : $this->modelPath;

        $outFile = tempnam(sys_get_temp_dir(), 'piper_') . '.wav';

        $process = @proc_open(
            [$this->exePath, '--model', $modelPath, '--output_file', $outFile],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );

        if (!is_resource($process)) {
            @unlink($outFile);
            return null;
        }

        fwrite($pipes[0], $text);
        fclose($pipes[0]);

        // Drain stdout/stderr non-blockingly so piper.exe never stalls
        // waiting on a full pipe buffer while it synthesizes.
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $deadline = microtime(true) + $this->timeoutSeconds;
        $status = proc_get_status($process);

        while ($status['running'] && microtime(true) < $deadline) {
            fread($pipes[1], 8192);
            fread($pipes[2], 8192);
            usleep(50_000);
            $status = proc_get_status($process);
        }

        if ($status['running']) {
            proc_terminate($process);
        }

        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);

        $wav = is_file($outFile) ? @file_get_contents($outFile) : false;
        @unlink($outFile);

        return $wav !== false && $wav !== '' ? $wav : null;
    }
}
