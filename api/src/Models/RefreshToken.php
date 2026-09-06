<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;
use App\Core\Env;
use App\Support\Crypto;

final class RefreshToken
{
    /**
     * Issue a new opaque refresh token. Only its SHA-256 hash is persisted,
     * so the raw value below is the single time it ever exists server-side.
     *
     * @return array{token:string,expires_at:string}
     */
    public static function issue(int $userId, ?string $deviceName, string $ip, string $userAgent): array
    {
        $token   = Crypto::randomToken(40);
        $ttl     = Env::int('JWT_REFRESH_TTL', 2592000);
        $expires = (new \DateTimeImmutable())->modify("+{$ttl} seconds")->format('Y-m-d H:i:s');

        Database::run(
            'INSERT INTO refresh_tokens (user_id, token_hash, device_name, user_agent, ip_address, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)',
            [$userId, Crypto::hashToken($token), $deviceName, $userAgent, $ip, $expires]
        );

        return ['token' => $token, 'expires_at' => $expires];
    }

    /** @return array<string,mixed>|null */
    public static function findValid(string $token): ?array
    {
        return Database::first(
            'SELECT * FROM refresh_tokens
              WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()',
            [Crypto::hashToken($token)]
        );
    }

    public static function revoke(string $token): void
    {
        Database::run(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
            [Crypto::hashToken($token)]
        );
    }

    public static function revokeAllForUser(int $userId): int
    {
        return Database::affected(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
            [$userId]
        );
    }

    /** Housekeeping — safe to call from a cron job. */
    public static function pruneExpired(): int
    {
        return Database::affected(
            'DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
        );
    }
}
