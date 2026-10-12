function sourceName(message) {
  if (message.sender_chat) return message.sender_chat.title || message.sender_chat.username || 'Отправитель от имени чата';
  const from = message.from;
  return from ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Участник' : 'Автор недоступен';
}
function messageUrl(message) {
  if (!message.chat || !message.message_id) return undefined;
  if (message.chat.username) return `https://t.me/${message.chat.username}/${message.message_id}`;
  if (message.chat.type === 'supergroup' && String(message.chat.id).startsWith('-100')) return `https://t.me/c/${String(message.chat.id).slice(4)}/${message.message_id}`;
}
export function safeUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined;
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
export function extractSnapshot(message, annotation = '', overrideText) {
  if (!message || message.date === 0) return {error:'Исходное сообщение недоступно. Пришлите его текст или файл заново.'};
  const body = overrideText === undefined ? String(message.text || message.caption || '') : overrideText;
  const entities = overrideText === undefined ? (message.entities || message.caption_entities || []).map(e => ({...e})) : [];
  const urls = entities.map(e => e.type === 'text_link' ? safeUrl(e.url) : e.type === 'url' ? safeUrl(body.slice(e.offset, e.offset + e.length)) : undefined).filter(Boolean);
  const textUrl = body.match(/https?:\/\/[^\s<>]+/i);
  const snapshot = {body, annotation, entities, url:urls[0] || safeUrl(textUrl?.[0]), source:{messageId:message.message_id, chatId:message.chat?.id, date:message.date, authorName:sourceName(message), ...(message.sender_chat || !message.from ? {} : {authorId:message.from.id}), ...(message.message_thread_id ? {topicId:message.message_thread_id} : {}), ...(messageUrl(message) ? {url:messageUrl(message)} : {})}};
  let warning;
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    snapshot.attachment = {kind:'photo',fileId:photo.file_id,fileUniqueId:photo.file_unique_id,width:photo.width,height:photo.height,size:photo.file_size};
  } else if (message.document) {
    const document = message.document;
    snapshot.attachment = {kind:'document',fileId:document.file_id,fileUniqueId:document.file_unique_id,fileName:document.file_name,mimeType:document.mime_type,size:document.file_size};
  } else if (['video','animation','audio','voice','video_note','sticker','contact','location','venue','poll','dice','game','paid_media'].some(key => message[key])) {
    warning = 'Этот тип вложения не поддерживается. Сохранён только доступный текст; само вложение не сохранено.';
    if (!body.trim()) return {error:'Этот тип вложения не поддерживается. Пришлите текстовое описание, фотографию или документ.'};
  }
  if (!body.trim() && !snapshot.attachment) return {error:'В сообщении нет доступного текста, фотографии или документа. Пришлите содержимое заново.'};
  return {snapshot, warning};
}
