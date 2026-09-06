<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;
use App\Core\Env;
use App\Support\Crypto;

final class OtpCode
{
    /**
     * Invalidate any outstanding codes for this purpose, then issue one.
     * Returns the plain code so the caller can mail it.
     */
    public static function issue(int $userId, string $purpose = 'login'): string
    {
        $code = Crypto::numericCode(Env::int('OTP_LENGTH', 6));
        $ttl  = Env::int('OTP_TTL', 300);

        Database::run(
            'UPDATE otp_codes SET used_at = NOW() WHERE user_id = ? AND purpose = ? AND used_at IS NULL',
            [$userId, $purpose]
        );

        Database::run(
            'INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
            [$userId, Crypto::hashToken($code), $purpose, $ttl]
        );

        return $code;
    }

    /**
     * Consume a code. Single use — a valid code is burned whether or not the
     * caller does anything with the result.
     */
    public static function consume(int $userId, string $code, string $purpose = 'login'): bool
    {
        $code = trim($code);

        $row = Database::first(
            'SELECT * FROM otp_codes
              WHERE user_id = ? AND purpose = ? AND used_at IS NULL
              ORDER BY id DESC LIMIT 1',
            [$userId, $purpose]
        );

        if ($row === null) {
            return false;
        }

        if (strtotime((string) $row['expires_at']) <= time()) {
            Database::run('UPDATE otp_codes SET used_at = NOW() WHERE id = ?', [$row['id']]);

            return false;
        }

        if ((int) $row['attempts'] >= Env::int('OTP_MAX_ATTEMPTS', 5)) {
            Database::run('UPDATE otp_codes SET used_at = NOW() WHERE id = ?', [$row['id']]);

            return false;
        }

        if (!hash_equals((string) $row['code_hash'], Crypto::hashToken($code))) {
            Database::run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [$row['id']]);

            return false;
        }

        Database::run('UPDATE otp_codes SET used_at = NOW() WHERE id = ?', [$row['id']]);

        return true;
    }

    public static function pruneExpired(): int
    {
        return Database::affected('DELETE FROM otp_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
    }
}
