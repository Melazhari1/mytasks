<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Talks to a locally-running whisper.cpp server (https://github.com/ggerganov/whisper.cpp
 * — its `server` example, not a Python install) to transcribe a short voice
 * clip. One raw multipart/form-data POST, no SDK, no curl dependency — same
 * "no external HTTP client library" stance as GoogleDriveUploader.
 *
 * This is the fully-local counterpart to the browser's own SpeechRecognition:
 * that API works with zero install, but in Chrome/Edge it sends your audio to
 * Google's servers to transcribe. This sends it to WHISPER_URL only — a
 * process on the same machine (or LAN) you started yourself.
 *
 * Opt-in and fails soft: if whisper.cpp isn't running, transcribe() returns
 * null rather than throwing, so VoiceController turns that into a plain 503
 * the chat already knows how to talk about (same contract as OllamaClient).
 */
final class WhisperClient
{
    private string $baseUrl;
    private int $timeoutSeconds;
    private string $language;

    public function __construct()
    {
        $this->baseUrl = rtrim(Env::get('WHISPER_URL', 'http://127.0.0.1:8081'), '/');
        $this->timeoutSeconds = Env::int('WHISPER_TIMEOUT', 30);
        // 'auto' lets whisper.cpp detect the spoken language itself (needs a
        // multilingual model — an .en model only ever understands English,
        // whatever this is set to). Pin it to a specific code (e.g. 'ar')
        // if auto-detection guesses wrong on short clips.
        $this->language = Env::get('WHISPER_LANGUAGE', 'auto') ?? 'auto';
    }

    /** @param string $wavFilePath Path to a 16-bit PCM WAV file (mono, 16kHz is ideal). */
    public function transcribe(string $wavFilePath): ?string
    {
        $audio = @file_get_contents($wavFilePath);
        if ($audio === false) return null;

        $boundary = 'MyTasksVoice' . bin2hex(random_bytes(12));
        $body = $this->buildMultipartBody($boundary, $audio, $this->language);

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: multipart/form-data; boundary={$boundary}\r\n",
                'content' => $body,
                'ignore_errors' => true,
                'timeout' => $this->timeoutSeconds,
            ],
        ]);

        $result = @file_get_contents($this->baseUrl . '/inference', false, $context);
        if ($result === false) return null;

        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1];
            }
        }
        if ($status < 200 || $status >= 300) return null;

        $decoded = json_decode($result, true);
        $text = is_array($decoded) ? ($decoded['text'] ?? null) : null;

        return is_string($text) ? trim($text) : null;
    }

    private function buildMultipartBody(string $boundary, string $audio, string $language): string
    {
        $eol = "\r\n";

        // whisper.cpp's server example wants json response_format so the
        // reply is {"text": "..."} rather than plain text.
        $fields = ['response_format' => 'json', 'temperature' => '0', 'language' => $language];
        $body = '';

        foreach ($fields as $name => $value) {
            $body .= "--{$boundary}{$eol}";
            $body .= "Content-Disposition: form-data; name=\"{$name}\"{$eol}{$eol}";
            $body .= $value . $eol;
        }

        $body .= "--{$boundary}{$eol}";
        $body .= "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"{$eol}";
        $body .= "Content-Type: audio/wav{$eol}{$eol}";
        $body .= $audio . $eol;
        $body .= "--{$boundary}--{$eol}";

        return $body;
    }
}
