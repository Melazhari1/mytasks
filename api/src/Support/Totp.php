<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * RFC 6238 TOTP / RFC 4226 HOTP, compatible with Google Authenticator,
 * Authy, 1Password and Microsoft Authenticator.
 */
final class Totp
{
    private const PERIOD  = 30;
    private const DIGITS  = 6;
    private const ALGO    = 'sha1'; // What authenticator apps actually implement.

    private const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** Generate a fresh base32 shared secret (160 bits). */
    public static function generateSecret(int $bytes = 20): string
    {
        return self::base32Encode(random_bytes($bytes));
    }

    /** Current code for a secret — mainly useful for tests and tooling. */
    public static function codeAt(string $base32Secret, ?int $timestamp = null, int $offsetSteps = 0): string
    {
        $counter = intdiv($timestamp ?? time(), self::PERIOD) + $offsetSteps;

        return self::hotp(self::base32Decode($base32Secret), $counter);
    }

    /**
     * Verify a submitted code, tolerating +/- $window 30-second steps of drift.
     */
    public static function verify(string $base32Secret, string $code, ?int $window = null): bool
    {
        $code = preg_replace('/\D/', '', $code) ?? '';

        if (strlen($code) !== self::DIGITS) {
            return false;
        }

        $window ??= Env::int('TOTP_WINDOW', 1);
        $key      = self::base32Decode($base32Secret);

        if ($key === '') {
            return false;
        }

        $counter = intdiv(time(), self::PERIOD);
        $valid   = false;

        // Loop the full window every time — bailing early on a match would
        // leak, through response time, how close the guess was.
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::hotp($key, $counter + $i), $code)) {
                $valid = true;
            }
        }

        return $valid;
    }

    /** otpauth:// URI for rendering an enrolment QR code on the client. */
    public static function provisioningUri(string $secret, string $accountEmail, ?string $issuer = null): string
    {
        $issuer ??= Env::get('TOTP_ISSUER', 'MyTasks');

        $label = rawurlencode($issuer) . ':' . rawurlencode($accountEmail);

        $query = http_build_query([
            'secret'    => $secret,
            'issuer'    => $issuer,
            'algorithm' => strtoupper(self::ALGO),
            'digits'    => self::DIGITS,
            'period'    => self::PERIOD,
        ]);

        return "otpauth://totp/{$label}?{$query}";
    }

    public static function secondsRemaining(): int
    {
        return self::PERIOD - (time() % self::PERIOD);
    }

    private static function hotp(string $key, int $counter): string
    {
        // 8-byte big-endian counter.
        $binCounter = pack('N*', 0, $counter);

        $hash = hash_hmac(self::ALGO, $binCounter, $key, true);

        // Dynamic truncation (RFC 4226 §5.3).
        $offset = ord($hash[strlen($hash) - 1]) & 0x0F;

        $binary = ((ord($hash[$offset]) & 0x7F) << 24)
            | ((ord($hash[$offset + 1]) & 0xFF) << 16)
            | ((ord($hash[$offset + 2]) & 0xFF) << 8)
            | (ord($hash[$offset + 3]) & 0xFF);

        return str_pad((string) ($binary % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    public static function base32Encode(string $binary): string
    {
        if ($binary === '') {
            return '';
        }

        $bits = '';

        foreach (str_split($binary) as $char) {
            $bits .= str_pad(decbin(ord($char)), 8, '0', STR_PAD_LEFT);
        }

        $output = '';

        foreach (str_split($bits, 5) as $chunk) {
            $chunk   = str_pad($chunk, 5, '0', STR_PAD_RIGHT);
            $output .= self::BASE32_ALPHABET[bindec($chunk)];
        }

        // Authenticator apps ignore padding, but emit it for spec compliance.
        $remainder = strlen($output) % 8;

        if ($remainder !== 0) {
            $output .= str_repeat('=', 8 - $remainder);
        }

        return $output;
    }

    public static function base32Decode(string $base32): string
    {
        $base32 = strtoupper(rtrim(trim($base32), '='));
        $base32 = preg_replace('/[^A-Z2-7]/', '', $base32) ?? '';

        if ($base32 === '') {
            return '';
        }

        $bits = '';

        foreach (str_split($base32) as $char) {
            $index = strpos(self::BASE32_ALPHABET, $char);

            if ($index === false) {
                return '';
            }

            $bits .= str_pad(decbin($index), 5, '0', STR_PAD_LEFT);
        }

        $output = '';

        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $output .= chr(bindec($byte));
            }
        }

        return $output;
    }
}
