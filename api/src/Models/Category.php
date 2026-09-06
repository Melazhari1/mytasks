<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;

final class Category
{
    /** @return list<array<string,mixed>> */
    public static function allForUser(int $userId, bool $withCounts = true): array
    {
        if (!$withCounts) {
            $rows = Database::all(
                'SELECT * FROM categories WHERE user_id = ? ORDER BY name ASC',
                [$userId]
            );

            return array_map([self::class, 'present'], $rows);
        }

        $rows = Database::all(
            "SELECT c.*,
                    COUNT(t.id)                                              AS tasks_total,
                    SUM(CASE WHEN t.status = 'pending'   THEN 1 ELSE 0 END)  AS tasks_pending,
                    SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END)  AS tasks_completed
               FROM categories c
          LEFT JOIN tasks t ON t.category_id = c.id
              WHERE c.user_id = ?
           GROUP BY c.id
           ORDER BY c.name ASC",
            [$userId]
        );

        return array_map(static function (array $row): array {
            $category = self::present($row);

            $category['stats'] = [
                'total'     => (int) ($row['tasks_total'] ?? 0),
                'pending'   => (int) ($row['tasks_pending'] ?? 0),
                'completed' => (int) ($row['tasks_completed'] ?? 0),
            ];

            return $category;
        }, $rows);
    }

    /** @return array<string,mixed>|null */
    public static function findForUser(int $id, int $userId): ?array
    {
        return Database::first('SELECT * FROM categories WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    public static function existsForUser(int $id, int $userId): bool
    {
        return self::findForUser($id, $userId) !== null;
    }

    public static function nameTaken(int $userId, string $name, ?int $exceptId = null): bool
    {
        $sql      = 'SELECT id FROM categories WHERE user_id = ? AND name = ?';
        $bindings = [$userId, $name];

        if ($exceptId !== null) {
            $sql       .= ' AND id <> ?';
            $bindings[] = $exceptId;
        }

        return Database::first($sql, $bindings) !== null;
    }

    public static function create(int $userId, string $name, ?string $icon, ?string $color): int
    {
        return Database::insert(
            'INSERT INTO categories (user_id, name, icon, color) VALUES (?, ?, ?, ?)',
            [$userId, $name, $icon, $color]
        );
    }

    /** @param array<string,mixed> $fields */
    public static function update(int $id, int $userId, array $fields): void
    {
        if ($fields === []) {
            return;
        }

        $allowed  = ['name', 'icon', 'color'];
        $sets     = [];
        $bindings = [];

        foreach ($fields as $column => $value) {
            if (!in_array($column, $allowed, true)) {
                continue;
            }

            $sets[]     = "`{$column}` = ?";
            $bindings[] = $value;
        }

        if ($sets === []) {
            return;
        }

        $bindings[] = $id;
        $bindings[] = $userId;

        Database::run(
            'UPDATE categories SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?',
            $bindings
        );
    }

    public static function delete(int $id, int $userId): int
    {
        // Tasks cascade via the foreign key.
        return Database::affected('DELETE FROM categories WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /** Deletes every category (and, via cascade, every task in one) this user owns. Returns how many. */
    public static function deleteAllForUser(int $userId): int
    {
        return Database::affected('DELETE FROM categories WHERE user_id = ?', [$userId]);
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        return [
            'id'         => (int) $row['id'],
            'name'       => $row['name'],
            'icon'       => $row['icon'],
            'color'      => $row['color'],
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
}
