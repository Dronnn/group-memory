import { normalize } from './validation.js';

// Telegram's hashtag shape: letters, digits and "_" with at least one letter.
const WORD = '[\\p{L}\\p{N}_]*\\p{L}[\\p{L}\\p{N}_]*';
const TAG = new RegExp(`^#(${WORD})$`, 'u');
const INLINE = new RegExp(`(^|[^\\p{L}\\p{N}_#])#(${WORD})`, 'gu');

export function hashtags(text) {
  return [...String(text || '').matchAll(INLINE)].map(match => match[2]);
}

/** A run of hashtags at the very start or end is cut off; hashtags inside the text stay. */
export function stripEdgeHashtags(text) {
  const value = String(text || '');
  const tokens = [...value.matchAll(/\S+/gu)];
  let first = 0, last = tokens.length;
  while (first < last && TAG.test(tokens[first][0])) first += 1;
  while (last > first && TAG.test(tokens[last - 1][0])) last -= 1;
  if (first === last) return { text: '', start: value.length, end: value.length };
  const start = tokens[first].index;
  const end = tokens[last - 1].index + tokens[last - 1][0].length;
  return { text: value.slice(start, end), start, end };
}

/** Keeps formatting entities inside [start, end), re-based to the cut text (UTF-16 offsets, like Telegram). */
export function sliceEntities(entities, start, end) {
  return (entities || []).flatMap(entity => {
    const from = Math.max(entity.offset, start), to = Math.min(entity.offset + entity.length, end);
    return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
  });
}

/** Normalized, de-duplicated tags within limits; extra or oversized ones are dropped, never fail a save. */
export function collectTags(list, limits) {
  const tags = [];
  for (const raw of list) {
    const tag = normalize(raw).replace(/^#+/u, '').trim();
    if (tag && tag.length <= limits.tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length === limits.tags) break;
  }
  return tags;
}
