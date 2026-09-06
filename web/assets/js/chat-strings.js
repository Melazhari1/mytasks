/* =============================================================================
   Bilingual (English/Arabic) reply text for the command chat — shared by
   web/assets/js/chatbox.js and cat-assistant/assets/js/chat-engine.js so the
   two copies of the chat grammar don't drift into two separate translations.

   The chat doesn't have a language *setting* — it replies in whichever
   language you just wrote in, message by message (detectLang() below,
   called on your raw text before it's parsed). <code>...</code> command
   examples stay in English in both languages, since that's the actual
   syntax the fixed-grammar parser understands either way.

   defaultLang() is for the handful of messages that have no user text to
   detect from at all (the chat's opening greeting, a mic-permission error
   before anything was transcribed) — falls back to the browser's own
   language setting.
   ========================================================================== */

export function detectLang(text) {
  return /[؀-ۿݐ-ݿ]/.test(text ?? '') ? 'ar' : 'en';
}

export function defaultLang() {
  return typeof navigator !== 'undefined' && /^ar\b/i.test(navigator.language ?? '') ? 'ar' : 'en';
}

const HELP_LINES_EN = [
  "Here's what I understand — goal and task names can have spaces:",
  '<code>add task Buy milk</code>',
  '<code>add task Buy milk goal Groceries due tomorrow priority high</code>',
  '<code>add task do push ups in goal fitness for friday</code>',
  '<code>add goal Groceries</code>',
  '<code>list tasks</code> (also: today / tomorrow / overdue / done / a goal name)',
  '<code>list goals</code>',
  '<code>done Buy milk</code> — marks a matching open task complete',
  '<code>delete task Buy milk</code>',
  '<code>delete goal Groceries</code>',
  '<code>delete all goals</code> — removes every goal and task, asks to confirm first',
  'Anything else — including just saying hi — gets sent to a local AI (Ollama) to interpret or chat about.',
];

const HELP_LINES_AR = [
  'هذا ما أفهمه — يمكن أن تحتوي أسماء الأهداف والمهام على مسافات:',
  '<code>add task Buy milk</code>',
  '<code>add task Buy milk goal Groceries due tomorrow priority high</code>',
  '<code>add task do push ups in goal fitness for friday</code>',
  '<code>add goal Groceries</code>',
  '<code>list tasks</code> (أيضًا: today / tomorrow / overdue / done / اسم هدف)',
  '<code>list goals</code>',
  '<code>done Buy milk</code> — لتحديد مهمة مفتوحة مطابقة كمنجزة',
  '<code>delete task Buy milk</code>',
  '<code>delete goal Groceries</code>',
  '<code>delete all goals</code> — يحذف كل الأهداف والمهام، ويطلب التأكيد أولاً',
  'أي شيء آخر — حتى مجرد التحية — يُرسل إلى ذكاء اصطناعي محلي (Ollama) لتفسيره أو للدردشة حوله.',
];

