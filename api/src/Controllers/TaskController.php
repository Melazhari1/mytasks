<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\Database;
use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\Category;
use App\Models\Task;
use App\Support\Validator;

final class TaskController
{
    public function index(Request $request): void
    {
        $result = Task::search($request->userId(), [
            'date'        => $request->query('date'),
            'priority'    => $this->enumQuery($request, 'priority', ['low', 'medium', 'high']),
            'status'      => $this->enumQuery($request, 'status', ['pending', 'completed']),
            'category_id' => $request->query('category_id'),
            'search'      => $request->query('search'),
            'sort'        => $request->query('sort', 'due_date'),
            'dir'         => $request->query('dir', 'asc'),
            'page'        => $request->query('page', '1'),
            'per_page'    => $request->query('per_page', '50'),
        ]);

        Response::json(['data' => $result['items'], 'meta' => $result['meta']]);
    }

    public function show(Request $request): void
    {
        $task = Task::findForUser($request->intParam('id'), $request->userId());

        if ($task === null) {
            throw HttpException::notFound('Task not found.');
        }

        Response::ok(Task::present($task));
    }

    public function store(Request $request): void
    {
        $userId = $request->userId();

        $data = Validator::check($request->all(), [
            'category_id'           => 'required|int|min:1',
            'title'                 => 'required|string|min:1|max:255',
            'description'           => 'nullable|string|max:5000',
            'priority'              => 'nullable|string|in:low,medium,high',
            'is_recurring'          => 'nullable|bool',
            'recurring_type'        => 'nullable|string|in:daily,weekly',
            'due_date'              => 'nullable|date',
            'due_time'              => 'nullable|string|max:8',
            'due_at'                => 'nullable|datetime',
            'notify_before_minutes' => 'nullable|int|min:0|max:43200',
            'status'                => 'nullable|string|in:pending,completed',
        ]);

        if (!Category::existsForUser((int) $data['category_id'], $userId)) {
            throw HttpException::validation(['category_id' => ['That category does not exist or is not yours.']]);
        }

        $data['due_date'] = $this->resolveDueAt($data);

        if (!empty($data['is_recurring']) && empty($data['recurring_type'])) {
            $data['recurring_type'] = 'daily';
        }

        if (!empty($data['is_recurring']) && $data['due_date'] === null) {
            throw HttpException::validation(['due_date' => ['A recurring task needs a due date to repeat from.']]);
        }

        if (isset($data['notify_before_minutes']) && $data['notify_before_minutes'] !== null && $data['due_date'] === null) {
            throw HttpException::validation(['notify_before_minutes' => ['A reminder needs a due date to count back from.']]);
        }

        $id = Task::create($userId, $data);

        Response::created(Task::present(Task::findForUser($id, $userId) ?? []));
    }

    public function update(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        $task = Task::findForUser($id, $userId);

        if ($task === null) {
            throw HttpException::notFound('Task not found.');
        }

        $data = Validator::check($request->all(), [
            'category_id'           => 'nullable|int|min:1',
            'title'                 => 'nullable|string|min:1|max:255',
            'description'           => 'nullable|string|max:5000',
            'priority'              => 'nullable|string|in:low,medium,high',
            'is_recurring'          => 'nullable|bool',
            'recurring_type'        => 'nullable|string|in:daily,weekly',
            'due_date'              => 'nullable|date',
            'due_time'              => 'nullable|string|max:8',
            'due_at'                => 'nullable|datetime',
            'notify_before_minutes' => 'nullable|int|min:0|max:43200',
            'status'                => 'nullable|string|in:pending,completed',
        ]);

        if (isset($data['category_id']) && !Category::existsForUser((int) $data['category_id'], $userId)) {
            throw HttpException::validation(['category_id' => ['That category does not exist or is not yours.']]);
        }

        // Only touch due_date if the client actually sent something about timing.
        if ($request->has('due_at') || $request->has('due_date') || $request->has('due_time')) {
            $data['due_date'] = $this->resolveDueAt($data, (string) ($task['due_date'] ?? ''));
        } else {
            unset($data['due_date']);
        }

        unset($data['due_time'], $data['due_at']);

        // Completing a recurring task rolls it forward rather than closing it.
        if (($data['status'] ?? null) === 'completed' && (bool) $task['is_recurring']) {
            unset($data['status']);

            Database::transaction(static function () use ($id, $userId, $data, $task): void {
                Task::update($id, $userId, $data);
                Task::rollRecurrence(Task::findForUser($id, $userId) ?? $task);
            });

            $fresh = Task::findForUser($id, $userId);

            Response::json([
                'data'    => Task::present($fresh ?? []),
                'message' => 'Recurring task completed — the next occurrence has been scheduled.',
            ]);
        }

        Task::update($id, $userId, $data);

        Response::ok(Task::present(Task::findForUser($id, $userId) ?? []));
    }

