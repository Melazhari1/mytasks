<?php

/**
 * End-to-end smoke test over real HTTP.
 *
 *   php tools/smoketest.php
 *   php tools/smoketest.php --url=http://localhost/xxp/mytasks/api
 *
 * selftest.php proves the crypto primitives in isolation. This proves the
 * thing the whole security model actually rests on: that one account cannot
 * reach another's rows, even holding a valid token and the right id.
 *
 * It creates two throwaway accounts, has A create a goal and a task, then has
 * B request them by id and asserts a 404 every time. It also walks the happy
 * path (register -> login -> 2FA -> CRUD) so a broken route shows up here
 * rather than in the browser.
 *
 * Requires TWO_FACTOR_REQUIRED=false, or MAIL_DRIVER=log so the codes can be
 * read back out of storage/logs/mail.log. Leaves both accounts behind unless
 * --cleanup is passed.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script may only be run from the command line.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Database;
use App\Core\Env;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');

$options = getopt('', ['url::', 'cleanup']);
$baseUrl = rtrim((string) ($options['url'] ?? Env::get('APP_URL', 'http://localhost/xxp/mytasks/api')), '/');
$cleanup = array_key_exists('cleanup', $options);

$passed = 0;
$failed = 0;

/** @var list<string> $createdEmails */
$createdEmails = [];

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

function ok(string $label): void
{
    global $passed;
    $passed++;
    echo "  [ok]   {$label}\n";
}

function bad(string $label, string $detail = ''): void
{
    global $failed;
    $failed++;
    echo "  [FAIL] {$label}" . ($detail !== '' ? "  --  {$detail}" : '') . "\n";
}

function assertStatus(int $expected, array $response, string $label): bool
{
    if ($response['status'] === $expected) {
        ok($label);

        return true;
    }

    bad($label, "expected {$expected}, got {$response['status']}: " . substr(json_encode($response['body']) ?: '', 0, 160));

    return false;
}

/**
 * @param array<string,mixed>|null $body
 * @return array{status:int, body:mixed}
 */
function call(string $method, string $path, ?array $body = null, ?string $token = null): array
{
    global $baseUrl;

    $headers = ['Accept: application/json'];

    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    $ch = curl_init($baseUrl . $path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_POSTFIELDS     => $body !== null ? json_encode($body, JSON_THROW_ON_ERROR) : null,
    ]);

    $raw    = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error  = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        echo "\n  Could not reach {$baseUrl}{$path} -- {$error}\n";
        echo "  Is Apache running, and is --url correct?\n\n";
        exit(1);
    }

    return ['status' => $status, 'body' => json_decode((string) $raw, true)];
}

/** Reads the newest 6-digit code out of the mail log (MAIL_DRIVER=log). */
function latestMailCode(): ?string
{
    $log = API_ROOT . '/storage/logs/mail.log';

    if (!is_file($log)) {
        return null;
    }

    $contents = (string) file_get_contents($log);

    if (preg_match_all('/\b(\d{6})\b/', $contents, $matches) !== false && $matches[1] !== []) {
        return (string) end($matches[1]);
    }

    return null;
}

