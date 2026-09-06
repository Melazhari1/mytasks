<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Support\PiperClient;
use App\Support\WhisperClient;

/**
 * Backs the mic button and the speaker in both chat UIs. The mic uploads a
 * short WAV clip here, which gets forwarded to a local whisper.cpp server
 * (WhisperClient) for transcription. The speaker asks a locally-installed
 * Piper (PiperClient) to turn a reply into natural-sounding speech; the
 * browser's own speechSynthesis is the client-side fallback when Piper isn't
 * set up, so text-to-speech always works, just less realistically.
 */
final class VoiceController
{
    // A ~20s mono 16kHz WAV is well under 1MB; this is generous headroom,
    // not a real limit anyone should hit with normal use.
    private const MAX_BYTES = 15 * 1024 * 1024;

    // Matches the chat's own reply length cap (see ChatController) with a
    // little slack for the confirm-step prompts that go through here too.
    private const MAX_SPEAK_CHARS = 600;

    public function transcribe(Request $request): void
    {
        $file = $request->file('audio');

        if ($file === null || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw HttpException::badRequest('No audio clip received.');
        }

        if (($file['size'] ?? 0) > self::MAX_BYTES) {
            throw HttpException::badRequest('That clip is too large.');
        }

        $client = new WhisperClient();
        $text = $client->transcribe($file['tmp_name']);

        if ($text === null) {
            throw new HttpException(503, 'whisper_unavailable', 'The local speech-to-text helper is not reachable right now.');
        }

        Response::ok(['text' => $text]);
    }

    public function speak(Request $request): void
    {
        $text = trim((string) $request->input('text', ''));

        if ($text === '') {
            throw HttpException::badRequest('No text to speak.');
        }

        if (mb_strlen($text) > self::MAX_SPEAK_CHARS) {
            throw HttpException::badRequest('That reply is too long to speak.');
        }

        // Same script-range check as the frontend's detectLang() (chat-strings.js)
        // — kept in sync deliberately rather than shared, since one's JS and
        // one's PHP. Picks the Arabic Piper voice for Arabic text so it
        // isn't read aloud in an English accent (see PiperClient).
        $lang = preg_match('/[\x{0600}-\x{06FF}\x{0750}-\x{077F}]/u', $text) === 1 ? 'ar' : 'en';

        $client = new PiperClient();
        $wav = $client->synthesize($text, $lang);

        if ($wav === null) {
            throw new HttpException(503, 'piper_unavailable', 'The local text-to-speech helper is not reachable right now.');
        }

        if (!headers_sent()) {
            header('Content-Type: audio/wav');
            header('Content-Length: ' . (string) strlen($wav));
            header('Cache-Control: no-store');
        }

        echo $wav;
        exit;
    }
}
