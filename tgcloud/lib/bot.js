import {parseCommand, parseId, conversationKey, appLink, HELP, COMMANDS} from './commands.js';
import {extractSnapshot} from './snapshot.js';
const PENDING_TTL = 10 * 60 * 1000;
const CONFIRM_TTL = 5 * 60 * 1000;
const errorText = error => ({ACCESS_DENIED:'Доступ закрыт. Память доступна только участникам настроенной группы.',AUTH_UNAVAILABLE:'Не удалось проверить участие. Попробуйте позже; доступ пока закрыт.',CONFIG_REQUIRED:'Память ещё не настроена. Администратору нужно указать группу и назначить бота администратором.',NOT_FOUND:'Запись не найдена.',CONFLICT:'Запись уже изменена. Откройте её заново и повторите действие.',HISTORY_LIMIT:'Достигнут лимит истории. Изменение не выполнено.',TEMPORARY:'Временная ошибка. Попробуйте ещё раз.'}[error?.code] || (error?.code === 'VALIDATION' ? error.message : 'Не удалось выполнить действие. Попробуйте позже.'));
export function createBot({service,store,api,config,now = () => Date.now()}) {
  let username = String(config.botUsername || '').replace(/^@/,'');
  const getUsername = async () => username || (username = (await api.getMe()).username);
  const groupId = config.groupId;
  let commandsRegistered = false;
  // Registers the Russian command menu once per isolate; failures retry on the next /start.
  const registerCommands = async () => {
    if (commandsRegistered) return;
    commandsRegistered = true;
    try {
      await api.setMyCommands({commands:COMMANDS,scope:{type:'default'}});
      await api.setMyCommands({commands:COMMANDS,scope:{type:'all_group_chats'}});
    } catch { commandsRegistered = false; }
  };
  const put = (key,value,ttl = PENDING_TTL) => store.putTemp(groupId,key,value,now() + ttl);
  const get = key => store.getTemp(groupId,key,now());
  const del = key => store.deleteTemp(groupId,key);
  const actorOf = user => ({id:user.id,name:[user.first_name,user.last_name].filter(Boolean).join(' ') || user.username || 'Участник'});
  const reply = (message,text,keyboard) => api.sendMessage({chat_id:message.chat.id,...(message.message_thread_id ? {message_thread_id:message.message_thread_id} : {}),text,link_preview_options:{is_disabled:true},...(keyboard ? {reply_markup:{inline_keyboard:keyboard}} : {})});
  const buttons = item => [[{text:'Открыть',url:appLink(username,`m_${item.id}`)},{text:'Изменить',url:appLink(username,`e_${item.id}`)}]];
  const sendItem = (message,item,prefix) => reply(message,`${prefix}\n${item.displayId || '#'+item.id} · ${item.title}`,buttons(item));
  async function confirm(message,actor,item,operation,key,requestId) {
    const token = `${message.chat.id}:${message.message_id}:${actor.id}:${operation === 'trash' ? 't' : 'r'}`;
    // Compact, database-backed callback. Authority is never encoded in the token.
    const state = {kind:'confirm',token,actorId:actor.id,chatId:message.chat.id,topicId:message.message_thread_id || 0,id:item.id,operation,version:item.version,requestId,expiresAt:now()+CONFIRM_TTL};
    await put(`confirm:${token}`,state,CONFIRM_TTL);
    await put(key,{kind:'confirm',token},CONFIRM_TTL);
    return reply(message,`${operation === 'trash' ? 'Переместить в корзину' : 'Восстановить'} ${item.displayId || '#'+item.id} «${item.title}»?`,[[{text:operation === 'trash' ? 'В корзину' : 'Восстановить',callback_data:`c:${token}`}],[{text:'Отмена',callback_data:`x:${token}`}]]);
  }
  async function save(message,actor,snapshotMessage,annotation,overrideText,requestId,key) {
    const result = extractSnapshot(snapshotMessage,annotation,overrideText);
    if (result.error) return reply(message,result.error);
    const {item,duplicate} = await service.saveSnapshot(result.snapshot,actor,requestId);
    await del(key);
    if (duplicate && item.trashed) return confirm(message,actor,item,'restore',key,`${requestId}:restore`);
    await sendItem(message,item,duplicate ? 'Уже сохранено' : 'Сохранено');
    if (result.warning) await reply(message,result.warning);
  }
  async function message(message,ctx = {}) {
    if (!message?.chat) return;
    if (message.migrate_to_chat_id) return service.migrateChat(message.chat.id,message.migrate_to_chat_id);
    if (message.migrate_from_chat_id) return service.migrateChat(message.migrate_from_chat_id,message.chat.id);
    let command;
    // An ordinary message must not cause a remote call unless this actor has pending input.
    const couldBeCommand = typeof message.text === 'string' && /^[\/@]/.test(message.text);
    if (couldBeCommand) command = parseCommand(message.text,await getUsername());
    const user = message.from;
    if (!user || user.is_bot || message.sender_chat) {
      if (command) await reply(message,'От имени канала или анонимного администратора сохранить запись нельзя. Откройте Mini App от личного аккаунта.',[[{text:'Открыть память',url:appLink(username,'g')}]]);
      return;
    }
    const actor = actorOf(user), key = conversationKey(message,actor.id);
    const pending = await get(key);
    // Commands for another bot and unrecognized commands never become saved content.
    if (!command && couldBeCommand) return;
    if (!command && !pending) return;
    try {
      await service.checkConversation(message.chat.id,actor);
      // Padded so the derived id always satisfies the request-id format.
      const updateId = ctx.update?.update_id;
      const requestId = `tg:${updateId == null ? `${message.chat.id}:${message.message_id}` : String(updateId).padStart(12,'0')}`;
      if (!command) {
        if (pending.kind === 'confirm') return;
        if (pending.kind === 'remember') {
          return await save(message,actor,message,'',undefined,requestId,key);
        }
        if (pending.kind === 'find') {
          if (!message.text?.trim()) return reply(message,'Пришлите поисковый запрос текстом или /cancel.');
          const result = await service.execute('list',{query:message.text.trim(),pageSize:8},actor);
          await del(key);
          return list(message,result.items,'Результаты поиска');
        }
        if (pending.kind === 'edit') {
          if (!message.text?.trim()) return reply(message,'Пришлите новый текст или /cancel.');
          const result = await service.execute('update',{id:pending.id,expectedVersion:pending.version,requestId,body:message.text.trim()},actor);
          await del(key);
          return sendItem(message,result.item,'Изменено');
        }
        return;
      }
      const {action,args} = command;
      if (action === 'cancel') { await del(key); return reply(message,'Ввод отменён'); }
      if (action === 'start') {
        await registerCommands();
        const startArg = args.match(/^file_([1-9]\d*)$/);
        if (startArg) {
          const result = await service.execute('attachment',{id:Number(startArg[1]),requestId:`${requestId}:file`},actor);
          if (result.status === 'sent') return reply(message,'Файл отправлен в этот чат.');
          if (result.status === 'unavailable') return reply(message,'Файл больше недоступен в Telegram. Запись в памяти сохранена.');
          return reply(message,'Не удалось отправить файл. Откройте память и повторите запрос.');
        }
        return reply(message,HELP.replaceAll('@БОТ',`@${username}`),[[{text:'Открыть память',url:appLink(username,'g')}]]);
      }
      if (action === 'help') return reply(message,HELP.replaceAll('@БОТ',`@${username}`),[[{text:'Открыть память',url:appLink(username,'g')}]]);
      if (action === 'memory') return reply(message,'Память нашей группы',[[{text:'Открыть память',url:appLink(username,'g')}]]);
      if (action === 'remember') {
        if (message.external_reply && !message.reply_to_message) return reply(message,'Исходное сообщение из внешнего ответа недоступно. Перешлите его текст, фотографию или документ сюда.');
        if (message.reply_to_message) return await save(message,actor,message.reply_to_message,args,undefined,requestId,key);
        if (args) return await save(message,actor,message,'',args,requestId,key);
        await put(key,{kind:'remember'});
        return reply(message,'Пришлите текст, фотографию или документ в течение 10 минут. /cancel — отменить.');
      }
      if (action === 'find' && !args) { await put(key,{kind:'find'}); return reply(message,'Что найти? Пришлите запрос в течение 10 минут или /cancel.'); }
      if (action === 'find' || action === 'recent') {
        const result = await service.execute('list',{...(action === 'find' ? {query:args} : {}),sort:'newest',pageSize:8},actor);
        return list(message,result.items,action === 'find' ? 'Результаты поиска' : 'Последние записи');
      }
      if (action === 'tags') {
        const result = await service.execute('tags',{},actor);
        return reply(message,result.tags.length ? `Теги\n${result.tags.map(tag=>'#'+tag).join(' · ').slice(0,3500)}` : 'Тегов пока нет');
      }
      if (['edit','forget','restore'].includes(action)) {
        const id = parseId(args);
        if (!id) return reply(message,`Укажите ID записи: /${action} 12`);
        const item = await service.execute('read',{id},actor);
        if (action === 'edit') {
          if (item.trashed) return reply(message,'Сначала восстановите запись из корзины.');
          await put(key,{kind:'edit',id:item.id,version:item.version});
          return reply(message,`Пришлите новый текст для ${item.displayId || '#'+item.id} в течение 10 минут. Источник и история сохранятся. /cancel — отменить.`,buttons(item));
        }
        if (action === 'restore' && !item.trashed) return sendItem(message,item,'Запись уже активна');
        if (action === 'forget' && item.trashed) return sendItem(message,item,'Запись уже в корзине');
        return confirm(message,actor,item,action === 'forget' ? 'trash' : 'restore',key,requestId);
      }
    } catch (error) {
      if (error?.name !== 'AppError') console.error('bot message failed', {chatId:message.chat.id,messageId:message.message_id,error});
      return reply(message,errorText(error));
    }
  }
  async function list(message,items,title) {
    if (!items.length) return reply(message,'Ничего не найдено',[[{text:'Открыть память',url:appLink(username,'g')}]]);
    return reply(message,`${title}\n\n${items.map(item=>`${item.displayId || '#'+item.id} · ${item.title}`).join('\n')}`.slice(0,3800),items.map(item=>[{text:`${item.displayId || '#'+item.id} · ${item.title}`.slice(0,64),url:appLink(username,`m_${item.id}`)}]));
  }
  async function callback(query) {
    if (!query?.data || !/^[cx]:/.test(query.data)) return;
    const answer = text => api.answerCallbackQuery({callback_query_id:query.id,text,show_alert:true});
    const message = query.message;
    if (!message?.chat || !query.from || query.from.is_bot) return answer('Кнопка недоступна');
    const actor = actorOf(query.from), token = query.data.slice(2), key = conversationKey(message,actor.id);
    try {
      await service.checkConversation(message.chat.id,actor);
      const state = await get(`confirm:${token}`), pending = await get(key);
      if (!state || state.expiresAt <= now() || !pending || pending.token !== token) return answer('Подтверждение истекло или отменено. Повторите команду.');
      if (state.actorId !== actor.id || state.chatId !== message.chat.id || state.topicId !== (message.message_thread_id || 0)) return answer('Эта кнопка предназначена другому участнику или диалогу.');
      if (query.data[0] === 'x') { await del(key); await del(`confirm:${token}`); return answer('Отменено'); }
      if (!['trash','restore'].includes(state.operation)) return answer('Недействительная кнопка');
      const result = await service.execute(state.operation,{id:state.id,expectedVersion:state.version,requestId:`${state.requestId}:${state.operation}`},actor);
      await del(key); await del(`confirm:${token}`);
      await answer(state.operation === 'trash' ? 'Перемещено в корзину' : 'Восстановлено');
      await getUsername();
      return sendItem(message,result.item,state.operation === 'trash' ? 'В корзине' : 'Восстановлено');
    } catch (error) {
      if (error?.name !== 'AppError') console.error('bot callback failed', {chatId:message.chat.id,callbackId:query.id,error});
      return answer(errorText(error));
    }
  }
  async function membership(update) {
    if (update?.chat && update.new_chat_member?.status) return service.botMembership(update.chat.id,update.new_chat_member.status);
  }
  return {message,callback,membership};
}
