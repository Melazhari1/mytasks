<?php

declare(strict_types=1);

namespace App\Core;

final class Request
{
    /** @var array<string,mixed> */
    private array $body;

    /** @var array<string,string> */
    private array $routeParams = [];

    /** @var array<string,mixed>|null Set by AuthMiddleware once a token is verified. */
    private ?array $auth = null;

    public function __construct()
    {
        $this->body = $this->parseBody();
    }

    /** @return array<string,mixed> */
    private function parseBody(): array
    {
        $contentType = strtolower($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '');

        if (str_contains($contentType, 'application/json')) {
            $raw = file_get_contents('php://input') ?: '';

            if (trim($raw) === '') {
                return [];
            }

            $decoded = json_decode($raw, true);

            if (!is_array($decoded)) {
                throw HttpException::badRequest('Request body is not valid JSON.');
            }

            return $decoded;
        }

        if ($this->method() === 'POST' && $_POST !== []) {
            return $_POST;
        }

        // PUT/PATCH/DELETE with form encoding.
        $raw = file_get_contents('php://input') ?: '';

        if ($raw !== '' && str_contains($contentType, 'application/x-www-form-urlencoded')) {
            parse_str($raw, $parsed);

            return $parsed;
        }

        return [];
    }

    public function method(): string
    {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

        // Allow method override for clients stuck behind restrictive proxies.
        if ($method === 'POST') {
            $override = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? '');
            if (in_array($override, ['PUT', 'PATCH', 'DELETE'], true)) {
                return $override;
            }
        }

        return $method;
    }

    /**
     * Path relative to the API root, always leading-slash normalised.
     * e.g. /xxp/mytasks/api/auth/login  ->  /auth/login
     */
    public function path(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $uri = rawurldecode($uri);

        // Strip the directory the front controller lives in.
        $scriptDir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? ''));

        if ($scriptDir !== '' && $scriptDir !== '/' && str_starts_with($uri, $scriptDir)) {
            $uri = substr($uri, strlen($scriptDir));
        }

        // Tolerate clients that include /api in the path when the app is at the web root.
        $uri = '/' . trim($uri, '/');

        if ($uri !== '/' && (str_starts_with($uri, '/api/') || $uri === '/api')) {
            $uri = '/' . trim(substr($uri, 4), '/');
        }

        return $uri === '' ? '/' : $uri;
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $default;
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->body);
    }

    /** @return array<string,mixed> */
    public function all(): array
    {
        return $this->body;
    }

    /** @return array<string,mixed>|null Raw $_FILES entry for a multipart upload field. */
    public function file(string $key): ?array
    {
        return isset($_FILES[$key]) && is_array($_FILES[$key]) ? $_FILES[$key] : null;
    }

    public function query(string $key, ?string $default = null): ?string
    {
        $value = $_GET[$key] ?? null;

        return is_string($value) && $value !== '' ? $value : $default;
    }

    public function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));

        $value = $_SERVER[$key]
            ?? $_SERVER[strtoupper(str_replace('-', '_', $name))]
            ?? null;

        if ($value === null && function_exists('apache_request_headers')) {
            foreach (apache_request_headers() as $headerName => $headerValue) {
                if (strcasecmp($headerName, $name) === 0) {
                    return $headerValue;
                }
            }
        }

        return is_string($value) && $value !== '' ? $value : null;
    }

    public function bearerToken(): ?string
    {
        $header = $this->header('Authorization') ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null);

        if (!is_string($header) || !preg_match('/^Bearer\s+(\S+)$/i', $header, $m)) {
            return null;
        }

        return $m[1];
    }

    public function cookie(string $name): ?string
    {
        $value = $_COOKIE[$name] ?? null;

        return is_string($value) && $value !== '' ? $value : null;
    }

    public function ip(): string
    {
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public function userAgent(): string
    {
        return substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? 'unknown'), 0, 255);
    }

    /** @param array<string,string> $params */
    public function setRouteParams(array $params): void
    {
        $this->routeParams = $params;
    }

    public function param(string $key): ?string
    {
        return $this->routeParams[$key] ?? null;
    }

    public function intParam(string $key): int
    {
        $value = $this->param($key);

        if ($value === null || !ctype_digit($value)) {
            throw HttpException::badRequest("Invalid '{$key}' in the URL.");
        }

        return (int) $value;
    }

    /** @param array<string,mixed> $auth */
    public function setAuth(array $auth): void
    {
        $this->auth = $auth;
    }

    /** @return array<string,mixed> */
    public function auth(): array
    {
        if ($this->auth === null) {
            throw HttpException::unauthorized();
        }

        return $this->auth;
    }

    public function userId(): int
    {
        return (int) $this->auth()['sub'];
    }
}
