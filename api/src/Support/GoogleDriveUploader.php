<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\Env;

/**
 * Uploads a file to Google Drive using a service account — no OAuth consent
 * screen, no Google API client library. Two raw HTTP calls:
 *
 *   1. Sign a short-lived JWT with the service account's private key and
 *      exchange it for an access token (RFC 7523 JWT bearer grant).
 *   2. Open a resumable upload session and PUT the file to it.
 *
 * Setup: create a service account in Google Cloud Console, download its JSON
 * key, point GOOGLE_SERVICE_ACCOUNT_FILE at it, then share a Drive folder
 * with the key's client_email (Editor) and put that folder's ID in
 * GOOGLE_DRIVE_FOLDER_ID. Service accounts have no Drive storage of their
 * own — without a shared folder, uploads fail with a quota error.
 */
final class GoogleDriveUploader
{
    private const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
    private const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
    private const SCOPE      = 'https://www.googleapis.com/auth/drive.file';

    public static function isConfigured(): bool
    {
        $file = Env::get('GOOGLE_SERVICE_ACCOUNT_FILE');

        return $file !== null && $file !== '';
    }

    /**
     * @return array<string,mixed> the Drive API's file resource (id, name, webViewLink)
     */
    public static function upload(string $filePath, string $filename): array
    {
        $credentials = self::loadCredentials();
        $accessToken = self::fetchAccessToken($credentials);

        return self::uploadResumable($accessToken, $filePath, $filename, Env::get('GOOGLE_DRIVE_FOLDER_ID'));
    }

    /** @return array<string,mixed> */
    private static function loadCredentials(): array
    {
        $configured = Env::require('GOOGLE_SERVICE_ACCOUNT_FILE');

        $path = is_file($configured) ? $configured : API_ROOT . '/' . ltrim($configured, '/\\');

        if (!is_file($path)) {
            throw new \RuntimeException('GOOGLE_SERVICE_ACCOUNT_FILE does not point to a real file: ' . $configured);
        }

        $decoded = json_decode((string) file_get_contents($path), true);

        if (!is_array($decoded) || empty($decoded['client_email']) || empty($decoded['private_key'])) {
            throw new \RuntimeException('Google service account key file is missing client_email or private_key.');
        }

        return $decoded;
    }

    /** @param array<string,mixed> $credentials */
    private static function fetchAccessToken(array $credentials): string
    {
        $now = time();

        $header = self::b64(json_encode(['alg' => 'RS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
        $claims = self::b64(json_encode([
            'iss'   => $credentials['client_email'],
            'scope' => self::SCOPE,
            'aud'   => $credentials['token_uri'] ?? self::TOKEN_URL,
            'iat'   => $now,
            'exp'   => $now + 3600,
        ], JSON_THROW_ON_ERROR));

        $signingInput = $header . '.' . $claims;
        $signature    = '';

        $signed = openssl_sign($signingInput, $signature, (string) $credentials['private_key'], OPENSSL_ALGO_SHA256);

        if (!$signed) {
            throw new \RuntimeException('Could not sign the Google service-account JWT — is the private key valid?');
        }

        $assertion = $signingInput . '.' . self::b64($signature);

        [$status, $body] = self::request(
            'POST',
            (string) ($credentials['token_uri'] ?? self::TOKEN_URL),
            "Content-Type: application/x-www-form-urlencoded\r\n",
            http_build_query([
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion'  => $assertion,
            ])
        );

        $decoded = json_decode($body, true);

        if ($status < 200 || $status >= 300 || !is_array($decoded) || empty($decoded['access_token'])) {
            throw new \RuntimeException('Google did not issue an access token (HTTP ' . $status . '): ' . $body);
        }

        return (string) $decoded['access_token'];
    }

    /** @return array<string,mixed> */
    private static function uploadResumable(string $accessToken, string $filePath, string $filename, ?string $folderId): array
    {
        $metadata = ['name' => $filename];

        if ($folderId !== null && $folderId !== '') {
            $metadata['parents'] = [$folderId];
        }

        [$initStatus, , $initHeaders] = self::request(
            'POST',
            self::UPLOAD_URL . '?uploadType=resumable&fields=id,name,webViewLink',
            "Authorization: Bearer {$accessToken}\r\n"
                . "Content-Type: application/json; charset=UTF-8\r\n"
                . "X-Upload-Content-Type: application/zip\r\n",
            json_encode($metadata, JSON_THROW_ON_ERROR)
        );

        $sessionUrl = null;

        foreach ($initHeaders as $line) {
            if (stripos($line, 'Location:') === 0) {
                $sessionUrl = trim(substr($line, strlen('Location:')));
            }
        }

        if ($initStatus < 200 || $initStatus >= 300 || $sessionUrl === null) {
            throw new \RuntimeException('Google Drive did not open an upload session (HTTP ' . $initStatus . ').');
        }

        $size = filesize($filePath) ?: 0;

        // Loaded whole into memory for a single PUT — fine for a personal
        // project's backup sizes. Very large archives would want chunked
        // resumable PUTs instead.
        [$status, $body] = self::request(
            'PUT',
            $sessionUrl,
            "Content-Type: application/zip\r\nContent-Length: {$size}\r\n",
            (string) file_get_contents($filePath)
        );

        $decoded = json_decode($body, true);

        if ($status < 200 || $status >= 300 || !is_array($decoded) || empty($decoded['id'])) {
            throw new \RuntimeException('Google Drive upload failed (HTTP ' . $status . '): ' . $body);
        }

        return $decoded;
    }

    /**
     * @return array{0:int,1:string,2:list<string>} [status, body, response headers]
     */
    private static function request(string $method, string $url, string $headers, string $body): array
    {
        $context = stream_context_create([
            'http' => [
                'method'        => $method,
                'header'        => $headers,
                'content'       => $body,
                'ignore_errors' => true,
                'timeout'       => 300,
            ],
        ]);

        $result = file_get_contents($url, false, $context);
        $responseHeaders = $http_response_header ?? [];

        $status = 0;

        foreach ($responseHeaders as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1];
            }
        }

        return [$status, $result === false ? '' : $result, $responseHeaders];
    }

    private static function b64(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
}
