<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;

final class SocialIdea
{
    /**
     * Supported filters:
     *   search=<string>    matches idea or links
     *   status=pending|future|done
     *   platform=<one platform key>   matches ideas tagged with it
     *   sort=created_at|updated_at   dir=asc|desc
     *   page=<int>  per_page=<int>
     *
     * @param array<string,mixed> $filters
     * @return array{items:list<array<string,mixed>>,meta:array<string,int>}
     */
    public static function search(int $userId, array $filters): array
    {
        $where    = ['user_id = ?'];
        $bindings = [$userId];

        if (!empty($filters['search'])) {
            $where[]    = '(idea LIKE ? OR links LIKE ?)';
            $term       = '%' . str_replace(['%', '_'], ['\%', '\_'], (string) $filters['search']) . '%';
            $bindings[] = $term;
            $bindings[] = $term;
        }

        if (!empty($filters['status'])) {
            $where[]    = 'status = ?';
            $bindings[] = $filters['status'];
        }

        if (!empty($filters['platform'])) {
            // `platforms` is a JSON array column — JSON_CONTAINS needs the
            // needle itself JSON-encoded, so a plain string becomes '"x"'.
            $where[]    = 'JSON_CONTAINS(platforms, JSON_QUOTE(?))';
            $bindings[] = (string) $filters['platform'];
        }

        $whereSql = implode(' AND ', $where);

        $sortMap    = ['created_at' => 'created_at', 'updated_at' => 'updated_at'];
        $sortColumn = $sortMap[$filters['sort'] ?? 'created_at'] ?? $sortMap['created_at'];
        $direction  = strtolower((string) ($filters['dir'] ?? 'desc')) === 'asc' ? 'ASC' : 'DESC';

        $perPage = max(1, min(100, (int) ($filters['per_page'] ?? 12)));
        $page    = max(1, (int) ($filters['page'] ?? 1));
        $offset  = ($page - 1) * $perPage;

        $total = (int) (Database::first("SELECT COUNT(*) AS c FROM social_ideas WHERE {$whereSql}", $bindings)['c'] ?? 0);

        $rows = Database::all(
            "SELECT * FROM social_ideas
              WHERE {$whereSql}
           ORDER BY {$sortColumn} {$direction}, id DESC
              LIMIT {$perPage} OFFSET {$offset}",
            $bindings
        );

        return [
            'items' => array_map([self::class, 'present'], $rows),
            'meta'  => [
                'total'       => $total,
                'page'        => $page,
                'per_page'    => $perPage,
                'total_pages' => (int) ceil($total / $perPage),
            ],
        ];
    }

    /** @return array<string,mixed>|null */
    public static function findForUser(int $id, int $userId): ?array
    {
        return Database::first('SELECT * FROM social_ideas WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /**
     * @param list<string> $platforms
     */
    public static function create(int $userId, string $idea, ?string $links, string $status, array $platforms): int
    {
        return Database::insert(
            'INSERT INTO social_ideas (user_id, idea, links, status, platforms) VALUES (?, ?, ?, ?, ?)',
            [$userId, $idea, $links, $status, self::encodePlatforms($platforms)]
        );
    }

    /** @param array<string,mixed> $fields */
    public static function update(int $id, int $userId, array $fields): void
    {
        $sets     = [];
        $bindings = [];

        if (array_key_exists('idea', $fields)) {
            $sets[]     = '`idea` = ?';
            $bindings[] = $fields['idea'];
        }

        if (array_key_exists('links', $fields)) {
            $sets[]     = '`links` = ?';
            $bindings[] = $fields['links'];
        }

        if (array_key_exists('status', $fields)) {
            $sets[]     = '`status` = ?';
            $bindings[] = $fields['status'];
        }

        if (array_key_exists('platforms', $fields)) {
            $sets[]     = '`platforms` = ?';
            $bindings[] = self::encodePlatforms($fields['platforms']);
        }

        if ($sets === []) {
            return;
        }

        $bindings[] = $id;
        $bindings[] = $userId;

        Database::run(
            'UPDATE social_ideas SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?',
            $bindings
        );
    }

    public static function delete(int $id, int $userId): int
    {
        return Database::affected('DELETE FROM social_ideas WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /** @param list<string> $platforms */
    private static function encodePlatforms(array $platforms): ?string
    {
        return $platforms === [] ? null : json_encode(array_values($platforms), JSON_THROW_ON_ERROR);
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        $platforms = [];

        if (!empty($row['platforms'])) {
            $decoded   = json_decode((string) $row['platforms'], true);
            $platforms = is_array($decoded) ? array_values(array_map('strval', $decoded)) : [];
        }

        return [
            'id'         => (int) $row['id'],
            'idea'       => $row['idea'],
            'links'      => $row['links'] ?? null,
            'status'     => $row['status'] ?? 'pending',
            'platforms'  => $platforms,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
}
