<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Talks to a locally-running Ollama server (https://ollama.com) to interpret
 * chat-box messages the fixed-grammar parser in chatbox.js didn't recognize.
 * One raw HTTP call, no SDK: Ollama's /api/generate with `format: "json"`
 * constrains the model to emit valid JSON, which the caller then validates
 * against its own schema before trusting any of it.
 *
 * This is opt-in and fails soft: if Ollama isn't running, isn't reachable,
 * or returns something unusable, generateJson() returns null rather than
 * throwing, so the chat box falls back to its plain-text "I didn't
 * understand that" reply instead of erroring out. Nothing here talks to any
 * service outside OLLAMA_URL — no cloud API, no API key.
 */
final class OllamaClient
{
    private string $baseUrl;
    private string $model;
    private int $timeoutSeconds;

    public function __construct()
    {
        $this->baseUrl = rtrim(Env::get('OLLAMA_URL', 'http://127.0.0.1:11434'), '/');
        $this->model = Env::get('OLLAMA_MODEL', 'llama3.1');
        $this->timeoutSeconds = Env::int('OLLAMA_TIMEOUT', 60);
    }

    /** @return array<string,mixed>|null */
    public function generateJson(string $prompt): ?array
    {
        $requestBody = json_encode([
            'model' => $this->model,
            'prompt' => $prompt,
            'format' => 'json',
            'stream' => false,
            'options' => ['temperature' => 0],
        ], JSON_THROW_ON_ERROR);

        [$status, $body] = $this->request($requestBody);

        if ($status < 200 || $status >= 300 || $body === '') {
            return null;
        }

        $envelope = json_decode($body, true);
        $text = is_array($envelope) ? ($envelope['response'] ?? null) : null;

        if (!is_string($text) || trim($text) === '') {
            return null;
        }

        $parsed = json_decode($text, true);

        return is_array($parsed) ? $parsed : null;
    }

    /** @return array{0:int,1:string} [status, body] */
    private function request(string $body): array
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => $body,
                'ignore_errors' => true,
                'timeout' => $this->timeoutSeconds,
            ],
        ]);

        $result = @file_get_contents($this->baseUrl . '/api/generate', false, $context);

        if ($result === false) {
            return [0, ''];
        }

        $status = 0;

        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1];
            }
        }

        return [$status, $result];
    }
}
