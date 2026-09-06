<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;

final class Task
{
    /**
     * List tasks with filters. Every filter value is bound, never interpolated.
     *
     * Supported filters:
     *   date=today|tomorrow|week|overdue|YYYY-MM-DD
     *   priority=low|medium|high
     *   status=pending|completed
     *   category_id=<int>
     *   search=<string>
     *   sort=due_date|priority|created_at   dir=asc|desc
     *   page=<int>  per_page=<int>
     *
     * @param array<string,mixed> $filters
     * @return array{items:list<array<string,mixed>>,meta:array<string,int>}
     */
    public static function search(int $userId, array $filters): array
    {
        $where    = ['t.user_id = ?'];
        $bindings = [$userId];

        if (!empty($filters['status'])) {
            $where[]    = 't.status = ?';
            $bindings[] = $filters['status'];
        }

        if (!empty($filters['priority'])) {
            $where[]    = 't.priority = ?';
            $bindings[] = $filters['priority'];
        }

        if (!empty($filters['category_id'])) {
            $where[]    = 't.category_id = ?';
            $bindings[] = (int) $filters['category_id'];
        }

        if (!empty($filters['search'])) {
            $where[]    = '(t.title LIKE ? OR t.description LIKE ?)';
            $term       = '%' . str_replace(['%', '_'], ['\%', '\_'], (string) $filters['search']) . '%';
            $bindings[] = $term;
            $bindings[] = $term;
        }

        $date = $filters['date'] ?? null;

        if (is_string($date) && $date !== '') {
            switch ($date) {
                case 'today':
                    $where[] = 'DATE(t.due_date) = CURDATE()';
                    break;

                case 'tomorrow':
                    $where[] = 'DATE(t.due_date) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)';
                    break;

                case 'week':
                    $where[] = 't.due_date >= CURDATE() AND t.due_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)';
                    break;

                case 'month':
                    $where[] = 't.due_date >= CURDATE() AND t.due_date < DATE_ADD(CURDATE(), INTERVAL 1 MONTH)';
                    break;

                case 'overdue':
                    $where[] = "t.due_date < NOW() AND t.status = 'pending'";
                    break;

                case 'upcoming':
                    $where[] = "t.due_date >= NOW() AND t.status = 'pending'";
                    break;

                case 'none':
                    $where[] = 't.due_date IS NULL';
                    break;

                default:
                    // Explicit YYYY-MM-DD.
                    $where[]    = 'DATE(t.due_date) = ?';
                    $bindings[] = $date;
            }
        }

        $whereSql = implode(' AND ', $where);

        // Whitelisted sort columns — never take these from raw input.
        $sortMap = [
            'due_date'   => 't.due_date',
            'priority'   => "FIELD(t.priority, 'high', 'medium', 'low')",
            'created_at' => 't.created_at',
            'title'      => 't.title',
        ];

        $sortColumn = $sortMap[$filters['sort'] ?? 'due_date'] ?? $sortMap['due_date'];
        $direction  = strtolower((string) ($filters['dir'] ?? 'asc')) === 'desc' ? 'DESC' : 'ASC';

        $perPage = max(1, min(100, (int) ($filters['per_page'] ?? 50)));
        $page    = max(1, (int) ($filters['page'] ?? 1));
        $offset  = ($page - 1) * $perPage;

        $total = (int) (Database::first("SELECT COUNT(*) AS c FROM tasks t WHERE {$whereSql}", $bindings)['c'] ?? 0);

        $rows = Database::all(
            "SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
               FROM tasks t
               JOIN categories c ON c.id = t.category_id
              WHERE {$whereSql}
           ORDER BY t.due_date IS NULL, {$sortColumn} {$direction}, t.id DESC
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
        return Database::first(
            'SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
               FROM tasks t
               JOIN categories c ON c.id = t.category_id
              WHERE t.id = ? AND t.user_id = ?',
            [$id, $userId]
        );
    }

    /** @param array<string,mixed> $data */
    public static function create(int $userId, array $data): int
    {
        return Database::insert(
            'INSERT INTO tasks
                (user_id, category_id, title, description, priority,
                 is_recurring, recurring_type, due_date, notify_before_minutes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $userId,
                (int) $data['category_id'],
                $data['title'],
                $data['description'] ?? null,
                $data['priority'] ?? 'low',
                !empty($data['is_recurring']) ? 1 : 0,
                empty($data['is_recurring']) ? null : ($data['recurring_type'] ?? 'daily'),
                $data['due_date'] ?? null,
                $data['notify_before_minutes'] ?? null,
                $data['status'] ?? 'pending',
            ]
        );
    }

    /** @param array<string,mixed> $fields */
    public static function update(int $id, int $userId, array $fields): void
    {
        $allowed = [
            'category_id', 'title', 'description', 'priority',
            'is_recurring', 'recurring_type', 'due_date',
            'notify_before_minutes', 'status',
        ];

        $sets     = [];
        $bindings = [];

        foreach ($fields as $column => $value) {
            if (!in_array($column, $allowed, true)) {
                continue;
            }

            $sets[]     = "`{$column}` = ?";
            $bindings[] = is_bool($value) ? (int) $value : $value;
        }

        if (isset($fields['status'])) {
            $sets[] = $fields['status'] === 'completed' ? 'completed_at = NOW()' : 'completed_at = NULL';
        }

        if ($sets === []) {
            return;
        }

        $bindings[] = $id;
        $bindings[] = $userId;

        Database::run(
            'UPDATE tasks SET ' . implode(', ', $sets) . ' WHERE id = ? AND user_id = ?',
            $bindings
        );
    }

    public static function delete(int $id, int $userId): int
    {
        return Database::affected('DELETE FROM tasks WHERE id = ? AND user_id = ?', [$id, $userId]);
    }

    /**
     * Completing a recurring task rolls its due date forward instead of
     * leaving it done forever. Returns the new due date, or null for one-offs.
     *
     * @param array<string,mixed> $task
     */
    public static function rollRecurrence(array $task): ?string
    {
        if (empty($task['is_recurring']) || $task['due_date'] === null) {
            return null;
        }

        $interval = $task['recurring_type'] === 'weekly' ? '+1 week' : '+1 day';

        $next = (new \DateTimeImmutable((string) $task['due_date']))->modify($interval);
        $now  = new \DateTimeImmutable();

        // If the task is badly overdue, skip forward to the next future slot.
        while ($next < $now) {
            $next = $next->modify($interval);
        }

        $nextDue = $next->format('Y-m-d H:i:s');

        Database::run(
            "UPDATE tasks
                SET due_date = ?, status = 'pending', completed_at = NULL, notified_at = NULL
              WHERE id = ?",
            [$nextDue, (int) $task['id']]
        );

        return $nextDue;
    }

    /**
     * Tasks whose reminder window has opened and that haven't been notified.
     * Intended for a cron worker / push-notification job.
     *
     * @return list<array<string,mixed>>
     */
    public static function dueReminders(int $limit = 100, ?int $userId = null): array
    {
        // Scoped in SQL, not after the fetch. Filtering a global result set in
        // PHP meant another account's due tasks could consume the whole LIMIT
        // and silently empty this caller's list.
        $bindings = [];
        $scope    = '';

        if ($userId !== null) {
            $scope      = ' AND t.user_id = ?';
            $bindings[] = $userId;
        }

        // No upper bound on the window: `NOW() <= t.due_date` meant a reminder
        // whose window opened while the cron wasn't running was dropped
        // forever rather than fired late. `notified_at` is what guarantees it
        // only ever fires once.
        $rows = Database::all(
            "SELECT t.*, u.email, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
               FROM tasks t
               JOIN users u      ON u.id = t.user_id
               JOIN categories c ON c.id = t.category_id
              WHERE t.status = 'pending'
                AND t.due_date IS NOT NULL
                AND t.notify_before_minutes IS NOT NULL
                AND t.notified_at IS NULL
                AND NOW() >= DATE_SUB(t.due_date, INTERVAL t.notify_before_minutes MINUTE)
                {$scope}
           ORDER BY t.due_date ASC
              LIMIT " . max(1, min(500, $limit)),
            $bindings
        );

        return $rows;
    }

    public static function markNotified(int $id): void
    {
        Database::run('UPDATE tasks SET notified_at = NOW() WHERE id = ?', [$id]);
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function present(array $row): array
    {
        $dueDate = $row['due_date'] ?? null;

        $reminderAt = null;

        if ($dueDate !== null && $row['notify_before_minutes'] !== null) {
            $reminderAt = (new \DateTimeImmutable((string) $dueDate))
                ->modify('-' . (int) $row['notify_before_minutes'] . ' minutes')
                ->format('Y-m-d H:i:s');
        }

        return [
            'id'                    => (int) $row['id'],
            'title'                 => $row['title'],
            'description'           => $row['description'] ?? null,
            'priority'              => $row['priority'],
            'status'                => $row['status'],
            'is_recurring'          => (bool) $row['is_recurring'],
            'recurring_type'        => $row['recurring_type'],
            'due_date'              => $dueDate !== null ? substr((string) $dueDate, 0, 10) : null,
            'due_time'              => $dueDate !== null ? substr((string) $dueDate, 11, 5) : null,
            'due_at'                => $dueDate,
            'notify_before_minutes' => $row['notify_before_minutes'] !== null ? (int) $row['notify_before_minutes'] : null,
            'remind_at'             => $reminderAt,
            'is_overdue'            => $dueDate !== null
                && $row['status'] === 'pending'
                && strtotime((string) $dueDate) < time(),
            'completed_at'          => $row['completed_at'] ?? null,
            'category'              => [
                'id'    => (int) $row['category_id'],
                'name'  => $row['category_name'] ?? null,
                'icon'  => $row['category_icon'] ?? null,
                'color' => $row['category_color'] ?? null,
            ],
            'created_at'            => $row['created_at'] ?? null,
            'updated_at'            => $row['updated_at'] ?? null,
        ];
    }
}
