import { fail } from './errors.js';

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function actorIdentity(actor) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.is_bot) {
    fail('ACCESS_DENIED', 'Войдите через Telegram');
  }
  return {
    id: actor.id,
    name: String(
      actor.name ||
        [actor.first_name, actor.last_name].filter(Boolean).join(' ') ||
        actor.username ||
        'Участник',
    ).slice(0, 160),
  };
}

/** Stable group id derived from the chat id at registration: -1001234 -> g1001234. */
export const groupIdOf = chatId => `g${-chatId}`;

export function groupRef(value) {
  if (typeof value !== 'string' || !/^g[1-9]\d{0,19}$/.test(value)) {
    fail('VALIDATION', 'Не выбрана группа', { fields: ['group'] });
  }
  return value;
}

export function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('VALIDATION', 'Некорректное число', { fields: [field] });
  return value;
}

export function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(value)) {
    fail('VALIDATION', 'Некорректный идентификатор запроса', { fields: ['requestId'] });
  }
  return value;
}

export function content(input, limits, options = {}) {
  const result = {};
  for (const [field, max] of [
    ['body', limits.body],
    ['annotation', limits.annotation],
    ['title', limits.title],
  ]) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      fail('VALIDATION', 'Ожидается текст', { fields: [field] });
    }
    result[field] = (input[field] || '').trim();
    if (result[field].length > max) fail('VALIDATION', 'Текст слишком длинный', { fields: [field] });
  }
  if (result.body.length + result.annotation.length > limits.bodyPlusAnnotation) {
    fail('VALIDATION', 'Текст и примечание вместе слишком длинные', { fields: ['body', 'annotation'] });
  }
  result.title ||= (
    result.body.split('\n')[0] ||
    input.attachment?.fileName ||
    'Вложение'
  ).slice(0, limits.title);
  if (!result.body && !input.attachment && !options.allowEmptyBody) {
    fail('VALIDATION', 'Добавьте текст', { fields: ['body'] });
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    fail('VALIDATION', 'Ожидается список тегов', { fields: ['tags'] });
  }
  result.tags = [];
  for (const tag of input.tags || []) {
    if (typeof tag !== 'string') fail('VALIDATION', 'Некорректный тег', { fields: ['tags'] });
    const normalized = normalize(tag).replace(/^#+/u, '').trim();
    if (!normalized || normalized.length > limits.tag || /[\u0000-\u001f]/u.test(normalized)) {
      fail('VALIDATION', 'Некорректный тег', { fields: ['tags'] });
    }
    if (!result.tags.includes(normalized)) result.tags.push(normalized);
  }
  if (result.tags.length > limits.tags) fail('VALIDATION', 'Слишком много тегов', { fields: ['tags'] });
  if (input.url !== undefined && typeof input.url !== 'string') {
    fail('VALIDATION', 'Некорректная ссылка', { fields: ['url'] });
  }
  result.url = (input.url || '').trim();
  if (result.url && (result.url.length > 2048 || !/^https?:\/\/[^\s<>]+$/iu.test(result.url))) {
    fail('VALIDATION', 'Нужна ссылка http или https', { fields: ['url'] });
  }
  return result;
}

export function pageSize(value, limits) {
  if (value === undefined) return Math.min(25, limits.pageSize);
  return Math.min(positiveInt(value, 'pageSize'), 25, limits.pageSize);
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .filter(k => value[k] !== undefined)
        .sort()
        .map(k => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function decodeCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('VALIDATION', 'Некорректный курсор', { fields: ['cursor'] });
  const match = /^([0-9]+):([1-9][0-9]*)$/.exec(value);
  if (!match) fail('VALIDATION', 'Некорректный курсор', { fields: ['cursor'] });
  const time = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(time) || !Number.isSafeInteger(id)) {
    fail('VALIDATION', 'Некорректный курсор', { fields: ['cursor'] });
  }
  return { time, id };
}

export function encodeCursor(item, sort) {
  const time = sort === 'updated' ? item.updatedAt : item.createdAt;
  return `${time}:${item.id}`;
}
