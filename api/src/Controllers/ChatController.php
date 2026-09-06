<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Core\HttpException;
use App\Core\Request;
use App\Core\Response;
use App\Models\Category;
use App\Support\OllamaClient;

/**
 * Backs the command-chat widget's fallback path: when chatbox.js's own
 * fixed-grammar parser doesn't recognize a message, it POSTs the raw text
 * here and a local Ollama model turns it into a structured intent instead.
 * See OllamaClient for the "fails soft, never leaks past OLLAMA_URL" contract.
 */
final class ChatController
{
    private const INTENTS = [
        'add_task', 'add_goal', 'list_tasks', 'list_goals',
        'done', 'delete_task', 'delete_goal', 'delete_all_goals', 'help', 'chat', 'unknown',
    ];

    /** Max length kept from a free-text "reply" — a chat bubble, not an essay. */
    private const MAX_REPLY_LENGTH = 400;

    private const PRIORITIES = ['low', 'medium', 'high'];

    /**
     * Optional tone presets a caller can pick with the "persona" field —
     * the web chat box never sends one (always "friendly"), the Cat
     * Assistant companion app's Settings → General lets the user choose.
     */
    private const TONES = [
        'friendly' => 'a friendly, upbeat, slightly playful assistant. You genuinely '
            . 'like helping the user stay on top of their tasks and goals. Casual and '
            . 'warm, never robotic or corporate, but never rambling.',
        'professional' => 'a precise, courteous, businesslike assistant. Efficient and '
            . 'to the point, minimal small talk, still personable — never curt, never chatty.',
        'playful' => 'a playful, upbeat assistant who isn\'t afraid of a light joke or '
            . 'pun. Energetic and fun, but always genuinely useful — the humor never '
            . 'gets in the way of actually helping.',
        'blunt' => 'a blunt, no-nonsense assistant. Short replies, no filler '
            . 'pleasantries, no hedging — but not rude, just efficient.',
    ];

    public function interpret(Request $request): void
    {
        $message = trim((string) ($request->input('message') ?? ''));

        if ($message === '') {
            throw HttpException::badRequest('Nothing to interpret.');
        }

        $userId = $request->userId();
        $goalNames = array_map(
            static fn (array $c) => (string) $c['name'],
            Category::allForUser($userId, false)
        );

        $personaKey = strtolower(trim((string) ($request->input('persona') ?? 'friendly')));

        if (!array_key_exists($personaKey, self::TONES)) {
            $personaKey = 'friendly';
        }

        $catName = trim((string) ($request->input('name') ?? ''));

        if ($catName === '' || strlen($catName) > 30 || !preg_match('/^[\p{L}\p{N} .\'-]+$/u', $catName)) {
            $catName = 'the MyTasks cat';
        }

        $client = new OllamaClient();
        $parsed = $client->generateJson($this->buildPrompt($message, $goalNames, $personaKey, $catName));

        if ($parsed === null) {
            throw new HttpException(503, 'ollama_unavailable', 'The local AI helper is not reachable right now.');
        }

        $intent = is_string($parsed['intent'] ?? null) ? $parsed['intent'] : 'unknown';

        if (!in_array($intent, self::INTENTS, true)) {
            $intent = 'unknown';
        }

        $priority = is_string($parsed['priority'] ?? null) ? strtolower(trim($parsed['priority'])) : null;

        if (!in_array($priority, self::PRIORITIES, true)) {
            $priority = null;
        }

        $dueDate = is_string($parsed['due_date'] ?? null) ? trim($parsed['due_date']) : null;

        if ($dueDate === null || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueDate)) {
            $dueDate = null;
        }

        $clean = static function (mixed $value): ?string {
            if (!is_string($value)) {
                return null;
            }

            $value = trim($value);

            return $value === '' ? null : $value;
        };

        $reply = $clean($parsed['reply'] ?? null);

        // mb_* here, not strlen/substr — those count bytes, and a UTF-8
        // reply in Arabic (or any non-Latin script) is 2+ bytes per
        // character. Byte-counting both under-truncates the visible length
        // and risks slicing a multi-byte character in half, corrupting it.
        if ($reply !== null && mb_strlen($reply, 'UTF-8') > self::MAX_REPLY_LENGTH) {
            $reply = mb_substr($reply, 0, self::MAX_REPLY_LENGTH, 'UTF-8') . '…';
        }

