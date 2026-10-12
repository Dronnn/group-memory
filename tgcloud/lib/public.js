/** Strip protected file references before returning data to Mini App / bot confirmations. */
export function publicMemory(memory) {
  if (!memory) return null;
  const attachment = memory.attachment
    ? {
        kind: memory.attachment.kind,
        fileName: memory.attachment.fileName,
        mimeType: memory.attachment.mimeType,
        size: memory.attachment.size,
        width: memory.attachment.width,
        height: memory.attachment.height,
        available: memory.attachment.available !== false,
      }
    : undefined;
  return {
    id: memory.id,
    displayId: memory.displayId || `M-${memory.id}`,
    groupId: memory.groupId,
    title: memory.title,
    body: memory.body,
    annotation: memory.annotation || '',
    url: memory.url || '',
    tags: [...(memory.tags || [])],
    type: memory.type,
    pinned: !!memory.pinned,
    creator: memory.creator,
    editor: memory.editor,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    version: memory.version,
    trashed: !!memory.trashed,
    ...(memory.deletedBy ? { deletedBy: memory.deletedBy } : {}),
    ...(memory.source
      ? {
          source: {
            messageId: memory.source.messageId,
            chatId: String(memory.source.chatId),
            date: memory.source.date,
            authorName: memory.source.authorName,
            ...(memory.source.authorId != null ? { authorId: memory.source.authorId } : {}),
            ...(memory.source.topicId != null ? { topicId: memory.source.topicId } : {}),
            ...(memory.source.url ? { url: memory.source.url } : {}),
          },
        }
      : {}),
    ...(attachment ? { attachment } : {}),
    ...(memory.entities ? { entities: memory.entities } : {}),
  };
}

export function publicRevision(revision) {
  return {
    version: revision.version,
    editor: revision.editor,
    at: revision.at,
    event: revision.event,
    snapshot: publicMemory(revision.snapshot),
  };
}

export function exportMemory(memory) {
  const item = publicMemory(memory);
  if (item.attachment) {
    item.attachment = {
      ...item.attachment,
      note: 'Ссылка на файл в Telegram, не резервная копия содержимого',
    };
  }
  return item;
}

export function inferType({ body, url, attachment }) {
  if (attachment?.kind === 'photo') return 'photo';
  if (attachment?.kind === 'document') return 'document';
  if (url) return 'link';
  return 'text';
}
