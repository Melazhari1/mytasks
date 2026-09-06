<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Deliberately tiny mail layer.
 *
 * MAIL_DRIVER=smtp -> a real mail server over SMTP (see Smtp). Production.
 * MAIL_DRIVER=mail -> PHP's built-in mail(). Needs a working local MTA;
 *                     WAMP almost never has one.
 * MAIL_DRIVER=log  -> appends to storage/logs/mail.log. The development
 *                     default: while you are building, you want to *read* the
 *                     code, not receive it.
 *
 * An unrecognised driver is an error, not a silent fallback to the log file.
 * Falling back would mean a typo in .env quietly stops every sign-in code from
 * being sent while the API keeps answering "a code has been sent to your
 * email" — the failure would only surface as users unable to log in.
 */
final class Mailer
{
    private static string $lastError = '';

    /** @var list<string> */
    private static array $lastTranscript = [];

    /** Why the last send() failed. Empty when it succeeded. */
    public static function lastError(): string
    {
        return self::$lastError;
    }

    /**
     * The SMTP conversation from the last send, for tools/mailtest.php.
     * Empty for the log and mail drivers, which have no exchange to show.
     *
     * @return list<string>
     */
    public static function lastTranscript(): array
    {
        return self::$lastTranscript;
    }

    public static function send(string $to, string $subject, string $body, ?string $htmlBody = null): bool
    {
        self::$lastError      = '';
        self::$lastTranscript = [];

        $driver = strtolower(trim((string) Env::get('MAIL_DRIVER', 'log')));
        $from   = (string) Env::get('MAIL_FROM_ADDRESS', 'no-reply@mytasks.local');
        $name   = (string) Env::get('MAIL_FROM_NAME', 'MyTasks');

        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
            self::$lastError = 'Refusing to send to an invalid address.';
            error_log('[mail] ' . self::$lastError);

            return false;
        }

        return match ($driver) {
            'smtp'  => self::viaSmtp($to, $from, $name, $subject, $body, $htmlBody),
            'mail'  => self::viaMailFunction($to, $from, $name, $subject, $body),
            'log'   => self::log($to, $subject, $body),
            default => self::unknownDriver($driver),
        };
    }

    public static function sendOtp(string $to, string $code, int $ttlSeconds): bool
    {
        $minutes = max(1, (int) round($ttlSeconds / 60));

        $text = <<<TXT
        Your MyTasks verification code is: {$code}

        It expires in {$minutes} minute(s).

        If you did not try to sign in, change your password immediately —
        someone else knows it.
        TXT;

        return self::send($to, 'Your MyTasks verification code', $text, self::otpHtml($code, $minutes));
    }

    /**
     * The HTML half of the code email.
     *
     * Inline styles and a table, because that is what mail clients render
     * predictably — Gmail strips <style> blocks, Outlook ignores most modern
     * CSS. The plain-text part above is the real fallback, and it carries the
     * same code, so a client that refuses HTML entirely loses nothing.
     */
    private static function otpHtml(string $code, int $minutes): string
    {
        $safeCode = htmlspecialchars($code, ENT_QUOTES, 'UTF-8');
        $appName  = htmlspecialchars((string) Env::get('APP_NAME', 'MyTasks'), ENT_QUOTES, 'UTF-8');

        return <<<HTML
        <!doctype html>
        <html lang="en">
        <body style="margin:0;padding:24px;background:#f4f3f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171320;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:460px;margin:0 auto;background:#ffffff;border:1px solid #e2dfec;border-radius:10px;">
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6d4fe0;font-weight:700;">{$appName}</p>
                <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:600;color:#171320;">Your verification code</h1>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#3e3850;">Enter this code to finish signing in.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px;">
                <div style="background:#f4f3f8;border:1px solid #e2dfec;border-radius:8px;padding:18px;text-align:center;font-family:Consolas,Menlo,monospace;font-size:32px;letter-spacing:.28em;font-weight:600;color:#171320;">{$safeCode}</div>
                <p style="margin:12px 0 0;font-size:13px;color:#6d6683;text-align:center;">Expires in {$minutes} minute(s).</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px 28px;">
                <p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #e2dfec;font-size:13px;line-height:1.6;color:#6d6683;">
                  If you did not try to sign in, <strong style="color:#bf3050;">change your password immediately</strong> — someone else knows it.
                </p>
              </td>
            </tr>
          </table>
        </body>
        </html>
        HTML;
    }

    // -----------------------------------------------------------------------

    private static function viaSmtp(
        string $to,
        string $from,
        string $name,
        string $subject,
        string $body,
        ?string $htmlBody,
    ): bool {
        $smtp = new Smtp();
        $sent = $smtp->send($to, [$from, $name], $subject, $body, $htmlBody);

        self::$lastTranscript = $smtp->transcript();

        if ($sent) {
            return true;
        }

        self::$lastError = $smtp->lastError();
        error_log('[mail] SMTP delivery to ' . $to . ' failed: ' . self::$lastError);

        return false;
    }

    private static function viaMailFunction(string $to, string $from, string $name, string $subject, string $body): bool
    {
        if (!function_exists('mail')) {
            self::$lastError = 'MAIL_DRIVER=mail but PHP\'s mail() is disabled on this server.';
            error_log('[mail] ' . self::$lastError);

            return false;
        }

        $headers = implode("\r\n", [
            "From: {$name} <{$from}>",
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
        ]);

        if (@mail($to, $subject, $body, $headers)) {
            return true;
        }

        self::$lastError = 'PHP mail() returned false — there is probably no local MTA configured.';
        error_log('[mail] ' . self::$lastError);

        return false;
    }

    private static function unknownDriver(string $driver): bool
    {
        self::$lastError = "Unknown MAIL_DRIVER '{$driver}'. Valid values are smtp, mail, log.";
        error_log('[mail] ' . self::$lastError);

        return false;
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

        if (file_put_contents($dir . '/mail.log', $entry . "\n", FILE_APPEND | LOCK_EX) !== false) {
            return true;
        }

        self::$lastError = 'Could not write to storage/logs/mail.log.';

        return false;
    }
}
