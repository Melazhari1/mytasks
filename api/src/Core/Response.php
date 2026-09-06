<?php

declare(strict_types=1);

namespace App\Core;

final class Response
{
    /** @param array<string,mixed>|list<mixed> $payload */
    public static function json(array $payload, int $status = 200): never
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }

        // Filter out nulls at the top level so responses stay tidy.
        if (array_is_list($payload) === false) {
            $payload = array_filter($payload, static fn ($v) => $v !== null);
        }

        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /** @param array<string,mixed>|list<mixed> $data */
    public static function ok(array $data, int $status = 200): never
    {
        self::json(['data' => $data], $status);
    }

    /** @param array<string,mixed> $data */
    public static function created(array $data): never
    {
        self::json(['data' => $data], 201);
    }

    public static function noContent(): never
    {
        if (!headers_sent()) {
            http_response_code(204);
        }

        exit;
    }

    public static function message(string $message, int $status = 200): never
    {
        self::json(['message' => $message], $status);
    }
}
