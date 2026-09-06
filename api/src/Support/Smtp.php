<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * A small SMTP client, written against raw sockets.
 *
 * Same reasoning as Jwt, Totp and Crypto: this project has no Composer and no
 * vendor folder, so the one thing standing between a user and their sign-in
 * code is not going to be a dependency. It speaks enough of RFC 5321 to hand a
 * message to a real mail server:
 *
 *   - implicit TLS (port 465) and STARTTLS (port 587)
 *   - AUTH LOGIN and AUTH PLAIN, whichever the server advertises
 *   - multiline replies, dot-stuffing, CRLF line endings
 *   - UTF-8 subjects via MIME encoded-words
 *
 * It does not do connection pooling, DSN, pipelining or attachments. This app
 * sends two kinds of mail — a six-digit code and a task reminder — and neither
 * needs any of that.
 *
 * Every failure is captured in lastError() rather than thrown, because the
 * callers care about one thing: did the code reach the user or not.
 */
final class Smtp
{
    private const CRLF = "\r\n";

    /** @var resource|null */
    private $socket = null;

    private string $lastError = '';

    /** @var list<string> */
    private array $transcript = [];

    private string $host;
    private int $port;
    private string $encryption;
    private int $timeout;

    public function __construct(
        ?string $host = null,
        ?int $port = null,
        ?string $encryption = null,
        ?int $timeout = null,
    ) {
        $this->host       = $host ?? (string) Env::get('MAIL_HOST', '');
        $this->encryption = strtolower($encryption ?? (string) Env::get('MAIL_ENCRYPTION', 'tls'));
        $this->timeout    = $timeout ?? Env::int('MAIL_TIMEOUT', 15);

        // 465 is implicit TLS, 587 is STARTTLS, 25 is neither. Defaulting the
        // port from the encryption mode removes the single most common
        // misconfiguration: port 587 with ssl, or 465 with tls, both of which
        // hang until the timeout rather than failing cleanly.
        $this->port = $port ?? Env::int('MAIL_PORT', $this->encryption === 'ssl' ? 465 : 587);
    }

    public function lastError(): string
    {
        return $this->lastError;
    }

    /** @return list<string> The SMTP conversation, for tools/mailtest.php. */
    public function transcript(): array
    {
        return $this->transcript;
    }

    /**
     * Deliver one message.
     *
     * @param array{0:string,1:string} $from [address, display name]
     */
    public function send(string $to, array $from, string $subject, string $textBody, ?string $htmlBody = null): bool
    {
        $this->lastError  = '';
        $this->transcript = [];

        if ($this->host === '') {
            $this->lastError = 'MAIL_HOST is empty.';

            return false;
        }

        try {
            if (!$this->connect()) {
                return false;
            }

            $capabilities = $this->handshake();

            if ($capabilities === null) {
                return false;
            }

            if ($this->encryption === 'tls') {
                if (!$this->startTls($capabilities)) {
                    return false;
                }

                // Capabilities are re-advertised after the upgrade, and only
                // the post-STARTTLS set is trustworthy — AUTH offered on the
                // cleartext channel could have been injected.
                $capabilities = $this->handshake();

                if ($capabilities === null) {
                    return false;
                }
            }

            if (!$this->authenticate($capabilities)) {
                return false;
            }

            return $this->deliver($to, $from, $subject, $textBody, $htmlBody);
        } finally {
            $this->disconnect();
        }
    }

    // -----------------------------------------------------------------------

    private function connect(): bool
    {
        $transport = $this->encryption === 'ssl' ? 'ssl' : 'tcp';
        $context   = stream_context_create([
            'ssl' => [
                'verify_peer'       => true,
                'verify_peer_name'  => true,
                'allow_self_signed' => false,
            ],
        ]);

        $socket = @stream_socket_client(
            "{$transport}://{$this->host}:{$this->port}",
            $errorCode,
            $errorMessage,
            $this->timeout,
            STREAM_CLIENT_CONNECT,
            $context
        );

        if ($socket === false) {
            $this->lastError = "Could not connect to {$this->host}:{$this->port} -- {$errorMessage} ({$errorCode}).";

            return false;
        }

        $this->socket = $socket;
        stream_set_timeout($socket, $this->timeout);

        // The server greets first.
        return $this->expect(220);
    }

