<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Symmetric encryption for data that must be recoverable in plain text —
 * vault passwords and TOTP secrets.
 *
 * Scheme: AES-256-CBC with a random 16-byte IV, then Encrypt-then-MAC using
 * HMAC-SHA256 over (iv || ciphertext). Raw CBC is malleable; the MAC is what
 * makes the ciphertext tamper-evident, so it is not optional.
 *
 * Stored format:  base64( iv[16] || mac[32] || ciphertext )
 *
 * Encryption and MAC keys are derived separately from APP_KEY via HKDF so the
 * same 32 bytes are never used for two different purposes.
 */
final class Crypto
{
    private const CIPHER  = 'aes-256-cbc';
    private const IV_LEN  = 16;
    private const MAC_LEN = 32;

    private static ?string $encryptionKey = null;
    private static ?string $macKey        = null;

    private static function keys(): void
    {
        if (self::$encryptionKey !== null) {
            return;
        }

        $raw = Env::get('APP_KEY');

        if ($raw === null) {
            throw new \RuntimeException('APP_KEY is not set. Run: php tools/keygen.php');
        }

        if (str_starts_with($raw, 'base64:')) {
            $decoded = base64_decode(substr($raw, 7), true);
        } else {
            $decoded = base64_decode($raw, true);
        }

        if ($decoded === false || strlen($decoded) !== 32) {
            throw new \RuntimeException('APP_KEY must be 32 bytes, base64 encoded (e.g. "base64:..."). Run: php tools/keygen.php');
        }

        self::$encryptionKey = hash_hkdf('sha256', $decoded, 32, 'mytasks:encryption');
        self::$macKey        = hash_hkdf('sha256', $decoded, 32, 'mytasks:mac');
    }

    public static function encrypt(string $plaintext): string
    {
        self::keys();

        $iv = random_bytes(self::IV_LEN);

        $ciphertext = openssl_encrypt($plaintext, self::CIPHER, self::$encryptionKey, OPENSSL_RAW_DATA, $iv);

        if ($ciphertext === false) {
            throw new \RuntimeException('Encryption failed.');
        }

        $mac = hash_hmac('sha256', $iv . $ciphertext, (string) self::$macKey, true);

        return base64_encode($iv . $mac . $ciphertext);
    }

    public static function decrypt(string $payload): string
    {
        self::keys();

        $raw = base64_decode($payload, true);

        if ($raw === false || strlen($raw) <= self::IV_LEN + self::MAC_LEN) {
            throw new \RuntimeException('Malformed ciphertext.');
        }

        $iv         = substr($raw, 0, self::IV_LEN);
        $mac        = substr($raw, self::IV_LEN, self::MAC_LEN);
        $ciphertext = substr($raw, self::IV_LEN + self::MAC_LEN);

        $expected = hash_hmac('sha256', $iv . $ciphertext, (string) self::$macKey, true);

        // Constant-time — a timing-variable compare leaks the MAC byte by byte.
        if (!hash_equals($expected, $mac)) {
            throw new \RuntimeException('Ciphertext failed integrity check.');
        }

        $plaintext = openssl_decrypt($ciphertext, self::CIPHER, self::$encryptionKey, OPENSSL_RAW_DATA, $iv);

        if ($plaintext === false) {
            throw new \RuntimeException('Decryption failed.');
        }

        return $plaintext;
    }

    /** Try to decrypt, returning null instead of throwing. */
    public static function tryDecrypt(?string $payload): ?string
    {
        if ($payload === null || $payload === '') {
            return null;
        }

        try {
            return self::decrypt($payload);
        } catch (\Throwable) {
            return null;
        }
    }

    /** Deterministic hash for lookup columns (refresh tokens, OTP codes). */
    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function randomToken(int $bytes = 32): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    /** Numeric OTP, zero-padded, generated from a CSPRNG. */
    public static function numericCode(int $length = 6): string
    {
        $max = (10 ** $length) - 1;

        return str_pad((string) random_int(0, $max), $length, '0', STR_PAD_LEFT);
    }
}
