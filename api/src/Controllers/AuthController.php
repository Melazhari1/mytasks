<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\Database;
use App\Core\Env;
use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\DeviceToken;
use App\Models\OtpCode;
use App\Models\RefreshToken;
use App\Models\User;
use App\Support\Audit;
use App\Support\Crypto;
use App\Support\Jwt;
use App\Support\Mailer;
use App\Support\RateLimiter;
use App\Support\Totp;
use App\Support\Validator;

final class AuthController
{
    // -----------------------------------------------------------------------
    //  Registration
    // -----------------------------------------------------------------------
    public function register(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'name'     => 'nullable|string|max:120',
            'email'    => 'required|email|max:255',
            'password' => 'required|string|min:8|max:200',
        ]);

        if (User::findByEmail($data['email']) !== null) {
            throw HttpException::conflict('An account with that email already exists.');
        }

        $userId = User::create($data['email'], $data['password'], $data['name'] ?? null);

        Audit::record($userId, 'user.registered', $data['email'], $request);

        Response::created([
            'user'    => User::present(User::find($userId) ?? []),
            'message' => 'Account created. Sign in to continue.',
        ]);
    }

    // -----------------------------------------------------------------------
    //  Step 1 — email + password
    // -----------------------------------------------------------------------
    public function login(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'email'    => 'required|email|max:255',
            'password' => 'required|string|max:200',
        ]);

        $bucket = 'login:' . $request->ip() . ':' . $data['email'];

        RateLimiter::hit($bucket, Env::int('RATE_LIMIT_LOGIN', 10), Env::int('RATE_LIMIT_WINDOW', 900));

        $user = User::findByEmail($data['email']);

        // Uniform failure: never reveal whether the email exists.
        if ($user === null) {
            // Burn comparable time so response timing doesn't leak account existence.
            password_verify($data['password'], '$2y$12$usesomesillystringfoeueeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

            Audit::record(null, 'login.failed', $data['email'], $request);

            throw HttpException::unauthorized('Invalid email or password.');
        }

        if (User::isLocked($user)) {
            throw new HttpException(423, 'account_locked', 'Too many failed attempts. This account is temporarily locked.');
        }

        if (!User::verifyPassword($user, $data['password'])) {
            User::registerFailedLogin((int) $user['id']);
            Audit::record((int) $user['id'], 'login.failed', null, $request);

            throw HttpException::unauthorized('Invalid email or password.');
        }

        RateLimiter::clear($bucket);
        User::registerSuccessfulLogin((int) $user['id']);

        $needsTwoFactor = (bool) $user['two_factor_enabled'] || Env::bool('TWO_FACTOR_REQUIRED', true);

        if (!$needsTwoFactor) {
            Audit::record((int) $user['id'], 'login.success', 'password_only', $request);
            $this->issueSession($request, $user, 'password');
        }

        // TOTP if enrolled and confirmed, otherwise email OTP.
        $method = ((bool) $user['two_factor_enabled'] && $user['two_factor_method'] === 'totp')
            ? 'totp'
            : 'email';

        if ($method === 'email') {
            $code = OtpCode::issue((int) $user['id'], 'login');

            // A delivery failure has to be visible. Handing back a challenge
            // token for a code that was never sent leaves the user staring at
            // a code field nothing will ever satisfy, and the real cause is
            // buried in a server log they cannot read.
            if (!Mailer::sendOtp((string) $user['email'], $code, Env::int('OTP_TTL', 300))) {
                Audit::record((int) $user['id'], 'login.otp_send_failed', null, $request);

                throw new HttpException(
                    503,
                    'otp_delivery_failed',
                    'We could not send your verification code right now. Please try again in a moment.'
                );
            }
        }

        Audit::record((int) $user['id'], 'login.2fa_required', $method, $request);

        Response::json([
            'data' => [
                'two_factor_required' => true,
                'method'              => $method,
                'challenge_token'     => Jwt::issueChallenge((int) $user['id'], $method),
                'expires_in'          => Env::int('JWT_CHALLENGE_TTL', 300),
                'message'             => $method === 'totp'
                    ? 'Enter the 6-digit code from your authenticator app.'
                    : 'We sent a verification code to your email address.',
                // Development affordance only: MAIL_DRIVER=log means nothing is
                // actually delivered, so surface where to find the code.
                'debug_hint'          => (Env::bool('APP_DEBUG', false) && $method === 'email')
                    ? 'MAIL_DRIVER=log — read the code in storage/logs/mail.log'
                    : null,
            ],
        ]);
    }

    // -----------------------------------------------------------------------
    //  Step 2 — OTP / TOTP
    // -----------------------------------------------------------------------
    public function verifyTwoFactor(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'challenge_token' => 'required|string',
            'code'            => 'required|string|min:4|max:10',
            'device_name'     => 'nullable|string|max:120',
        ]);

        $claims = Jwt::decode($data['challenge_token'], 'challenge');
        $userId = (int) $claims['sub'];

        RateLimiter::hit('2fa:' . $userId, Env::int('OTP_MAX_ATTEMPTS', 5) * 2, 900);

        $user = User::find($userId);

        if ($user === null) {
            throw HttpException::unauthorized('Account no longer exists.');
        }

        $method = (string) ($claims['method'] ?? 'email');
        $valid  = false;

        if ($method === 'totp') {
            $secret = Crypto::tryDecrypt($user['two_factor_secret'] ?? null);
            $valid  = $secret !== null && Totp::verify($secret, $data['code']);
        } else {
            $valid = OtpCode::consume($userId, $data['code'], 'login');
        }

        if (!$valid) {
            Audit::record($userId, '2fa.failed', $method, $request);

            throw HttpException::unauthorized('That verification code is incorrect or has expired.');
        }

        RateLimiter::clear('2fa:' . $userId);
        Audit::record($userId, 'login.success', $method, $request);

        $this->issueSession($request, $user, $method, $data['device_name'] ?? null);
    }

    public function resendOtp(Request $request): void
    {
        $data = Validator::check($request->all(), ['challenge_token' => 'required|string']);

        $claims = Jwt::decode($data['challenge_token'], 'challenge');
        $userId = (int) $claims['sub'];

        if (($claims['method'] ?? 'email') !== 'email') {
            throw HttpException::badRequest('This account uses an authenticator app; there is nothing to resend.');
        }

        RateLimiter::hit('otp-resend:' . $userId, 3, 300);

        $user = User::find($userId);

        if ($user === null) {
            throw HttpException::unauthorized('Account no longer exists.');
        }

        $code = OtpCode::issue($userId, 'login');

        if (!Mailer::sendOtp((string) $user['email'], $code, Env::int('OTP_TTL', 300))) {
            throw new HttpException(
                503,
                'otp_delivery_failed',
                'We could not send your verification code right now. Please try again in a moment.'
            );
        }

        Response::message('A new verification code is on its way.');
    }

    // -----------------------------------------------------------------------
    //  Mobile biometrics
    // -----------------------------------------------------------------------

    /**
     * Enrol the current device. Requires a normal authenticated session — the
     * user proves who they are once with password + 2FA, and from then on the
     * device's own biometric gate is enough.
     */
    public function enrollBiometric(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'device_id'   => 'required|string|max:128',
            'device_name' => 'nullable|string|max:120',
            'platform'    => 'nullable|string|in:ios,android,other',
            'public_key'  => 'nullable|string|max:4000',
        ]);

        $userId = $request->userId();

        $result = DeviceToken::enroll(
            $userId,
            $data['device_id'],
            $data['device_name'] ?? null,
            $data['platform'] ?? 'other',
            $data['public_key'] ?? null
        );

        Audit::record($userId, 'biometric.enrolled', $data['device_id'], $request);

        Response::created([
            'device_id' => $data['device_id'],
            'mode'      => isset($data['public_key']) && $data['public_key'] !== null ? 'signature' : 'hmac',
            // Only returned once. Store it in the Keychain / Android Keystore
            // behind a biometric access-control flag, then discard it from memory.
            'device_secret' => $result['secret'],
            'message'   => $result['secret'] !== null
                ? 'Store device_secret in the secure keystore behind biometric authentication. It will not be shown again.'
                : 'Public key registered. Sign the challenge with the matching private key.',
        ]);
    }

    /** Step 1 of biometric login: get a nonce to sign. */
    public function biometricChallenge(Request $request): void
    {
        $data = Validator::check($request->all(), ['device_id' => 'required|string|max:128']);

        RateLimiter::hit('bio-challenge:' . $request->ip(), 30, 900);

        $device = DeviceToken::findByDeviceId($data['device_id']);

        // Always return a challenge, even for unknown devices — probing for
        // enrolled device IDs should not be possible.
        $nonce = Crypto::randomToken(24);

        $token = Jwt::encode([
            'typ'       => 'bio_challenge',
            'sub'       => $device !== null ? (int) $device['user_id'] : 0,
            'device_id' => $data['device_id'],
            'nonce'     => $nonce,
        ], 120);

        Response::ok([
            'challenge'       => $nonce,
            'challenge_token' => $token,
            'expires_in'      => 120,
            'sign_payload'    => $data['device_id'] . ':' . $nonce,
        ]);
    }

    /** Step 2 of biometric login: present the proof. */
    public function biometricLogin(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'challenge_token' => 'required|string',
            'proof'           => 'required|string|max:4000',
            'counter'         => 'nullable|int|min:1',
        ]);

        RateLimiter::hit('bio-login:' . $request->ip(), 20, 900);

        $claims   = Jwt::decode($data['challenge_token'], 'bio_challenge');
        $deviceId = (string) ($claims['device_id'] ?? '');
        $userId   = (int) ($claims['sub'] ?? 0);

        if ($userId <= 0) {
            throw HttpException::unauthorized('This device is not enrolled for biometric sign-in.');
        }

        $device = DeviceToken::find($userId, $deviceId);
        $user   = User::find($userId);

        if ($device === null || $user === null) {
            throw HttpException::unauthorized('This device is not enrolled for biometric sign-in.');
        }

        if (User::isLocked($user)) {
            throw new HttpException(423, 'account_locked', 'This account is temporarily locked.');
        }

        $challenge = $deviceId . ':' . (string) ($claims['nonce'] ?? '');
        $counter   = (int) ($data['counter'] ?? (time()));

        if (!DeviceToken::verifyProof($device, $challenge, $data['proof'], $counter)) {
            Audit::record($userId, 'biometric.failed', $deviceId, $request);

            throw HttpException::unauthorized('Biometric verification failed.');
        }

        DeviceToken::touch((int) $device['id'], $counter);
        User::registerSuccessfulLogin($userId);
        Audit::record($userId, 'login.success', 'biometric', $request);

        // Biometric login skips the 2FA prompt by design: unlocking the device
        // key already required a second factor (something you are).
        $this->issueSession($request, $user, 'biometric', (string) ($device['device_name'] ?? null));
    }

    /** @return void */
    public function listDevices(Request $request): void
    {
        Response::ok(DeviceToken::listForUser($request->userId()));
    }

    public function revokeDevice(Request $request): void
    {
        $deviceId = (string) $request->param('deviceId');

        if (DeviceToken::revoke($request->userId(), $deviceId) === 0) {
            throw HttpException::notFound('That device is not enrolled.');
        }

        Audit::record($request->userId(), 'biometric.revoked', $deviceId, $request);

        Response::message('Device removed.');
    }

    // -----------------------------------------------------------------------
    //  Session lifecycle
    // -----------------------------------------------------------------------
    public function refresh(Request $request): void
    {
        $token = $request->cookie(Env::get('REFRESH_COOKIE_NAME', 'mytasks_refresh'))
            ?? (is_string($request->input('refresh_token')) ? $request->input('refresh_token') : null);

        if ($token === null) {
            throw HttpException::unauthorized('No refresh token supplied.');
        }

        $stored = RefreshToken::findValid($token);

        if ($stored === null) {
            throw HttpException::unauthorized('Refresh token is invalid, expired or revoked.');
        }

        $user = User::find((int) $stored['user_id']);

        if ($user === null) {
            throw HttpException::unauthorized('Account no longer exists.');
        }

        // Rotation: the presented token dies the moment it is used. If it ever
        // shows up again, it was stolen — and it simply won't work.
        RefreshToken::revoke($token);

        $this->issueSession($request, $user, 'refresh', (string) ($stored['device_name'] ?? null));
    }

    public function logout(Request $request): void
    {
        $token = $request->cookie(Env::get('REFRESH_COOKIE_NAME', 'mytasks_refresh'))
            ?? (is_string($request->input('refresh_token')) ? $request->input('refresh_token') : null);

        if ($token !== null) {
            RefreshToken::revoke($token);
        }

        $this->clearRefreshCookie();

        Response::message('Signed out.');
    }

    public function logoutAll(Request $request): void
    {
        $count = RefreshToken::revokeAllForUser($request->userId());

        $this->clearRefreshCookie();

        Audit::record($request->userId(), 'session.revoked_all', (string) $count, $request);

        Response::ok(['revoked_sessions' => $count]);
    }

    public function me(Request $request): void
    {
        $user = User::find($request->userId());

        if ($user === null) {
            throw HttpException::unauthorized('Account no longer exists.');
        }

        Response::ok(User::present($user));
    }

    public function changePassword(Request $request): void
    {
        $data = Validator::check($request->all(), [
            'current_password' => 'required|string|max:200',
            'new_password'     => 'required|string|min:8|max:200',
        ]);

        $user = User::find($request->userId());

        if ($user === null || !User::verifyPassword($user, $data['current_password'])) {
            throw HttpException::unauthorized('Your current password is incorrect.');
        }

        Database::run('UPDATE users SET password_hash = ? WHERE id = ?', [
            User::hashPassword($data['new_password']),
            $request->userId(),
        ]);

        // Changing the password kills every other session.
        RefreshToken::revokeAllForUser($request->userId());
        $this->clearRefreshCookie();

        Audit::record($request->userId(), 'password.changed', null, $request);

        Response::message('Password updated. Please sign in again on your other devices.');
    }

    // -----------------------------------------------------------------------
    //  TOTP enrolment
    // -----------------------------------------------------------------------
    public function setupTotp(Request $request): void
    {
        $userId = $request->userId();
        $user   = User::find($userId);

        if ($user === null) {
            throw HttpException::unauthorized();
        }

        $secret = Totp::generateSecret();

        // Stored encrypted — a leaked database should not hand over the ability
        // to mint valid 2FA codes.
        User::setTwoFactorSecret($userId, Crypto::encrypt($secret), 'totp');

        Response::ok([
            'secret'            => $secret,
            'otpauth_uri'       => Totp::provisioningUri($secret, (string) $user['email']),
            'algorithm'         => 'SHA1',
            'digits'            => 6,
            'period'            => 30,
            'message'           => 'Scan the QR code, then POST the current 6-digit code to /auth/2fa/confirm to finish.',
        ]);
    }

    public function confirmTotp(Request $request): void
    {
        $data = Validator::check($request->all(), ['code' => 'required|string|min:6|max:6']);

        $user   = User::find($request->userId());
        $secret = Crypto::tryDecrypt($user['two_factor_secret'] ?? null);

        if ($secret === null) {
            throw HttpException::badRequest('Start with POST /auth/2fa/setup first.');
        }

        if (!Totp::verify($secret, $data['code'])) {
            throw HttpException::unauthorized('That code is not valid. Check your device clock and try again.');
        }

        User::confirmTwoFactor($request->userId());
        Audit::record($request->userId(), '2fa.enabled', 'totp', $request);

        Response::message('Authenticator app enabled.');
    }

    public function disableTotp(Request $request): void
    {
        $data = Validator::check($request->all(), ['password' => 'required|string|max:200']);

        $user = User::find($request->userId());

        if ($user === null || !User::verifyPassword($user, $data['password'])) {
            throw HttpException::unauthorized('Password is incorrect.');
        }

        User::disableTwoFactor($request->userId());
        Audit::record($request->userId(), '2fa.disabled', null, $request);

        Response::message('Authenticator app disabled. Email codes will be used instead.');
    }

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------

    /** @param array<string,mixed> $user */
    private function issueSession(Request $request, array $user, string $via, ?string $deviceName = null): never
    {
        $refresh = RefreshToken::issue(
            (int) $user['id'],
            $deviceName,
            $request->ip(),
            $request->userAgent()
        );

        $this->setRefreshCookie($refresh['token']);

        Response::json([
            'data' => [
                'token_type'    => 'Bearer',
                'access_token'  => Jwt::issueAccess((int) $user['id'], (string) $user['email']),
                'expires_in'    => Env::int('JWT_ACCESS_TTL', 900),
                // Also returned in the body for desktop/mobile clients that
                // don't have a cookie jar. Web clients should ignore it and
                // rely on the HttpOnly cookie.
                'refresh_token' => $refresh['token'],
                'authenticated_via' => $via,
                'user'          => User::present($user),
            ],
        ]);
    }

    private function setRefreshCookie(string $token): void
    {
        $this->writeRefreshCookie($token, time() + Env::int('JWT_REFRESH_TTL', 2592000));
    }

    private function clearRefreshCookie(): void
    {
        $this->writeRefreshCookie('', time() - 3600);
    }

    private function writeRefreshCookie(string $value, int $expires): void
    {
        if (headers_sent()) {
            return;
        }

        setcookie(Env::get('REFRESH_COOKIE_NAME', 'mytasks_refresh') ?? 'mytasks_refresh', $value, [
            'expires'  => $expires,
            'path'     => self::refreshCookiePath(),
            'secure'   => self::cookieShouldBeSecure(),
            'httponly' => true,
            'samesite' => Env::get('REFRESH_COOKIE_SAMESITE', 'Lax') ?? 'Lax',
        ]);
    }

    /**
     * Whether the refresh cookie gets the Secure flag.
     *
     * REFRESH_COOKIE_SECURE=true forces it on. Otherwise it is decided from
     * the live request, because the alternative fails in both directions:
     * leaving it false on an HTTPS deployment ships the long-lived session
     * credential over a flag that permits plain HTTP, and forcing it true on
     * plain-HTTP local development makes the browser drop the cookie outright,
     * which looks exactly like "sessions randomly expire after 15 minutes".
     *
     * Most managed hosts terminate TLS at a proxy, so $_SERVER['HTTPS'] is
     * unset even though the browser is on HTTPS — hence the forwarded headers.
     * They are only trusted when TRUSTED_PROXY=true, since a client can send
     * X-Forwarded-Proto itself.
     */
    private static function cookieShouldBeSecure(): bool
    {
        if (Env::bool('REFRESH_COOKIE_SECURE', false)) {
            return true;
        }

        if (($_SERVER['HTTPS'] ?? '') !== '' && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }

        if (Env::bool('TRUSTED_PROXY', false)) {
            $proto = strtolower(trim((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')));

            if ($proto !== '') {
                // A proxy chain sends a comma-separated list; the client's own
                // scheme is the first entry.
                return str_starts_with($proto, 'https');
            }

            if (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on') {
                return true;
            }
        }

        return false;
    }

    /**
     * Scope the refresh cookie to wherever the API actually lives.
     *
     * A hard-coded path in .env is the classic way this breaks: move the app
     * to a different folder, forget to update it, and the browser silently
     * stops sending the cookie — every session then dies at the 15-minute
     * access-token mark with no error anywhere. Deriving it from the front
     * controller's own location makes that impossible. REFRESH_COOKIE_PATH
     * still wins when it is set, for setups behind a rewriting proxy.
     */
    private static function refreshCookiePath(): string
    {
        $configured = Env::get('REFRESH_COOKIE_PATH');

        if ($configured !== null) {
            return $configured;
        }

        $dir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));

        return $dir === '' || $dir === '.' ? '/' : $dir;
    }
}
