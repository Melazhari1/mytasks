<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\Env;
use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\OtpCode;
use App\Models\User;
use App\Models\VaultAccount;
use App\Support\Audit;
use App\Support\Crypto;
use App\Support\Jwt;
use App\Support\Mailer;
use App\Support\RateLimiter;
use App\Support\Validator;

final class VaultController
{
    /** Listing returns metadata only — ciphertext never leaves the server. */
    public function index(Request $request): void
    {
        Response::ok(VaultAccount::allForUser($request->userId(), $request->query('search')));
    }

    public function show(Request $request): void
    {
        $row = VaultAccount::findForUser($request->intParam('id'), $request->userId());

        if ($row === null) {
            throw HttpException::notFound('Vault entry not found.');
        }

        Response::ok(VaultAccount::present($row));
    }

    public function store(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'platform_name' => 'required|string|min:1|max:150',
            'platform_url'  => 'nullable|string|max:255',
            'username'      => 'required|string|min:1|max:150',
            'password'      => 'required|string|min:1|max:1000',
            'notes'         => 'nullable|string|max:5000',
        ]);

        $userId = $request->userId();

        $id = VaultAccount::create(
            $userId,
            $data['platform_name'],
            $data['username'],
            $data['password'],
            $data['notes'] ?? null,
            $data['platform_url'] ?? null
        );

        Audit::record($userId, 'vault.created', $data['platform_name'], $request);

        Response::created(VaultAccount::present(VaultAccount::findForUser($id, $userId) ?? []));
    }

    public function update(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        if (VaultAccount::findForUser($id, $userId) === null) {
            throw HttpException::notFound('Vault entry not found.');
        }

        $data = Validator::check($request->all(), [
            'platform_name' => 'nullable|string|min:1|max:150',
            'platform_url'  => 'nullable|string|max:255',
            'username'      => 'nullable|string|min:1|max:150',
            'password'      => 'nullable|string|min:1|max:1000',
            'notes'         => 'nullable|string|max:5000',
        ]);

        VaultAccount::update($id, $userId, $data);

        Audit::record($userId, 'vault.updated', (string) $id, $request);

        Response::ok(VaultAccount::present(VaultAccount::findForUser($id, $userId) ?? []));
    }

    public function destroy(Request $request): void
    {
        $id = $request->intParam('id');

        if (VaultAccount::delete($id, $request->userId()) === 0) {
            throw HttpException::notFound('Vault entry not found.');
        }

        Audit::record($request->userId(), 'vault.deleted', (string) $id, $request);

        Response::noContent();
    }

    /**
     * Exchange a master password (or an emailed OTP) for a short-lived unlock
     * token. Required before any reveal.
     */
    public function unlock(Request $request): void
    {
        $userId = $request->userId();
        $user   = User::find($userId);

        if ($user === null) {
            throw HttpException::unauthorized();
        }

        RateLimiter::hit('vault-unlock:' . $userId, 8, 900);

        $data = Validator::check($request->all(), [
            'master_password' => 'nullable|string|max:200',
            'password'        => 'nullable|string|max:200',
            'otp'             => 'nullable|string|max:10',
        ]);

        $verified = false;

        if (!empty($data['otp'])) {
            $verified = OtpCode::consume($userId, $data['otp'], 'vault_unlock');
        } elseif ($user['master_password_hash'] !== null && !empty($data['master_password'])) {
            $verified = password_verify($data['master_password'], (string) $user['master_password_hash']);
        } elseif (!empty($data['password'])) {
            // No separate master password set — fall back to the account password.
            $verified = $user['master_password_hash'] === null
                && User::verifyPassword($user, $data['password']);
        }

        if (!$verified) {
            Audit::record($userId, 'vault.unlock_failed', null, $request);

            throw HttpException::unauthorized('Vault unlock failed.');
        }

        RateLimiter::clear('vault-unlock:' . $userId);
        Audit::record($userId, 'vault.unlocked', null, $request);

        Response::ok([
            'vault_token' => Jwt::issueVaultUnlock($userId),
            'expires_in'  => Env::int('JWT_VAULT_TTL', 300),
            'usage'       => 'Send it as the X-Vault-Token header on reveal requests.',
        ]);
    }

    /** Email an OTP that can be used instead of the master password. */
    public function requestUnlockOtp(Request $request): void
    {
        $userId = $request->userId();
        $user   = User::find($userId);

        if ($user === null) {
            throw HttpException::unauthorized();
        }

        RateLimiter::hit('vault-otp:' . $userId, 3, 300);

        $code = OtpCode::issue($userId, 'vault_unlock');

        if (!Mailer::sendOtp((string) $user['email'], $code, Env::int('OTP_TTL', 300))) {
            throw new HttpException(
                503,
                'otp_delivery_failed',
                'We could not send your unlock code right now. Please try again in a moment.'
            );
        }

        Response::message('A vault unlock code has been sent to your email.');
    }

    public function setMasterPassword(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'account_password' => 'required|string|max:200',
            'master_password'  => 'required|string|min:8|max:200',
        ]);

        $user = User::find($request->userId());

        if ($user === null || !User::verifyPassword($user, $data['account_password'])) {
            throw HttpException::unauthorized('Your account password is incorrect.');
        }

        User::setMasterPassword($request->userId(), $data['master_password']);
        Audit::record($request->userId(), 'vault.master_password_set', null, $request);

        Response::message('Master password set. It is now required to unlock the vault.');
    }

    /**
     * Decrypt and return one password.
     *
     * Guarded by VaultUnlockMiddleware, rate limited, and written to the audit
     * log every single time.
     */
    public function reveal(Request $request): void
    {
        $id     = $request->intParam('id');
        $userId = $request->userId();

        RateLimiter::hit('vault-reveal:' . $userId, 30, 900);

        $row = VaultAccount::findForUser($id, $userId);

        if ($row === null) {
            throw HttpException::notFound('Vault entry not found.');
        }

        try {
            $password = VaultAccount::reveal($row);
        } catch (\Throwable $e) {
            error_log('[vault] decrypt failed for entry ' . $id . ': ' . $e->getMessage());

            throw new HttpException(
                500,
                'decryption_failed',
                'This entry could not be decrypted. It was most likely encrypted with a different APP_KEY.'
            );
        }

        Audit::record($userId, 'vault.revealed', (string) $id, $request);

        Response::json([
            'data' => [
                'id'            => (int) $row['id'],
                'platform_name' => $row['platform_name'],
                'username'      => $row['username'],
                'password'      => $password,
            ],
            'meta' => [
                'warning' => 'Do not cache this value. Clear it from client memory once used.',
            ],
        ]);
    }

    /** Generate a strong password client-side workflows can adopt. */
    public function generatePassword(Request $request): void
    {
        $length  = max(8, min(128, (int) ($request->query('length', '20'))));
        $symbols = $request->query('symbols', '1') !== '0';

        $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

        if ($symbols) {
            $alphabet .= '!@#$%^&*()-_=+[]{};:,.?';
        }

        $max      = strlen($alphabet) - 1;
        $password = '';

        for ($i = 0; $i < $length; $i++) {
            $password .= $alphabet[random_int(0, $max)];
        }

        Response::ok(['password' => $password, 'length' => $length]);
    }

    /** Encrypted export. Requires an unlock token; every entry is decrypted. */
    public function export(Request $request): void
    {
        $userId = $request->userId();

        RateLimiter::hit('vault-export:' . $userId, 3, 3600);

        $rows    = VaultAccount::allForUser($userId);
        $entries = [];

        foreach ($rows as $meta) {
            $full = VaultAccount::findForUser((int) $meta['id'], $userId);

            if ($full === null) {
                continue;
            }

            $entries[] = [
                'platform_name' => $full['platform_name'],
                'platform_url'  => $full['platform_url'],
                'username'      => $full['username'],
                'password'      => Crypto::tryDecrypt((string) $full['encrypted_password']),
                'notes'         => $full['notes'],
            ];
        }

        Audit::record($userId, 'vault.exported', (string) count($entries), $request);

        Response::json([
            'data' => ['exported_at' => date('c'), 'count' => count($entries), 'entries' => $entries],
            'meta' => ['warning' => 'This payload contains plain-text passwords. Handle it accordingly.'],
        ]);
    }
}
