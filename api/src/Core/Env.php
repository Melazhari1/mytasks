<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Tiny .env reader. Values land in a private static store (not $_ENV/getenv)
 * so they can't leak through phpinfo() or a stray var_dump of the superglobals.
 */
final class Env
{
    /** @var array<string,string> */
    private static array $values = [];

    private static bool $loaded = false;

    public static function load(string $path): void
    {
        if (self::$loaded) {
            return;
        }

        self::$loaded = true;

        if (!is_readable($path)) {
            return;
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];

        foreach ($lines as $line) {
            $line = trim($line);

            if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                continue;
            }

            [$key, $value] = explode('=', $line, 2);

            $key   = trim($key);
            $value = trim($value);

            if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                // Quoted: take everything up to the matching quote, discard the rest.
                $quote = $value[0];
                $end   = strpos($value, $quote, 1);

                $value = $end === false
                    ? substr($value, 1)
                    : substr($value, 1, $end - 1);
            } else {
                // Unquoted: an inline "# comment" is not part of the value.
                // TWO_FACTOR_REQUIRED=true   # explanation   ->  "true"
                $value = trim((string) preg_replace('/\s+#.*$/', '', $value));
            }

            self::$values[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        $value = self::$values[$key] ?? null;

        if ($value === null || $value === '') {
            return $default;
        }

        return $value;
    }

    public static function require(string $key): string
    {
        $value = self::get($key);

        if ($value === null) {
            throw new \RuntimeException("Missing required environment variable: {$key}. Copy .env.example to .env and fill it in.");
        }

        return $value;
    }

    public static function int(string $key, int $default): int
    {
        $value = self::get($key);

        return $value === null ? $default : (int) $value;
    }

    public static function bool(string $key, bool $default): bool
    {
        $value = self::get($key);

        if ($value === null) {
            return $default;
        }

        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }
}
