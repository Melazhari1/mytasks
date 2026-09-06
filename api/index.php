<?php
/**
 * Front controller — every request enters here.
 *
 * WAMP layout: C:\wamp64\www\xxp\mytasks\api
 * Base URL:    http://localhost/xxp/mytasks/api
 */

declare(strict_types=1);

define('API_ROOT', __DIR__);

require __DIR__ . '/src/Core/Autoloader.php';

use App\Core\Autoloader;
use App\Core\Env;
use App\Core\Router;
use App\Core\Response;
use App\Core\HttpException;

Autoloader::register(__DIR__ . '/src', 'App\\');

Env::load(__DIR__ . '/.env');

// ---------------------------------------------------------------------------
// Error handling: never leak stack traces to clients.
// ---------------------------------------------------------------------------
$debug = Env::bool('APP_DEBUG', false);

ini_set('display_errors', $debug ? '1' : '0');
error_reporting(E_ALL);
ini_set('log_errors', '1');
ini_set('error_log', __DIR__ . '/storage/logs/php-error.log');

date_default_timezone_set(Env::get('APP_TIMEZONE', 'UTC'));

// ---------------------------------------------------------------------------
// CORS — the API is consumed by web, desktop and mobile clients.
// ---------------------------------------------------------------------------
// An origin is only ever echoed back when it appears in CORS_ALLOWED_ORIGINS
// verbatim. `*` no longer reflects: reflecting an arbitrary Origin while also
// sending Allow-Credentials lets any site drive the API as the signed-in user
// the moment REFRESH_COOKIE_SAMESITE is relaxed to None. A literal `*` is only
// honoured for unauthenticated requests, where there are no credentials to
// abuse — anything else must be listed.
$allowedOrigins = array_filter(array_map('trim', explode(',', Env::get('CORS_ALLOWED_ORIGINS', ''))));
$origin         = $_SERVER['HTTP_ORIGIN'] ?? '';

if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Credentials: true');
} elseif (in_array('*', $allowedOrigins, true)) {
    // Public, credential-free access only.
    header('Access-Control-Allow-Origin: *');
}

header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, X-Device-Id, X-Vault-Token, X-Backup-Key');
header('Access-Control-Max-Age: 86400');

// Security headers
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header_remove('X-Powered-By');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
try {
    $router = new Router();
    (require __DIR__ . '/routes/api.php')($router);
    $router->dispatch();
} catch (HttpException $e) {
    Response::json(['error' => $e->getErrorCode(), 'message' => $e->getMessage()] + $e->getExtra(), $e->getStatusCode());
} catch (Throwable $e) {
    error_log('[unhandled] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Response::json([
        'error'   => 'server_error',
        'message' => $debug ? $e->getMessage() : 'An unexpected error occurred.',
        'trace'   => $debug ? explode("\n", $e->getTraceAsString()) : null,
    ], 500);
}
