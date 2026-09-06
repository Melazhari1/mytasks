<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Any exception the client is allowed to see. Everything else becomes a 500.
 */
class HttpException extends \RuntimeException
{
    /** @param array<string,mixed> $extra */
    public function __construct(
        private int $statusCode,
        private string $errorCode,
        string $message,
        private array $extra = []
    ) {
        parent::__construct($message);
    }

    public function getStatusCode(): int
    {
        return $this->statusCode;
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }

    /** @return array<string,mixed> */
    public function getExtra(): array
    {
        return $this->extra;
    }

    /** @param array<string,mixed> $extra */
    public static function badRequest(string $message = 'Bad request.', array $extra = []): self
    {
        return new self(400, 'bad_request', $message, $extra);
    }

    public static function unauthorized(string $message = 'Authentication required.'): self
    {
        return new self(401, 'unauthorized', $message);
    }

    public static function forbidden(string $message = 'You do not have access to this resource.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function notFound(string $message = 'Resource not found.'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function conflict(string $message = 'Resource already exists.'): self
    {
        return new self(409, 'conflict', $message);
    }

    /** @param array<string,string[]> $errors */
    public static function validation(array $errors): self
    {
        return new self(422, 'validation_failed', 'The submitted data is invalid.', ['errors' => $errors]);
    }

    public static function tooManyRequests(string $message = 'Too many attempts. Please try again later.', int $retryAfter = 60): self
    {
        return new self(429, 'too_many_requests', $message, ['retry_after' => $retryAfter]);
    }
}