        Response::ok([
            'intent' => $intent,
            'title' => $clean($parsed['title'] ?? null),
            'goal' => $clean($parsed['goal'] ?? null),
            'due_date' => $dueDate,
            'priority' => $priority,
            'filter' => $clean($parsed['filter'] ?? null),
            'fragment' => $clean($parsed['fragment'] ?? null),
            'reply' => $reply,
        ]);
    }

    /** @param list<string> $goalNames */
    private function buildPrompt(string $message, array $goalNames, string $personaKey, string $catName): string
    {
        $today = (new \DateTimeImmutable('now'))->format('Y-m-d');
        $goalsList = $goalNames === [] ? '(none yet)' : implode(', ', $goalNames);
        $encodedMessage = json_encode($message, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);

        $persona = "You are {$catName} — " . self::TONES[$personaKey];

        return <<<PROMPT
            {$persona}

            Read the user's message and reply with ONLY a JSON object (no prose, no
            markdown fences) matching exactly this shape:

            {"intent": one of "add_task"|"add_goal"|"list_tasks"|"list_goals"|"done"|"delete_task"|"delete_goal"|"delete_all_goals"|"help"|"chat"|"unknown",
             "title": task title string or null,
             "goal": goal/category name mentioned or null,
             "due_date": "YYYY-MM-DD" or null,
             "priority": "low"|"medium"|"high" or null,
             "filter": for list_tasks only — "today"|"tomorrow"|"week"|"month"|"overdue"|"done" or a goal name or search text, or null,
             "fragment": for done/delete_task/delete_goal only — the task or goal text to match, or null,
             "reply": for "chat" only — your in-character reply text, or null}

            Today's date is {$today}. Resolve relative dates ("tomorrow", "next friday",
            "in 3 days") into an actual YYYY-MM-DD using that date as "today". The
            user's existing goals are: {$goalsList} — if the message names one of
            these (even loosely or misspelled), put that goal's exact name in "goal".

            Use "delete_all_goals" only when the message clearly asks to remove
            EVERY goal at once ("delete all my goals", "clear all goals", "remove
            everything") — not for deleting one specific goal by name, that's
            "delete_goal". No "goal"/"fragment" needed for it.

            If the message is a greeting, small talk, thanks, a question about you,
            or anything else that isn't actually asking to manage tasks/goals, set
            intent to "chat" and put a short (1-2 sentence) in-character reply in
            "reply" — stay yourself even off-topic, but if it's a long way from
            tasks/goals, gently nudge back toward what you can actually do. Only use
            "unknown" when the message is genuinely unintelligible (gibberish, a
            broken fragment) — a real sentence you understood, even if off-topic,
            is "chat" with a reply, not "unknown".

            The user's message can be in ANY language — English, Arabic, French,
            whatever they wrote in. Understand it regardless, extract "title"/
            "goal"/"fragment" in that same original language (don't translate
            them), and — this matters — write "reply" in that SAME language too.
            A command's intent/filter/priority/due_date values themselves always
            stay the fixed English enum words shown above, in every language.

            Examples:
            "add task do push ups in goal fitness for tomorrow" -> {"intent":"add_task","title":"do push ups","goal":"fitness","due_date":"<tomorrow>","priority":null,"filter":null,"fragment":null,"reply":null}
            "remind me to call mom next monday, high priority" -> {"intent":"add_task","title":"call mom","goal":null,"due_date":"<next monday>","priority":"high","filter":null,"fragment":null,"reply":null}
            "what's on my plate today" -> {"intent":"list_tasks","title":null,"goal":null,"due_date":null,"priority":null,"filter":"today","fragment":null,"reply":null}
            "mark the milk task as done" -> {"intent":"done","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":"milk","reply":null}
            "get rid of the groceries goal" -> {"intent":"delete_goal","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":"groceries","reply":null}
            "remove all my goals" -> {"intent":"delete_all_goals","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":null}
            "hello" / "hi there" -> {"intent":"chat","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":"Hey! Good to see you — need a hand with anything today?"}
            "how are you" -> {"intent":"chat","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":"Doing great, thanks for asking! What are we tackling today?"}
            "thanks!" -> {"intent":"chat","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":"Anytime! That's what I'm here for."}
            "what's the weather like" -> {"intent":"chat","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":"No idea, I only see what's inside this app! Speaking of which, want me to check what's due today?"}
            "ما هي مهامي اليوم" (Arabic: "what are my tasks today") -> {"intent":"list_tasks","title":null,"goal":null,"due_date":null,"priority":null,"filter":"today","fragment":null,"reply":null}
            "أضف مهمة شراء الحليب" (Arabic: "add task buy milk") -> {"intent":"add_task","title":"شراء الحليب","goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":null}
            "مرحبا" (Arabic: "hello") -> {"intent":"chat","title":null,"goal":null,"due_date":null,"priority":null,"filter":null,"fragment":null,"reply":"أهلاً بك! هل تحتاج مساعدة في شيء اليوم؟"}

            User message: {$encodedMessage}

            JSON:
            PROMPT;
    }
}
