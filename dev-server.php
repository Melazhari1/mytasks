<?php

/**
 * Router for PHP's built-in server — a way to run the whole project without
 * Apache. WAMP does not need this; .htaccess handles the same job there.
 *
 *   php -S 127.0.0.1:8080 -t . dev-server.php
 *
 * Then open http://127.0.0.1:8080/web/
 */

declare(strict_types=1);

$uri  = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
$root = __DIR__;

// Anything under /api goes to the API front controller.
if (str_starts_with($uri, '/api')) {
    $relative = substr($uri, 4);
    $file     = $root . '/api' . $relative;

    // Never serve source or secrets.
    if (preg_match('#^/(src|routes|database|storage|tools)/|/\.env#', $relative)) {
        http_response_code(403);
        exit('Forbidden');
    }

    if ($relative !== '' && $relative !== '/' && is_file($file) && !str_ends_with($file, '.php')) {
        return false;   // let the built-in server serve the static asset
    }

    // Make the API believe it is mounted at /api, the way .htaccess does.
    $_SERVER['SCRIPT_NAME']     = '/api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = $root . '/api/index.php';

    require $root . '/api/index.php';
    return true;
}

// Bare /web → the login page.
if ($uri === '/web' || $uri === '/web/') {
    $_SERVER['SCRIPT_NAME'] = '/web/index.html';
    readfile($root . '/web/index.html');
    header('Content-Type: text/html; charset=utf-8');
    return true;
}

if ($uri === '/') {
    header('Location: /web/');
    return true;
}

return false;   // static file