/** Registers an account and returns its access token. */
function signUp(string $label): array
{
    global $createdEmails;

    $email    = 'smoke-' . bin2hex(random_bytes(5)) . '@mytasks.test';
    $password = 'Sm0ke!' . bin2hex(random_bytes(4));

    $created = call('POST', '/auth/register', ['name' => $label, 'email' => $email, 'password' => $password]);

    if ($created['status'] !== 201 && $created['status'] !== 200) {
        bad("register {$label}", 'status ' . $created['status'] . ': ' . substr(json_encode($created['body']) ?: '', 0, 200));
        exit(1);
    }

    $createdEmails[] = $email;
    ok("register {$label}");

    $login = call('POST', '/auth/login', ['email' => $email, 'password' => $password]);

    if ($login['status'] !== 200) {
        bad("login {$label}", 'status ' . $login['status']);
        exit(1);
    }

    $payload = $login['body']['data'] ?? $login['body'];

    // 2FA off entirely -> tokens come straight back.
    if (isset($payload['access_token'])) {
        ok("login {$label} (no 2FA)");

        return ['email' => $email, 'token' => (string) $payload['access_token']];
    }

    $challenge = (string) ($payload['challenge_token'] ?? '');
    $code      = latestMailCode();

    if ($challenge === '' || $code === null) {
        bad("login {$label}", '2FA required but no code readable. Set MAIL_DRIVER=log or TWO_FACTOR_REQUIRED=false.');
        exit(1);
    }

    $verified = call('POST', '/auth/verify-2fa', ['challenge_token' => $challenge, 'code' => $code]);

    if ($verified['status'] !== 200) {
        bad("verify-2fa {$label}", 'status ' . $verified['status']);
        exit(1);
    }

    ok("login {$label} (2FA)");
    $data = $verified['body']['data'] ?? $verified['body'];

    return ['email' => $email, 'token' => (string) $data['access_token']];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

echo "\nMyTasks smoke test -- {$baseUrl}\n";
echo str_repeat('=', 62) . "\n\n";

echo "Health\n";
assertStatus(200, call('GET', '/health'), 'GET /health is 200');

echo "\nAccount A\n";
$alice = signUp('Smoke A');

echo "\nHappy path (A)\n";
$goal = call('POST', '/categories', ['name' => 'Smoke goal ' . bin2hex(random_bytes(3)), 'color' => '#4F46E5'], $alice['token']);
assertStatus(201, $goal, 'A creates a goal');
$goalId = (int) (($goal['body']['data'] ?? [])['id'] ?? 0);

$task = call('POST', '/tasks', [
    'category_id' => $goalId,
    'title'       => 'Smoke task',
    'priority'    => 'high',
    'due_date'    => date('Y-m-d', strtotime('+1 day')),
    'due_time'    => '09:00',
], $alice['token']);
assertStatus(201, $task, 'A creates a task');
$taskId = (int) (($task['body']['data'] ?? [])['id'] ?? 0);

$fetched = call('GET', "/tasks/{$taskId}", null, $alice['token']);
assertStatus(200, $fetched, 'A reads its own task');

$shape = ($fetched['body']['data'] ?? []);
if (isset($shape['due_date'], $shape['due_time'], $shape['due_at'], $shape['is_overdue'])) {
    ok('task carries due_date / due_time / due_at / is_overdue');
} else {
    bad('task representation', 'missing one of due_date, due_time, due_at, is_overdue');
}

assertStatus(200, call('GET', '/tasks/summary', null, $alice['token']), 'A reads the dashboard summary');
assertStatus(200, call('GET', '/tasks/reminders', null, $alice['token']), 'A reads its reminders');

echo "\nValidation\n";
assertStatus(422, call('POST', '/categories', ['name' => ''], $alice['token']), 'empty goal name is 422');
assertStatus(409, call('POST', '/categories', ['name' => ($goal['body']['data'] ?? [])['name'] ?? 'x'], $alice['token']), 'duplicate goal name is 409');
assertStatus(400, call('GET', '/tasks?priority=urgent', null, $alice['token']), 'unknown priority filter is 400');

echo "\nAuth guards\n";
assertStatus(401, call('GET', '/tasks'), 'no token is 401');
assertStatus(401, call('GET', '/tasks', null, 'not.a.real.token'), 'garbage token is 401');
assertStatus(403, call('POST', "/vault/{$taskId}/reveal", [], $alice['token']), 'reveal without X-Vault-Token is 403');

echo "\nAccount B\n";
$bob = signUp('Smoke B');

echo "\nOwnership -- the invariant everything rests on\n";
assertStatus(404, call('GET', "/tasks/{$taskId}", null, $bob['token']), "B cannot read A's task");
assertStatus(404, call('PUT', "/tasks/{$taskId}", ['title' => 'hijacked'], $bob['token']), "B cannot update A's task");
assertStatus(404, call('POST', "/tasks/{$taskId}/toggle", [], $bob['token']), "B cannot toggle A's task");
assertStatus(404, call('DELETE', "/tasks/{$taskId}", null, $bob['token']), "B cannot delete A's task");
assertStatus(404, call('GET', "/categories/{$goalId}", null, $bob['token']), "B cannot read A's goal");
assertStatus(404, call('PUT', "/categories/{$goalId}", ['name' => 'hijacked'], $bob['token']), "B cannot update A's goal");
assertStatus(404, call('DELETE', "/categories/{$goalId}", null, $bob['token']), "B cannot delete A's goal");

$bobList = call('GET', '/tasks', null, $bob['token']);
$bobRows = $bobList['body']['data'] ?? [];
if (is_array($bobRows) && $bobRows === []) {
    ok("B's task list does not include A's task");
} else {
    bad("B's task list", 'expected an empty list, got ' . count((array) $bobRows) . ' row(s)');
}

// A's task must still be intact after all of that.
assertStatus(200, call('GET', "/tasks/{$taskId}", null, $alice['token']), "A's task survived B's attempts");

echo "\nCleanup\n";
if ($cleanup) {
    $deleted = 0;

    foreach ($createdEmails as $email) {
        $deleted += Database::affected('DELETE FROM users WHERE email = ?', [$email]);
    }

    ok("removed {$deleted} test account(s) -- their rows cascaded");
} else {
    echo "  [--]   kept " . count($createdEmails) . " test account(s); pass --cleanup to remove them\n";

    foreach ($createdEmails as $email) {
        echo "         {$email}\n";
    }
}

echo "\n" . str_repeat('=', 62) . "\n";
printf("%d passed, %d failed\n\n", $passed, $failed);

exit($failed === 0 ? 0 : 1);
