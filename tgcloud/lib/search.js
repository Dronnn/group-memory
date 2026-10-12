import { fail } from './errors.js';
import { normalize } from './validation.js';

/** Split a user query into normalized search terms.
 *  Empty query => null (no filter); punctuation-only query => [] (matches nothing). */
export function searchTerms(query, limits) {
  const text = String(query ?? '');
  if (text.length > limits.query) fail('VALIDATION', 'Слишком длинный поисковый запрос', { fields: ['query'] });
  const normalized = normalize(text);
  if (!normalized) return null;
  // Punctuation is treated as separators, never as SQL wildcards.
  return [...new Set(normalized.split(/[^\p{L}\p{N}_+-]+/u).filter(Boolean))];
}

/** Build the normalized search blob stored separately from display text. */
export function buildSearchText(memory) {
  const parts = [
    memory.title,
    memory.body,
    memory.annotation,
    memory.url,
    ...(memory.tags || []),
    memory.attachment?.fileName,
    memory.source?.authorName,
  ];
  return normalize(parts.filter(Boolean).join(' '));
}
