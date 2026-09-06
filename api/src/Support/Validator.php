<?php

declare(strict_types=1);

namespace App\Support;

use App\Core\HttpException;

/**
 * Small rule-based validator. Collects every error, then throws a single 422
 * so clients can highlight all bad fields at once.
 *
 * Rules: required, string, email, int, bool, numeric, min:n, max:n, in:a,b,c,
 *        date, datetime, hexcolor, nullable
 */
final class Validator
{
    /** @var array<string,list<string>> */
    private array $errors = [];

    /** @var array<string,mixed> */
    private array $validated = [];

    /**
     * @param array<string,mixed>  $data
     * @param array<string,string> $rules  field => 'required|string|max:255'
     */
    public function __construct(private array $data, private array $rules)
    {
    }

    /**
     * @param array<string,mixed>  $data
     * @param array<string,string> $rules
     * @return array<string,mixed> validated subset
     */
    public static function check(array $data, array $rules): array
    {
        return (new self($data, $rules))->validate();
    }

    /** @return array<string,mixed> */
    public function validate(): array
    {
        foreach ($this->rules as $field => $ruleString) {
            $rules    = explode('|', $ruleString);
            $present  = array_key_exists($field, $this->data);
            $value    = $this->data[$field] ?? null;
            $nullable = in_array('nullable', $rules, true);
            $required = in_array('required', $rules, true);

            if ($required && ($value === null || $value === '')) {
                $this->fail($field, 'The ' . self::label($field) . ' field is required.');
                continue;
            }

            if (!$present) {
                continue;
            }

            if ($value === null || $value === '') {
                if ($nullable) {
                    $this->validated[$field] = null;
                    continue;
                }

                if (!$required) {
                    $this->validated[$field] = $value;
                    continue;
                }
            }

            $cast = $value;

            foreach ($rules as $rule) {
                if ($rule === '' || $rule === 'required' || $rule === 'nullable') {
                    continue;
                }

                [$name, $arg] = array_pad(explode(':', $rule, 2), 2, null);

                $cast = $this->apply($field, $name, $arg, $cast);
            }

            if (!isset($this->errors[$field])) {
                $this->validated[$field] = $cast;
            }
        }

        if ($this->errors !== []) {
            throw HttpException::validation($this->errors);
        }

        return $this->validated;
    }

    private function apply(string $field, string $rule, ?string $arg, mixed $value): mixed
    {
        $label = self::label($field);

        switch ($rule) {
            case 'string':
                if (!is_string($value)) {
                    $this->fail($field, "The {$label} must be text.");

                    return $value;
                }

                return trim($value);

            case 'email':
                // Trim first: filter_var rejects an address with surrounding
                // whitespace, and mobile keyboards add it constantly.
                $email = is_string($value) ? trim($value) : $value;

                if (!is_string($email) || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
                    $this->fail($field, "The {$label} must be a valid email address.");

                    return $value;
                }

                return strtolower($email);

            case 'int':
                $int = filter_var($value, FILTER_VALIDATE_INT);

                if ($int === false) {
                    $this->fail($field, "The {$label} must be a whole number.");

                    return $value;
                }

                return $int;

            case 'numeric':
                $num = filter_var($value, FILTER_VALIDATE_FLOAT);

                if ($num === false) {
                    $this->fail($field, "The {$label} must be a number.");

                    return $value;
                }

                return $num;

            case 'bool':
                $bool = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);

                if ($bool === null) {
                    $this->fail($field, "The {$label} must be true or false.");

                    return $value;
                }

                return $bool;

            case 'min':
                if (is_int($value) || is_float($value)) {
                    if ($value < (float) $arg) {
                        $this->fail($field, "The {$label} must be at least {$arg}.");
                    }
                } elseif (is_string($value) && mb_strlen($value) < (int) $arg) {
                    $this->fail($field, "The {$label} must be at least {$arg} characters.");
                }

                return $value;

            case 'max':
                if (is_int($value) || is_float($value)) {
                    if ($value > (float) $arg) {
                        $this->fail($field, "The {$label} may not be greater than {$arg}.");
                    }
                } elseif (is_string($value) && mb_strlen($value) > (int) $arg) {
                    $this->fail($field, "The {$label} may not exceed {$arg} characters.");
                }

                return $value;

            case 'in':
                $allowed = explode(',', (string) $arg);

                if (!in_array((string) $value, $allowed, true)) {
                    $this->fail($field, "The {$label} must be one of: " . implode(', ', $allowed) . '.');
                }

                return $value;

            case 'date':
                if (!is_string($value) || !self::isValidDate($value, 'Y-m-d')) {
                    $this->fail($field, "The {$label} must be a date in YYYY-MM-DD format.");
                }

                return $value;

            case 'datetime':
                if (!is_string($value) || self::normalizeDateTime($value) === null) {
                    $this->fail($field, "The {$label} must be a valid date/time (YYYY-MM-DD HH:MM or ISO 8601).");

                    return $value;
                }

                return self::normalizeDateTime($value);

            case 'hexcolor':
                if (!is_string($value) || preg_match('/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', $value) !== 1) {
                    $this->fail($field, "The {$label} must be a hex colour such as #4F46E5.");
                }

                return $value;

            default:
                return $value;
        }
    }

    private static function isValidDate(string $value, string $format): bool
    {
        $date = \DateTimeImmutable::createFromFormat('!' . $format, $value);

        return $date !== false && $date->format($format) === $value;
    }

    /** Accepts ISO 8601 or 'Y-m-d H:i[:s]', returns 'Y-m-d H:i:s'. */
    public static function normalizeDateTime(string $value): ?string
    {
        $value = trim($value);

        foreach (['Y-m-d H:i:s', 'Y-m-d H:i', 'Y-m-d\TH:i:s', 'Y-m-d\TH:i', 'Y-m-d'] as $format) {
            $date = \DateTimeImmutable::createFromFormat('!' . $format, $value);

            if ($date !== false) {
                return $date->format('Y-m-d H:i:s');
            }
        }

        try {
            return (new \DateTimeImmutable($value))->format('Y-m-d H:i:s');
        } catch (\Throwable) {
            return null;
        }
    }

    private function fail(string $field, string $message): void
    {
        $this->errors[$field][] = $message;
    }

    private static function label(string $field): string
    {
        return str_replace('_', ' ', $field);
    }
}
