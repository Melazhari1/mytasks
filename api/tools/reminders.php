<?php

/**
 * Reminder worker. Finds tasks whose `notify_before_minutes` window has opened
 * and dispatches a notification, then marks them notified so they only fire once.
 *
 * Run it from the Windows Task Scheduler every minute:
 *   C:\wamp64\bin\php\php8.x.x\php.exe C:\wamp64\www\xxp\mytasks\api\tools\reminders.php
 *
 * Or on Linux, crontab:
 *   * * * * * php /var/www/mytasks/api/tools/reminders.php >> /var/log/mytasks-reminders.log
 *
 * Replace the notify() body with your push provider (FCM / APNs / WebPush).
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("CLI only.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Env;
use App\Models\OtpCode;
use App\Models\RefreshToken;
use App\Models\Task;
use App\Support\Audit;
use App\Support\Mailer;
use App\Support\RateLimiter;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');
date_default_timezone_set(Env::get('APP_TIMEZONE', 'UTC'));

$sent = 0;

foreach (Task::dueReminders(200) as $task) {
    $due      = (string) $task['due_date'];
    $minutes  = (int) $task['notify_before_minutes'];
    $priority = strtoupper((string) $task['priority']);

    $subject = "Reminder: {$task['title']}";

    $body = <<<TXT
    {$task['title']}

    Category : {$task['category_name']}
    Priority : {$priority}
    Due      : {$due}  (in about {$minutes} minute(s))
    TXT;

    if (notify((string) $task['email'], $subject, $body)) {
        Task::markNotified((int) $task['id']);
        $sent++;
    }
}

// Opportunistic housekeeping. rate_limits and audit_logs are included because
// nothing in the request path ever deletes from them: clear() only fires on a
// successful login, and the audit trail is append-only by design.
$prunedTokens  = RefreshToken::pruneExpired();
$prunedCodes   = OtpCode::pruneExpired();
$prunedBuckets = RateLimiter::pruneStale();
$prunedAudit   = Audit::prune();

printf(
    "[%s] reminders sent: %d | pruned — refresh tokens: %d, OTPs: %d, rate buckets: %d, audit rows: %d\n",
    date('Y-m-d H:i:s'),
    $sent,
    $prunedTokens,
    $prunedCodes,
    $prunedBuckets,
    $prunedAudit
);

/**
 * Swap this out for FCM / APNs when the mobile client is wired up.
 */
function notify(string $email, string $subject, string $body): bool
{
    return Mailer::send($email, $subject, $body);
}
