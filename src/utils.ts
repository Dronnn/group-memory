import type { Draft, Memory } from './types';

export function safeUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const u = new URL(value);
    if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) return u.href;
  } catch {
    /* ignore */
  }
}

export function parseLocator(value?: string) {
  const m = /^(m|e)_([1-9]\d*)$/.exec(value || '');
  if (m) return { mode: m[1] === 'e' ? 'edit' : 'detail', id: Number(m[2]) } as const;
  if (value === 'new') return { mode: 'new' as const };
  return { mode: 'list' as const };
}

export const formatDate = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

export function parseTags(value: string) {
  return [
    ...new Set(
      value
        .split(',')
        .map(x => x.trim().replace(/^#+/, '').normalize('NFKC').toLocaleLowerCase('ru'))
        .filter(Boolean),
    ),
  ];
}

export const draftFrom = (item?: Memory): Draft => ({
  title: item?.title || '',
  body: item?.body || '',
  annotation: item?.annotation || '',
  tags: item?.tags.join(', ') || '',
  url: item?.url || '',
});

export function validateDraft(draft: Draft, hasAttachment = false) {
  const errors: Record<string, string> = {};
  if (!draft.body.trim() && !draft.url.trim() && !hasAttachment) errors.body = 'Добавьте текст или ссылку';
  if (draft.title.length > 120) errors.title = 'Не больше 120 символов';
  if (draft.body.length + draft.annotation.length > 20000) {
    errors.body = 'Текст и примечание вместе — не больше 20 000 символов';
  }
  if (draft.annotation.length > 20000) errors.annotation = 'Не больше 20 000 символов';
  if (draft.url.trim() && !safeUrl(draft.url.trim())) errors.url = 'Нужна полная ссылка http:// или https://';
  const tags = parseTags(draft.tags);
  if (tags.length > 10 || tags.some(x => x.length > 30)) {
    errors.tags = 'До 10 тегов, каждый не длиннее 30 символов';
  }
  return errors;
}

export function markdownExport(items: Partial<Memory>[]) {
  return (
    '# Общая память\n\n' +
    items
      .map(
        i =>
          `## ${String(i.title || i.displayId || 'Без названия').replace(/[\r\n]/g, ' ')}\n\n${i.body || ''}\n\n${
            i.annotation ? `Примечание: ${i.annotation}\n\n` : ''
          }${i.url ? `Ссылка: ${i.url}\n\n` : ''}Теги: ${(i.tags || []).join(', ')}\n\nСохранил(а): ${
            i.creator?.name || '—'
          }\n\n${i.attachment ? `Вложение (без файла): ${JSON.stringify(i.attachment)}\n\n` : ''}---`,
      )
      .join('\n\n')
  );
}

export function excerpt(text: string, max = 160) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function formatSize(bytes?: number) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function attachmentMeta(attachment: Memory['attachment']) {
  if (!attachment) return '';
  return [
    attachment.kind === 'document' ? attachment.mimeType : undefined,
    attachment.size != null ? formatSize(attachment.size) : undefined,
    attachment.width && attachment.height ? `${attachment.width}×${attachment.height}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export const typeLabel: Record<string, string> = {
  text: 'Текст',
  link: 'Ссылка',
  photo: 'Фото',
  document: 'Документ',
};
