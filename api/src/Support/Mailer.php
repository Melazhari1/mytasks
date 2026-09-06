<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Deliberately tiny mail layer.
 *
 * MAIL_DRIVER=log  -> appends to storage/logs/mail.log (the default; WAMP
 *                     rarely has a working sendmail, and during development
 *                     you want to read the OTP, not receive it)
 * MAIL_DRIVER=mail -> PHP's built-in mail()
 *
 * For production, drop in PHPMailer/SMTP inside send() — nothing else changes.
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $body): bool
    {
        $driver = strtolower((string) Env::get('MAIL_DRIVER', 'log'));
        $from   = Env::get('MAIL_FROM_ADDRESS', 'no-reply@mytasks.local');
        $name   = Env::get('MAIL_FROM_NAME', 'MyTasks');

        if ($driver === 'mail') {
            $headers = implode("\r\n", [
                "From: {$name} <{$from}>",
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=UTF-8',
            ]);

            return @mail($to, $subject, $body, $headers);
        }

        return self::log($to, $subject, $body);
    }

    public static function sendOtp(string $to, string $code, int $ttlSeconds): bool
    {
        $minutes = max(1, (int) round($ttlSeconds / 60));

        $body = <<<TXT
        Your MyTasks verification code is: {$code}

        It expires in {$minutes} minute(s). If you did not try to sign in,
        change your password immediately — someone else knows it.
        TXT;

        return self::send($to, 'Your MyTasks verification code', $body);
    }

    private static function log(string $to, string $subject, string $body): bool
    {
        $dir = API_ROOT . '/storage/logs';

        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }

        $entry = sprintf(
            "[%s] To: %s\nSubject: %s\n%s\n%s\n",
            date('Y-m-d H:i:s'),
            $to,
            $subject,
            str_repeat('-', 60),
            $body
        );

        return file_put_contents($dir . '/mail.log', $entry . "\n", FILE_APPEND | LOCK_EX) !== false;
    }
}