    /** Convenience endpoint the mobile client uses for a checkbox tap. */
    public function toggle(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        $task = Task::findForUser($id, $userId);

        if ($task === null) {
            throw HttpException::notFound('Task not found.');
        }

        $newStatus = $task['status'] === 'completed' ? 'pending' : 'completed';

        if ($newStatus === 'completed' && (bool) $task['is_recurring']) {
            $nextDue = Task::rollRecurrence($task);

            Response::json([
                'data'    => Task::present(Task::findForUser($id, $userId) ?? []),
                'message' => $nextDue !== null
                    ? 'Done for now — next occurrence scheduled.'
                    : 'Task completed.',
            ]);
        }

        Task::update($id, $userId, ['status' => $newStatus]);

        Response::ok(Task::present(Task::findForUser($id, $userId) ?? []));
    }

    public function destroy(Request $request): void
    {
        if (Task::delete($request->intParam('id'), $request->userId()) === 0) {
            throw HttpException::notFound('Task not found.');
        }

        Response::noContent();
    }

    /** Reminders that are ready to fire — for a push-notification worker. */
    public function reminders(Request $request): void
    {
        $rows = Task::dueReminders(200, $request->userId());

        Response::ok(array_map([Task::class, 'present'], $rows));
    }

    /** Counts for the dashboard header. */
    public function summary(Request $request): void
    {
        $userId = $request->userId();

        // NOTE: `high_priority` is a reserved word in MySQL/MariaDB — the alias
        // must be back-quoted or the statement fails to parse.
        $row = Database::first(
            "SELECT
                COUNT(*)                                                        AS `total`,
                SUM(status = 'pending')                                         AS `pending`,
                SUM(status = 'completed')                                       AS `completed`,
                SUM(status = 'pending' AND DATE(due_date) = CURDATE())          AS `due_today`,
                SUM(status = 'pending' AND due_date < NOW())                    AS `overdue`,
                SUM(status = 'pending' AND priority = 'high')                   AS `high_priority`
               FROM tasks WHERE user_id = ?",
            [$userId]
        ) ?? [];

        Response::ok([
            'total'         => (int) ($row['total'] ?? 0),
            'pending'       => (int) ($row['pending'] ?? 0),
            'completed'     => (int) ($row['completed'] ?? 0),
            'due_today'     => (int) ($row['due_today'] ?? 0),
            'overdue'       => (int) ($row['overdue'] ?? 0),
            'high_priority' => (int) ($row['high_priority'] ?? 0),
        ]);
    }

    /**
     * The spec separates due_date and due_time; the column is a single DATETIME.
     * Accepts either `due_at` (full datetime) or `due_date` [+ `due_time`].
     *
     * @param array<string,mixed> $data
     */
    private function resolveDueAt(array $data, string $fallback = ''): ?string
    {
        if (!empty($data['due_at'])) {
            return (string) $data['due_at'];
        }

        $date = $data['due_date'] ?? null;
        $time = $data['due_time'] ?? null;

        if ($date === null && $time !== null && $fallback !== '') {
            $date = substr($fallback, 0, 10);
        }

        if ($date === null || $date === '') {
            return null;
        }

        $time = is_string($time) && $time !== '' ? $time : '00:00';

        if (preg_match('/^\d{1,2}:\d{2}(:\d{2})?$/', $time) !== 1) {
            throw HttpException::validation(['due_time' => ['The due time must look like HH:MM.']]);
        }

        $normalized = Validator::normalizeDateTime($date . ' ' . $time);

        if ($normalized === null) {
            throw HttpException::validation(['due_date' => ['Could not read that date and time.']]);
        }

        return $normalized;
    }

    /** @param list<string> $allowed */
    private function enumQuery(Request $request, string $key, array $allowed): ?string
    {
        $value = $request->query($key);

        if ($value === null) {
            return null;
        }

        if (!in_array($value, $allowed, true)) {
            throw HttpException::badRequest("Invalid '{$key}'. Allowed values: " . implode(', ', $allowed) . '.');
        }

        return $value;
    }
}
