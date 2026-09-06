<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;
use App\Core\Env;

final class User
{
    /** @return array<string,mixed>|null */
    public static function find(int $id): ?array
    {
        return Database::first('SELECT * FROM users WHERE id = ?', [$id]);
    }

    /** @return array<string,mixed>|null */
    public static function findByEmail(string $email): ?array
    {
        return Database::first('SELECT * FROM users WHERE email = ?', [strtolower(trim($email))]);
    }

    public static function create(string $email, string $password, ?string $name = null): int
    {
        return Database::insert(
            'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
            [$name, strtolower(trim($email)), self::hashPassword($password)]
        );
    }

    /**
     * Argon2id where available (PHP 7.3+ compiled with libargon2), bcrypt
     * otherwise. Both are deliberately slow; that is the feature.
     */
    public static function hashPassword(string $password): string
    {
        if (defined('PASSWORD_ARGON2ID')) {
            return password_hash($password, PASSWORD_ARGON2ID, [
                'memory_cost' => 65536,
                'time_cost'   => 4,
                'threads'     => 2,
            ]);
        }

        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    }

    /** @param array<string,mixed> $user */
    public static function verifyPassword(array $user, string $password): bool
    {
        $hash = (string) $user['password_hash'];

        if (!password_verify($password, $hash)) {
            return false;
        }

        // Transparently upgrade hashes when the algorithm or cost changes.
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;

        if (password_needs_rehash($hash, $algo)) {
            Database::run('UPDATE users SET password_hash = ? WHERE id = ?', [
                self::hashPassword($password),
                (int) $user['id'],
            ]);
        }

        return true;
    }

    /** @param array<string,mixed> $user */
    public static function isLocked(array $user): bool
    {
        if ($user['locked_until'] === null) {
            return false;
        }

        return strtotime((string) $user['locked_until']) > time();
    }

    public static function registerFailedLogin(int $userId): void
    {
        $max     = Env::int('LOGIN_MAX_FAILURES', 5);
        $minutes = Env::int('LOGIN_LOCK_MINUTES', 15);

        Database::run(
            'UPDATE users
                SET failed_login_attempts = failed_login_attempts + 1,
                    locked_until = IF(failed_login_attempts + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until)
              WHERE id = ?',
            [$max, $minutes, $userId]
        );
    }

    public static function registerSuccessfulLogin(int $userId): void
    {
        Database::run(
            'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?',
            [$userId]
        );
    }

    public static function setTwoFactorSecret(int $userId, ?string $encryptedSecret, string $method): void
    {
        Database::run(
            'UPDATE users SET two_factor_secret = ?, two_factor_method = ? WHERE id = ?',
            [$encryptedSecret, $method, $userId]
        );
    }

    public static function confirmTwoFactor(int $userId): void
    {
        Database::run(
            'UPDATE users SET two_factor_enabled = 1, two_factor_confirmed_at = NOW() WHERE id = ?',
            [$userId]
        );
    }

    public static function disableTwoFactor(int $userId): void
    {
        Database::run(
            "UPDATE users
                SET two_factor_enabled = 0,
                    two_factor_secret = NULL,
                    two_factor_method = 'email',
                    two_factor_confirmed_at = NULL
              WHERE id = ?",
            [$userId]
        );
    }

    public static function setMasterPassword(int $userId, string $masterPassword): void
    {
        Database::run('UPDATE users SET master_password_hash = ? WHERE id = ?', [
            self::hashPassword($masterPassword),
            $userId,
        ]);
    }

    /**
     * Public shape — password hashes and 2FA secrets never leave the server.
     *
     * @param array<string,mixed> $user
     * @return array<string,mixed>
     */
    public static function present(array $user): array
    {
        return [
            'id'                 => (int) $user['id'],
            'name'               => $user['name'],
            'email'              => $user['email'],
            'two_factor_enabled' => (bool) $user['two_factor_enabled'],
            'two_factor_method'  => $user['two_factor_method'],
            'vault_locked_by_master_password' => $user['master_password_hash'] !== null,
            'last_login_at'      => $user['last_login_at'],
            'created_at'         => $user['created_at'],
        ];
    }
}
