<?php

declare(strict_types=1);

namespace App\Core;

final class Router
{
    /** @var list<array{method:string,regex:string,params:list<string>,handler:callable,middleware:list<callable>}> */
    private array $routes = [];

    /** @var list<callable> */
    private array $groupMiddleware = [];

    private string $groupPrefix = '';

    /**
     * @param list<callable> $middleware
     */
    public function group(string $prefix, array $middleware, callable $definition): void
    {
        $previousPrefix     = $this->groupPrefix;
        $previousMiddleware = $this->groupMiddleware;

        $this->groupPrefix     = $previousPrefix . '/' . trim($prefix, '/');
        $this->groupMiddleware = array_merge($previousMiddleware, $middleware);

        $definition($this);

        $this->groupPrefix     = $previousPrefix;
        $this->groupMiddleware = $previousMiddleware;
    }

    public function get(string $path, callable $handler): void
    {
        $this->add('GET', $path, $handler);
    }

    public function post(string $path, callable $handler): void
    {
        $this->add('POST', $path, $handler);
    }

    public function put(string $path, callable $handler): void
    {
        $this->add('PUT', $path, $handler);
    }

    public function patch(string $path, callable $handler): void
    {
        $this->add('PATCH', $path, $handler);
    }

    public function delete(string $path, callable $handler): void
    {
        $this->add('DELETE', $path, $handler);
    }

    private function add(string $method, string $path, callable $handler): void
    {
        $full = $this->groupPrefix . '/' . trim($path, '/');
        $full = '/' . trim($full, '/');
        $full = $full === '' ? '/' : $full;

        $params = [];

        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/',
            static function (array $m) use (&$params): string {
                $params[] = $m[1];

                return '([^/]+)';
            },
            $full
        );

        $this->routes[] = [
            'method'     => $method,
            'regex'      => '#^' . $regex . '$#',
            'params'     => $params,
            'handler'    => $handler,
            'middleware' => $this->groupMiddleware,
        ];
    }

    public function dispatch(): void
    {
        $request = new Request();
        $path    = $request->path();
        $method  = $request->method();

        $pathMatched = [];

        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $path, $matches)) {
                continue;
            }

            if ($route['method'] !== $method) {
                $pathMatched[] = $route['method'];
                continue;
            }

            array_shift($matches);
            $request->setRouteParams(array_combine($route['params'], $matches) ?: []);

            foreach ($route['middleware'] as $middleware) {
                $middleware($request);
            }

            ($route['handler'])($request);

            return;
        }

        if ($pathMatched !== []) {
            header('Allow: ' . implode(', ', array_unique($pathMatched)));

            Response::json([
                'error'   => 'method_not_allowed',
                'message' => "The {$method} method is not supported for this endpoint.",
                'allowed' => array_values(array_unique($pathMatched)),
            ], 405);
        }

        Response::json([
            'error'   => 'not_found',
            'message' => "No route matches {$method} {$path}.",
        ], 404);
    }
}
