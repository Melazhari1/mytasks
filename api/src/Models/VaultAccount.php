<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;
use App\Support\Crypto;

final class VaultAccount
{
    /**
     * Listing NEVER touches the ciphertext. Only /vault/{id}/reveal decrypts,
     * and only behind a fresh unlock token.
     *
     * @return list<array<string,mixed>>
     */
    public static function allForUser(int $userId, ?string $search = null): array
    {
        $sql = 'SELECT id, platform_name, platform_url, username, notes,
                       last_revealed_at, created_at, updated_at
                  FROM vault_accounts
                 WHERE user_id = ?';

        $bindings = [$userId];

        if ($search !== null && $search !== '') {
            $sql       .= ' AND (platform_name LIKE ? OR username LIKE ?)';
            $term       = '%' . str_replace(['%', '_'], ['\%', '\_'], $search) . '%';
            $bindings[] = $term;
            $bindings[] = $term;
        }

        $sql .= ' ORDER BY platform_name ASC';

        return array_map([self::class, 'present'], Database::all($sql, $bindings));
    }

    /** @return array<string,mixed>|null */
    public static function findForUser(int $id, int $userId): ?array
    {
        return Database::first('SELECT * FROM vault_accounts WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    public static function create(
        int $userId,
        string $platformName,
        string $username,
        string $plainPassword,
        ?string $notes = null,
        ?string $platformUrl = null
    ): int {
        return Database::insert(
            'INSERT INTO vault_accounts (user_id, platform_name, platform_url, username, encrypted_password, notes)
             VALUES (?, ?, ?, ?, ?, ?)',
            [
                $userId,
                $platformName,
                $platformUrl,
                $username,
                Crypto::encrypt($plainPassword), // plain text never reaches the DB
                $notes,
            ]
        );
    }

    /** @param array<string,mixed> $fields */
    public static function update(int $id, int $userId, array $fields): void
    {
        $sets     = [];
        $bindings = [];

        foreach (['platform_name', 'platform_url', 'username', 'notes'] as $column) {
            if (array_key_exists($column, $fields)) {
                $sets[]     = "`{$column}` = ?";
                $bindings[] = $fields[$column];
            }
        }

        if (array_key_exists('password', $fields) && is_string($fields['password']) && $fields['password'] !== '') {
            $sets[]     = 'encrypted_password = ?';
            $bindings[] = Crypto::encrypt($fields['password']);
        }

        if ($sets === []) {
            return;
        }

        $bindings[] = $id;
        $bindings[] = $userId;

        Database::run(
            'UPDATE vault_accounts SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?',
            $bindings
        );
    }

    public static function delete(int $id, int $userId): int
    {
        return Database::affected('DELETE FROM vault_accounts WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /** @param array<string,mixed> $row */
    public static function reveal(array $row): string
    {
        $password = Crypto::decrypt((string) $row['encrypted_password']);

        Database::run('UPDATE vault_accounts SET last_revealed_at = NOW() WHERE id = ?', [(int) $row['id']]);

        return $password;
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        return [
            'id'               => (int) $row['id'],
            'platform_name'    => $row['platform_name'],
            'platform_url'     => $row['platform_url'] ?? null,
            'username'         => $row['username'],
            'notes'            => $row['notes'] ?? null,
            'password'         => null, // always hidden here — use /vault/{id}/reveal
            'last_revealed_at' => $row['last_revealed_at'] ?? null,
            'created_at'       => $row['created_at'] ?? null,
            'updated_at'       => $row['updated_at'] ?? null,
        ];
    }
}