    private function disconnect(): void
    {
        if ($this->socket === null) {
            return;
        }

        // Best effort — the message is already accepted or already lost.
        @fwrite($this->socket, 'QUIT' . self::CRLF);
        @fclose($this->socket);
        $this->socket = null;
    }

    /**
     * EHLO, falling back to HELO for servers that predate ESMTP.
     *
     * @return array<string,true>|null Advertised capabilities, upper-cased.
     */
    private function handshake(): ?array
    {
        $clientName = (string) (parse_url((string) Env::get('APP_URL', ''), PHP_URL_HOST) ?: 'localhost');

        $this->write('EHLO ' . $clientName);
        $reply = $this->read();

        if (!str_starts_with($reply, '250')) {
            $this->write('HELO ' . $clientName);

            if (!$this->expect(250)) {
                return null;
            }

            return [];
        }

        $capabilities = [];

        foreach (explode(self::CRLF, trim($reply)) as $line) {
            // "250-STARTTLS" / "250 AUTH LOGIN PLAIN"
            $capability = strtoupper(trim(substr($line, 4)));

            if ($capability !== '') {
                $capabilities[$capability] = true;
            }
        }

        return $capabilities;
    }

    /** @param array<string,true> $capabilities */
    private function startTls(array $capabilities): bool
    {
        $offered = false;

        foreach (array_keys($capabilities) as $capability) {
            if (str_starts_with($capability, 'STARTTLS')) {
                $offered = true;
                break;
            }
        }

        if (!$offered) {
            $this->lastError = "The server did not offer STARTTLS. Use MAIL_ENCRYPTION=ssl on port 465, "
                . 'or MAIL_ENCRYPTION=none only on a server you control. Sending credentials in the clear is not an option.';

            return false;
        }

        $this->write('STARTTLS');

        if (!$this->expect(220)) {
            return false;
        }

        $method = STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;

        if (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT')) {
            $method |= STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
        }

        if (@stream_socket_enable_crypto($this->socket, true, $method) !== true) {
            $this->lastError = 'TLS negotiation failed. The certificate may not match MAIL_HOST.';

            return false;
        }

        $this->transcript[] = '*** TLS established ***';

        return true;
    }

    /** @param array<string,true> $capabilities */
    private function authenticate(array $capabilities): bool
    {
        $username = (string) Env::get('MAIL_USERNAME', '');
        $password = (string) Env::get('MAIL_PASSWORD', '');

        if ($username === '' && $password === '') {
            // A relay that authenticates by IP, or a local MTA.
            return true;
        }

        $mechanisms = '';

        foreach (array_keys($capabilities) as $capability) {
            if (str_starts_with($capability, 'AUTH')) {
                $mechanisms = $capability;
                break;
            }
        }

        if (str_contains($mechanisms, 'LOGIN')) {
            $this->write('AUTH LOGIN');

            if (!$this->expect(334)) {
                return false;
            }

            $this->write(base64_encode($username), redact: true);

            if (!$this->expect(334)) {
                return false;
            }

            $this->write(base64_encode($password), redact: true);

            return $this->expectAuth();
        }

        if ($mechanisms === '' || str_contains($mechanisms, 'PLAIN')) {
            $this->write('AUTH PLAIN ' . base64_encode("\0{$username}\0{$password}"), redact: true);

            return $this->expectAuth();
        }

        $this->lastError = "The server offers no authentication mechanism this client supports ({$mechanisms}). "
            . 'LOGIN and PLAIN are implemented.';

        return false;
    }

    private function expectAuth(): bool
    {
        if ($this->expect(235)) {
            return true;
        }

        // The generic "expected 235" is unhelpful for by far the most common
        // cause, so name it.
        $this->lastError .= ' Authentication was rejected -- check MAIL_USERNAME and MAIL_PASSWORD. '
            . 'Gmail and Outlook require an app password here, not your account password.';

        return false;
    }

    /** @param array{0:string,1:string} $from */
    private function deliver(string $to, array $from, string $subject, string $textBody, ?string $htmlBody): bool
    {
        [$fromAddress, $fromName] = $from;

        $this->write('MAIL FROM:<' . $fromAddress . '>');

        if (!$this->expect(250)) {
            return false;
        }

        $this->write('RCPT TO:<' . $to . '>');

        // 251 is "will forward", equally a success.
        if (!$this->expect(250, 251)) {
            return false;
        }

        $this->write('DATA');

        if (!$this->expect(354)) {
            return false;
        }

        $message = $this->buildMessage($to, $fromAddress, $fromName, $subject, $textBody, $htmlBody);

        // Dot-stuffing: a line consisting of a single dot ends DATA, so any
        // body line starting with one has to be doubled.
        $message = preg_replace('/^\./m', '..', $message) ?? $message;

        $this->writeRaw($message . self::CRLF . '.' . self::CRLF);
        $this->transcript[] = '>>> [message body, ' . strlen($message) . ' bytes]';

        return $this->expect(250);
    }

