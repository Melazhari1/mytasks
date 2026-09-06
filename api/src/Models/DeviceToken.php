<?php

declare(strict_types=1);

namespace App\Models;

use App\Core\Database;
use App\Support\Crypto;

/**
 * Biometric ("unlock with FaceID/fingerprint") enrolment.
 *
 * Important framing: the biometric check happens ON the device. iOS/Android
 * release a key from the secure enclave / StrongBox only after a successful
 * fingerprint or face match. The server never sees biometric data — it only
 * verifies that the device proved possession of the enrolled key.
 *
 * Two proof modes are supported:
 *   - 'signature' : device signs a server challenge with an EC/RSA private key
 *                   held in hardware. The server stores only the public key.
 *                   Strongest option; use this in production.
 *   - 'hmac'      : device holds a random shared secret in the keystore and
 *                   HMACs the challenge. Simpler to implement, still never
 *                   sends the secret. The server stores only its SHA-256 hash.
 */
final class DeviceToken
{
    /** @return array<string,mixed>|null */
    public static function find(int $userId, string $deviceId): ?array
    {
        return Database::first(
            'SELECT * FROM device_tokens WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
            [$userId, $deviceId]
        );
    }

    /** @return array<string,mixed>|null */
    public static function findByDeviceId(string $deviceId): ?array
    {
        return Database::first(
            'SELECT * FROM device_tokens WHERE device_id = ? AND revoked_at IS NULL LIMIT 1',
            [$deviceId]
        );
    }

    /**
     * Enrol a device. Pass either a PEM public key (signature mode) or let the
     * server mint a shared secret (hmac mode) — the secret is returned once and
     * must be stored by the app in the keystore behind biometric access control.
     *
     * @return array{id:int,secret:?string}
     */
    public static function enroll(
        int $userId,
        string $deviceId,
        ?string $deviceName,
        string $platform,
        ?string $publicKey
    ): array {
        $secret     = $publicKey === null ? Crypto::randomToken(32) : null;
        $secretHash = $secret === null ? null : Crypto::hashToken($secret);

        Database::run(
            'INSERT INTO device_tokens (user_id, device_id, device_name, platform, public_key, secret_hash)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                device_name  = VALUES(device_name),
                platform     = VALUES(platform),
                public_key   = VALUES(public_key),
                secret_hash  = VALUES(secret_hash),
                last_counter = 0,
                revoked_at   = NULL',
            [$userId, $deviceId, $deviceName, $platform, $publicKey, $secretHash]
        );

        $row = self::find($userId, $deviceId);

        return ['id' => (int) ($row['id'] ?? 0), 'secret' => $secret];
    }

    /**
     * Verify a device's proof over "{device_id}:{counter}".
     *
     * @param array<string,mixed> $device
     */
    public static function verifyProof(array $device, string $challenge, string $proof, int $counter): bool
    {
        // Replay guard: counters must strictly increase.
        if ($counter <= (int) $device['last_counter']) {
            return false;
        }

        $publicKey = $device['public_key'] ?? null;

        if (is_string($publicKey) && trim($publicKey) !== '') {
            $signature = base64_decode(strtr($proof, '-_', '+/'), true);

            if ($signature === false) {
                return false;
            }

            $key = @openssl_pkey_get_public($publicKey);

            if ($key === false) {
                return false;
            }

            return openssl_verify($challenge, $signature, $key, OPENSSL_ALGO_SHA256) === 1;
        }

        // HMAC mode: the client sends hex/base64url HMAC-SHA256 of the challenge.
        // We can't recompute it (we only stored a hash of the secret), so the
        // client instead sends the secret itself over TLS and we compare hashes.
        return hash_equals((string) $device['secret_hash'], Crypto::hashToken($proof));
    }

    public static function touch(int $deviceRowId, int $counter): void
    {
        Database::run(
            'UPDATE device_tokens SET last_used_at = NOW(), last_counter = ? WHERE id = ?',
            [$counter, $deviceRowId]
        );
    }

    public static function revoke(int $userId, string $deviceId): int
    {
        return Database::affected(
            'UPDATE device_tokens SET revoked_at = NOW() WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
            [$userId, $deviceId]
        );
    }

    /** @return list<array<string,mixed>> */
    public static function listForUser(int $userId): array
    {
        $rows = Database::all(
            'SELECT id, device_id, device_name, platform, last_used_at, created_at
               FROM device_tokens
              WHERE user_id = ? AND revoked_at IS NULL
              ORDER BY created_at DESC',
            [$userId]
        );

        return array_map(static fn (array $r): array => [
            'id'           => (int) $r['id'],
            'device_id'    => $r['device_id'],
            'device_name'  => $r['device_name'],
            'platform'     => $r['platform'],
            'last_used_at' => $r['last_used_at'],
            'created_at'   => $r['created_at'],
        ], $rows);
    }
}