export const T = {
  en: {
    helpText: HELP_LINES_EN.join('<br>'),
    fallback: "I didn't understand that. Type <code>help</code> to see what I can do.",
    ollamaFallbackDown: 'That doesn\'t match a command I know, and the local AI helper isn\'t reachable right now '
      + '(is Ollama running?). Try phrasing it more like '
      + '<code>add task Buy milk goal Groceries due tomorrow</code>, or type <code>help</code>.',
    chatFallback: "Hey! I'm mostly here to help with tasks and goals — try <code>help</code> to see what I can do.",
    whichTaskDone: 'Which task? e.g. <code>done Buy milk</code>.',
    whichTaskDelete: 'Which task? e.g. <code>delete task Buy milk</code>.',
    whichGoalDelete: 'Which goal? e.g. <code>delete goal Groceries</code>.',
    addGoalMissingName: 'Give the goal a name, e.g. <code>add goal Groceries</code>.',
    goalCreated: (name) => `Created the goal "${name}".`,
    taskMissingTitle: "What's the task called? e.g. <code>add task Buy milk</code>.",
    noGoalsYetForTask: "You don't have any goals yet — try <code>add goal Personal</code> first, then add the task again.",
    goalNotFound: (goal) => `Couldn't find a goal matching "${goal}". Try <code>list goals</code> to see what you have.`,
    taskAdded: (title, categoryName, dueNote) => `Added "${title}" under "${categoryName}"${dueNote}.`,
    dueNoteResolved: (resolved) => ` (due ${resolved})`,
    dueNoteUnresolved: (due) => ` — didn't recognize the due date "${due}", so left it open`,
    noGoalsYet: 'No goals yet. Try <code>add goal Personal</code>.',
    yourGoals: 'Your goals',
    openCount: (n) => `(${n} open)`,
    openTasks: 'Open tasks',
    tasksFiltered: (w) => `Tasks — ${w}`,
    completedTasks: 'Completed tasks',
    tasksInGoal: (name) => `Tasks — ${name}`,
    tasksMatching: (w) => `Tasks matching "${w}"`,
    nothingHere: 'Nothing here.',
    moreCount: (n) => `…and ${n} more.`,
    taskNotFoundOpen: (fragment) => `Couldn't find an open task matching "${fragment}".`,
    ambiguousOpenTask: 'That matches more than one open task — be more specific:',
    taskMarkedDone: (title) => `Marked "${title}" done.`,
    taskNotFound: (fragment) => `Couldn't find a task matching "${fragment}".`,
    ambiguousTask: 'That matches more than one task — be more specific:',
    confirmDeleteTask: (title) => `Delete "${title}"? This can't be undone.`,
    taskDeleted: (title) => `Deleted "${title}".`,
    goalNotFoundDelete: (fragment) => `Couldn't find a goal matching "${fragment}".`,
    ambiguousGoal: 'That matches more than one goal — be more specific:',
    confirmDeleteGoal: (name, count) => (count
      ? `Delete "${name}" and its ${count} task${count > 1 ? 's' : ''}? This can't be undone.`
      : `Delete "${name}"? This can't be undone.`),
    goalDeleted: (name) => `Deleted "${name}".`,
    noGoalsToDelete: "You don't have any goals to delete.",
    confirmDeleteAllGoals: (count) =>
      `Delete all ${count} goal${count > 1 ? 's' : ''} and every task in ${count > 1 ? 'them' : 'it'}? This can't be undone.`,
    allGoalsDeleted: (count) => `Deleted all ${count} goal${count > 1 ? 's' : ''} and their tasks.`,
    confirmYesDeleteAll: 'Yes, delete all',
    confirmYesDelete: 'Yes, delete',
    cancelled: 'Cancelled.',
    couldNotComplete: 'Could not complete that.',
    somethingWrong: 'Something went wrong running that.',
    micPermission: "Couldn't access the microphone — check this site's mic permission.",
    whisperDown: "I couldn't reach the local speech-to-text helper — is whisper.cpp's server running? "
      + 'See <code>api/README.md</code> for setup.',
    didntCatch: "Didn't catch that — try again?",
    welcome: 'Hi! I can add and manage tasks and goals from here — no clicking through forms. '
      + 'Type <code>help</code> to see what I understand.',
    greetingWithName: (name) => `Hi! I'm ${name}. How can I help you today?`,
    wakeListeningStatus: 'Listening for "hey buddy"…',
    wakeYesListening: 'Yes? Listening…',
    wakeMicError: 'Couldn\'t start listening for "hey buddy" — check this site\'s mic permission '
      + '(the address bar\'s lock/site-info icon) and try the ear button again.',
    wakeMicErrorWidget: "Couldn't start listening — check this page's mic permission and re-enable it in Settings.",
    wakePausedTooManyFailures: "Turned off \"hey buddy\" listening — several transcriptions in a row failed "
      + "(background noise, or whisper.cpp's server may be down/overloaded). Fix that, then turn it back on.",
  },

  ar: {
    helpText: HELP_LINES_AR.join('<br>'),
    fallback: 'لم أفهم ذلك. اكتب <code>help</code> لرؤية ما يمكنني فعله.',
    ollamaFallbackDown: 'هذا لا يطابق أمرًا أعرفه، والمساعد الذكي المحلي غير متاح حاليًا (هل Ollama يعمل؟). '
      + 'جرّب صياغة أقرب إلى <code>add task Buy milk goal Groceries due tomorrow</code>، أو اكتب <code>help</code>.',
    chatFallback: 'مرحبًا! أنا هنا بشكل أساسي للمساعدة في المهام والأهداف — جرّب <code>help</code> لرؤية ما يمكنني فعله.',
    whichTaskDone: 'أي مهمة؟ مثال: <code>done Buy milk</code>.',
    whichTaskDelete: 'أي مهمة؟ مثال: <code>delete task Buy milk</code>.',
    whichGoalDelete: 'أي هدف؟ مثال: <code>delete goal Groceries</code>.',
    addGoalMissingName: 'أعطِ الهدف اسمًا، مثل: <code>add goal Groceries</code>.',
    goalCreated: (name) => `تم إنشاء الهدف "${name}".`,
    taskMissingTitle: 'ما اسم المهمة؟ مثال: <code>add task Buy milk</code>.',
    noGoalsYetForTask: 'ليس لديك أي أهداف بعد — جرّب <code>add goal Personal</code> أولاً، ثم أضف المهمة مرة أخرى.',
    goalNotFound: (goal) => `لم أجد هدفًا مطابقًا لـ "${goal}". جرّب <code>list goals</code> لرؤية أهدافك.`,
    taskAdded: (title, categoryName, dueNote) => `تمت إضافة "${title}" تحت "${categoryName}"${dueNote}.`,
    dueNoteResolved: (resolved) => ` (بتاريخ استحقاق ${resolved})`,
    dueNoteUnresolved: (due) => ` — لم أتعرف على تاريخ الاستحقاق "${due}"، لذا تُركت المهمة بدون تاريخ`,
    noGoalsYet: 'لا توجد أهداف بعد. جرّب <code>add goal Personal</code>.',
    yourGoals: 'أهدافك',
    openCount: (n) => `(${n} مفتوحة)`,
    openTasks: 'المهام المفتوحة',
    tasksFiltered: (w) => `المهام — ${w}`,
    completedTasks: 'المهام المكتملة',
    tasksInGoal: (name) => `المهام — ${name}`,
    tasksMatching: (w) => `مهام تطابق "${w}"`,
    nothingHere: 'لا يوجد شيء هنا.',
    moreCount: (n) => `...و ${n} أخرى.`,
    taskNotFoundOpen: (fragment) => `لم أجد مهمة مفتوحة مطابقة لـ "${fragment}".`,
    ambiguousOpenTask: 'هذا يطابق أكثر من مهمة مفتوحة — كن أكثر تحديدًا:',
    taskMarkedDone: (title) => `تم تحديد "${title}" كمنجزة.`,
    taskNotFound: (fragment) => `لم أجد مهمة مطابقة لـ "${fragment}".`,
    ambiguousTask: 'هذا يطابق أكثر من مهمة — كن أكثر تحديدًا:',
    confirmDeleteTask: (title) => `هل تريد حذف "${title}"؟ لا يمكن التراجع عن هذا.`,
    taskDeleted: (title) => `تم حذف "${title}".`,
    goalNotFoundDelete: (fragment) => `لم أجد هدفًا مطابقًا لـ "${fragment}".`,
    ambiguousGoal: 'هذا يطابق أكثر من هدف — كن أكثر تحديدًا:',
    confirmDeleteGoal: (name, count) => (count
      ? `هل تريد حذف "${name}" ومهامه الـ${count}؟ لا يمكن التراجع عن هذا.`
      : `هل تريد حذف "${name}"؟ لا يمكن التراجع عن هذا.`),
    goalDeleted: (name) => `تم حذف "${name}".`,
    noGoalsToDelete: 'ليس لديك أي أهداف لحذفها.',
    confirmDeleteAllGoals: (count) => `هل تريد حذف كل الأهداف الـ${count} وكل مهامها؟ لا يمكن التراجع عن هذا.`,
    allGoalsDeleted: (count) => `تم حذف كل الأهداف الـ${count} ومهامها.`,
    confirmYesDeleteAll: 'نعم، احذف الكل',
    confirmYesDelete: 'نعم، احذف',
    cancelled: 'تم الإلغاء.',
    couldNotComplete: 'تعذر إتمام ذلك.',
    somethingWrong: 'حدث خطأ أثناء تنفيذ ذلك.',
    micPermission: 'تعذر الوصول إلى الميكروفون — تحقق من إذن الميكروفون لهذا الموقع.',
    whisperDown: 'تعذر الوصول إلى مساعد تحويل الصوت إلى نص المحلي — هل خادم whisper.cpp يعمل؟ '
      + 'راجع <code>api/README.md</code> للإعداد.',
    didntCatch: 'لم ألتقط ذلك — هل تحاول مرة أخرى؟',
    welcome: 'مرحبًا! يمكنني إضافة وإدارة المهام والأهداف من هنا — دون الحاجة للنقر عبر النماذج. '
      + 'اكتب <code>help</code> لرؤية ما أفهمه.',
    greetingWithName: (name) => `مرحبًا! أنا ${name}. كيف يمكنني مساعدتك اليوم؟`,
    wakeListeningStatus: 'أستمع لعبارة "hey buddy"...',
    wakeYesListening: 'نعم؟ أستمع...',
    wakeMicError: 'تعذر بدء الاستماع لعبارة "hey buddy" — تحقق من إذن الميكروفون لهذا الموقع '
      + '(أيقونة القفل/معلومات الموقع في شريط العنوان) وحاول الضغط على زر الأذن مرة أخرى.',
    wakeMicErrorWidget: 'تعذر بدء الاستماع — تحقق من إذن الميكروفون لهذه الصفحة وأعد تفعيله من الإعدادات.',
    wakePausedTooManyFailures: 'تم إيقاف الاستماع لعبارة "hey buddy" — فشلت عدة محاولات تحويل صوت إلى نص متتالية '
      + '(ضوضاء خلفية، أو قد يكون خادم whisper.cpp متوقفًا أو محملاً بشكل زائد). أصلح ذلك ثم أعد تفعيله.',
  },
};