    private function buildMessage(
        string $to,
        string $fromAddress,
        string $fromName,
        string $subject,
        string $textBody,
        ?string $htmlBody,
    ): string {
        $boundary = 'mytasks-' . bin2hex(random_bytes(12));
        $domain   = substr(strrchr($fromAddress, '@') ?: '@localhost', 1);

        $headers = [
            'Date: ' . date('r'),
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $domain . '>',
            'From: ' . self::encodeHeaderName($fromName) . ' <' . $fromAddress . '>',
            'To: <' . $to . '>',
            'Subject: ' . self::encodeHeaderValue($subject),
            'MIME-Version: 1.0',
            // A verification code is transactional, never a mailing list.
            // Marking it stops well-behaved clients offering an unsubscribe UI
            // and helps it stay out of the Promotions tab.
            'Auto-Submitted: auto-generated',
            'X-Auto-Response-Suppress: All',
        ];

        if ($htmlBody === null) {
            $headers[] = 'Content-Type: text/plain; charset=UTF-8';
            $headers[] = 'Content-Transfer-Encoding: 8bit';

            return implode(self::CRLF, $headers) . self::CRLF . self::CRLF . self::normalize($textBody);
        }

        $headers[] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';

        $parts = [
            '--' . $boundary,
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            self::normalize($textBody),
            '',
            '--' . $boundary,
            'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            self::normalize($htmlBody),
            '',
            '--' . $boundary . '--',
        ];

        return implode(self::CRLF, $headers) . self::CRLF . self::CRLF . implode(self::CRLF, $parts);
    }

    /** Every line ending in a message must be CRLF, whatever the source used. */
    private static function normalize(string $body): string
    {
        return (string) preg_replace('/\r\n|\r|\n/', self::CRLF, $body);
    }

    /** RFC 2047 encoded-word, so a non-ASCII subject survives the header. */
    private static function encodeHeaderValue(string $value): string
    {
        $value = str_replace(["\r", "\n"], '', $value);

        if (preg_match('/[^\x20-\x7E]/', $value) !== 1) {
            return $value;
        }

        return '=?UTF-8?B?' . base64_encode($value) . '?=';
    }

    private static function encodeHeaderName(string $name): string
    {
        if (preg_match('/[^\x20-\x7E]/', $name) === 1) {
            return self::encodeHeaderValue($name);
        }

        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $name) . '"';
    }

    // -----------------------------------------------------------------------

    private function write(string $line, bool $redact = false): void
    {
        $this->transcript[] = '>>> ' . ($redact ? '[credentials withheld]' : $line);
        $this->writeRaw($line . self::CRLF);
    }

    private function writeRaw(string $data): void
    {
        if ($this->socket !== null) {
            @fwrite($this->socket, $data);
        }
    }

    /** Reads one complete reply, following "250-" continuation lines. */
    private function read(): string
    {
        if ($this->socket === null) {
            return '';
        }

        $reply = '';

        while (($line = @fgets($this->socket, 1024)) !== false) {
            $reply .= $line;

            // "250 text" ends the reply; "250-text" continues it.
            if (strlen($line) >= 4 && $line[3] === ' ') {
                break;
            }

            $meta = stream_get_meta_data($this->socket);

            if ($meta['timed_out'] ?? false) {
                break;
            }
        }

        if ($reply !== '') {
            $this->transcript[] = '<<< ' . trim($reply);
        }

        return $reply;
    }

    private function expect(int ...$codes): bool
    {
        $reply = $this->read();

        if ($reply === '') {
            $this->lastError = 'The server closed the connection or stopped responding'
                . " (waited {$this->timeout}s).";

            return false;
        }

        $code = (int) substr($reply, 0, 3);

        if (in_array($code, $codes, true)) {
            return true;
        }

        $this->lastError = 'Expected ' . implode('/', $codes) . ', got: ' . trim($reply);

        return false;
    }
}
