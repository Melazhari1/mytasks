<?php

/**
 * Send a real verification code to a real inbox.
 *
 *   php tools/mailtest.php you@example.com
 *   php tools/mailtest.php you@example.com --verbose   show the SMTP conversation
 *
 * Two-factor is only as good as the delivery behind it, and the delivery is
 * the one piece that cannot be proven without leaving the machine. This sends
 * the same message /auth/login sends, through the same code path, so a
 * success here means sign-in codes will arrive.
 *
 * --verbose prints every line of the SMTP exchange (credentials withheld),
 * which is the fastest way to see what a server is actually objecting to.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script may only be run from the command line.\n");
}

define('API_ROOT', dirname(__DIR__));

require API_ROOT . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Env;
use App\Support\Mailer;

Autoloader::register(API_ROOT . '/src', 'App\\');
Env::load(API_ROOT . '/.env');
date_default_timezone_set((string) Env::get('APP_TIMEZONE', 'UTC'));

$arguments = array_values(array_filter(
    array_slice($argv, 1),
    static fn (string $a): bool => !str_starts_with($a, '--')
));

$verbose = in_array('--verbose', $argv, true);
$to      = $arguments[0] ?? '';

if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
    echo "\nUsage: php tools/mailtest.php you@example.com [--verbose]\n\n";
    exit(1);
}

$driver = strtolower(trim((string) Env::get('MAIL_DRIVER', 'log')));

echo "\nMail delivery test\n";
echo str_repeat('=', 58) . "\n";
echo '  driver      : ' . $driver . "\n";

if ($driver === 'smtp') {
    $encryption = strtolower((string) Env::get('MAIL_ENCRYPTION', 'tls'));
    $port       = Env::int('MAIL_PORT', $encryption === 'ssl' ? 465 : 587);

    echo '  host        : ' . Env::get('MAIL_HOST', '(not set)') . ':' . $port . "\n";
    echo '  encryption  : ' . $encryption . "\n";
    echo '  username    : ' . (((string) Env::get('MAIL_USERNAME', '')) !== '' ? Env::get('MAIL_USERNAME') : '(none — relaying by IP)') . "\n";
} elseif ($driver === 'log') {
    echo "\n  MAIL_DRIVER=log — nothing will be sent.\n";
    echo "  The message is appended to storage/logs/mail.log instead.\n";
    echo "  Set MAIL_DRIVER=smtp with MAIL_HOST/MAIL_USERNAME/MAIL_PASSWORD\n";
    echo "  to actually deliver sign-in codes.\n";
}

echo '  from        : ' . Env::get('MAIL_FROM_NAME', 'MyTasks') . ' <' . Env::get('MAIL_FROM_ADDRESS', 'no-reply@mytasks.local') . ">\n";
echo '  to          : ' . $to . "\n";
echo str_repeat('=', 58) . "\n\n";

// A real six-digit code, formatted exactly like the one a sign-in sends, so
// what lands in the inbox is what a user would actually receive.
$code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
$ttl  = Env::int('OTP_TTL', 300);

echo "Sending code {$code} ...\n\n";

$start = microtime(true);

// Always the real path -- Mailer::sendOtp is exactly what /auth/login calls,
// so a pass here means sign-in codes will arrive.
$sent  = Mailer::sendOtp($to, $code, $ttl);
$error = Mailer::lastError();

if ($verbose) {
    $transcript = Mailer::lastTranscript();

    if ($transcript === []) {
        echo "  (no SMTP conversation -- the {$driver} driver does not have one)\n\n";
    } else {
        foreach ($transcript as $line) {
            echo '  ' . $line . "\n";
        }

        echo "\n";
    }
}

$elapsed = round((microtime(true) - $start) * 1000);

if ($sent) {
    echo "  \033[32mSent\033[0m in {$elapsed}ms.\n\n";

    if ($driver === 'log') {
        echo "  Read it at: storage/logs/mail.log\n\n";
    } else {
        echo "  Check the inbox for {$to}. If it is not there within a minute,\n";
        echo "  look in spam — a From address on a domain without SPF/DKIM is\n";
        echo "  the usual reason a transactional mail gets filtered.\n\n";
    }

    exit(0);
}

echo "  \033[31mFailed\033[0m after {$elapsed}ms.\n\n";
echo '  ' . ($error !== '' ? $error : 'No error reported.') . "\n\n";

echo "  Common causes:\n";
echo "    - Wrong port/encryption pair. Use 587 with tls, or 465 with ssl.\n";
echo "    - Gmail and Outlook reject account passwords here; create an app\n";
echo "      password and put that in MAIL_PASSWORD.\n";
echo "    - The openssl extension is missing, so TLS cannot be negotiated.\n";
echo "    - Outbound port 587/465 is blocked — common on shared hosting,\n";
echo "      which usually wants MAIL_HOST=localhost instead.\n";
echo "    - MAIL_FROM_ADDRESS is on a domain the server is not allowed to\n";
echo "      send as. Many providers require it to match MAIL_USERNAME.\n\n";

if (!$verbose && $driver === 'smtp') {
    echo "  Re-run with --verbose to see the SMTP conversation.\n\n";
}

exit(1);
