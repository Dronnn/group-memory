// Deliberate capture only. No fuzzy matching or passive message ingestion.
const commands = new Set(['start','help','remember','save','memory','show','find','recent','tags','edit','forget','restore','cancel']);
export function parseCommand(text, botUsername) {
  if (typeof text !== 'string') return null;
  const name = String(botUsername || '').replace(/^@/, '').toLowerCase();
  const command = text.match(/^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (command) {
    if (command[2] && command[2].toLowerCase() !== name) return null;
    const action = command[1].toLowerCase();
    return commands.has(action) ? {action: action === 'save' ? 'remember' : action, args: (command[3] || '').trim()} : null;
  }
  const mention = text.match(/^@([a-z0-9_]+)\s+(запомни|найди|память)(?:\s+([\s\S]*))?$/i);
  if (!mention || !name || mention[1].toLowerCase() !== name) return null;
  return {action: {запомни:'remember',найди:'find',память:'memory'}[mention[2].toLowerCase()], args:(mention[3] || '').trim()};
}
export function parseId(text) {
  const match = String(text || '').trim().match(/^(?:#|M-)?([1-9]\d*)$/i);
  const id = match && Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
// Forum topic of a message, or 0. Replies in ordinary supergroups can carry a reply-thread id
// too; only real topics scope conversations and outgoing messages.
export function topicOf(message) {
  return (message.is_topic_message && message.message_thread_id) || 0;
}
export function conversationKey(message, actorId) {
  return `pending:${message.chat.id}:${topicOf(message)}:${actorId}`;
}
export function appLink(username, selector = 'memory') {
  return `https://t.me/${String(username).replace(/^@/,'')}?startapp=${encodeURIComponent(selector)}`;
}
export const COMMANDS = [
  { command: 'start', description: 'О боте и вход в память' },
  { command: 'help', description: 'Короткая справка и примеры' },
  { command: 'remember', description: 'Сохранить текст или выбранное сообщение' },
  { command: 'memory', description: 'Меню памяти с кнопками' },
  { command: 'show', description: 'Показать запись по ID' },
  { command: 'find', description: 'Найти по запросу' },
  { command: 'recent', description: 'Последние записи' },
  { command: 'tags', description: 'Теги и просмотр' },
  { command: 'edit', description: 'Изменить запись по ID' },
  { command: 'forget', description: 'Переместить запись в корзину' },
  { command: 'restore', description: 'Восстановить запись из корзины' },
  { command: 'cancel', description: 'Отменить ввод' },
];
export const HELP = 'Общая память группы\n\n/memory — меню с кнопками: последние, поиск, теги, корзина\n/remember текст — сохранить заметку\n/save в ответ на сообщение — сохранить выбранное сообщение; текст команды станет примечанием\n/show ID — показать запись целиком\n/find запрос — поиск\n/recent — последние записи\n/tags — теги\n/edit ID — изменить текст\n/forget ID — в корзину после подтверждения\n/restore ID — восстановить\n/cancel — отменить ввод\n\nМожно адресовать мне: @БОТ запомни текст, @БОТ найди запрос, @БОТ память. Обычную переписку я не сохраняю.';
