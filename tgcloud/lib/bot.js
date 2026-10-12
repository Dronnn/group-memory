import {parseCommand, parseId, conversationKey, topicOf, appLink, HELP, COMMANDS} from './commands.js';
import {extractSnapshot} from './snapshot.js';
import {createPanel,panelData} from './panel.js';
const PENDING_TTL = 10 * 60 * 1000;
const CONFIRM_TTL = 5 * 60 * 1000;
const SEARCH_TTL = 24 * 60 * 60 * 1000;
// Conversation keys already carry chat and actor, so temporary state shares one namespace.
const TEMP = 'bot';
const GROUP_CHATS = new Set(['group','supergroup']);
const errorText = error => ({ACCESS_DENIED:'Доступ закрыт. Память доступна только участникам этой группы.',AUTH_UNAVAILABLE:'Не удалось проверить участие. Попробуйте позже; доступ пока закрыт.',NOT_FOUND:'Запись не найдена.',CONFLICT:'Запись уже изменена. Откройте её заново и повторите действие.',HISTORY_LIMIT:'Достигнут лимит истории. Изменение не выполнено.',TEMPORARY:'Временная ошибка. Попробуйте ещё раз.'}[error?.code] || (error?.code === 'VALIDATION' ? error.message : 'Не удалось выполнить действие. Попробуйте позже.'));
export function createBot({service,store,api,config,now = () => Date.now()}) {
  let username = String(config.botUsername || '').replace(/^@/,'');
  const getUsername = async () => username || (username = (await api.getMe()).username);
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
  const put = (key,value,ttl = PENDING_TTL) => store.putTemp(TEMP,key,value,now() + ttl);
  const get = key => store.getTemp(TEMP,key,now());
  const del = key => store.deleteTemp(TEMP,key);
  const actorOf = user => ({id:user.id,name:[user.first_name,user.last_name].filter(Boolean).join(' ') || user.username || 'Участник'});
  const reply = (message,text,keyboard,extra = {}) => api.sendMessage({chat_id:message.chat.id,...(topicOf(message) ? {message_thread_id:topicOf(message)} : {}),text,link_preview_options:{is_disabled:true},...(keyboard ? {reply_markup:{inline_keyboard:keyboard}} : {}),...extra});
  // With group privacy mode on, the bot only receives replies to its own messages: force one.
  const prompt = (message,text) => reply(message,text,null,{reply_markup:{force_reply:true,selective:true},reply_parameters:{message_id:message.message_id,allow_sending_without_reply:true}});
  const panel = createPanel({service,username:() => username});
  const show = (message,view) => reply(message,view.text,view.keyboard);
  const searchKey = (chatId,messageId) => `q:${chatId}:${messageId}`;
  async function showSearch(message,actor,group,query) {
    const sent = await show(message,await panel.search(actor,group,query));
    // "Ещё" on search results needs the query; callback data has no room for it.
    if (sent?.message_id) await put(searchKey(message.chat.id,sent.message_id),{query},SEARCH_TTL);
  }
  async function edit(message,view) {
    try {
      await api.editMessageText({chat_id:message.chat.id,message_id:message.message_id,text:view.text,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:view.keyboard}});
    } catch (error) {
      if (!String(error?.description || '').includes('not modified')) throw error;
    }
  }
  // Every Mini App link names its group: the Mini App is not told which chat it was opened from.
  const openButton = group => [[{text:'Открыть память',url:appLink(username,group || 'memory')}]];
  const buttons = item => [[{text:'Показать',callback_data:panelData(item.groupId,'v',item.id)},{text:'В приложении',url:appLink(username,`${item.groupId}_m_${item.id}`)}]];
  const sendItem = (message,item,prefix) => reply(message,`${prefix}\n${item.displayId || '#'+item.id} · ${item.title}`,buttons(item));
  // Private chat: one known group is used directly, several are offered as buttons.
  async function pickGroup(message,actor,requestId) {
    const {groups} = await service.execute('groups',{},actor);
    if (groups.length === 1) return groups[0].id;
    if (!groups.length) return void await reply(message,'Не нашёл ваших групп с памятью. Добавьте меня в группу администратором и вызовите там /memory — после этого команды заработают и здесь.');
    const token = `${message.chat.id}:${message.message_id}`;
    const {chat,message_id,from,text,reply_to_message,external_reply} = message;
    await put(`choose:${token}`,{actorId:actor.id,requestId,message:{chat,message_id,from,text,reply_to_message,external_reply}});
    return void await reply(message,'Для какой группы?',groups.map(group => [{text:group.title.slice(0,60),callback_data:`g:${token}:${group.id}`}]));
  }
  async function confirm(message,actor,item,operation,key,requestId) {
    const token = `${message.chat.id}:${message.message_id}:${actor.id}:${operation === 'trash' ? 't' : 'r'}`;
    // Compact, database-backed callback. Authority is never encoded in the token.
    const state = {kind:'confirm',token,group:item.groupId,actorId:actor.id,chatId:message.chat.id,topicId:topicOf(message),id:item.id,operation,version:item.version,requestId,expiresAt:now()+CONFIRM_TTL};
    await put(`confirm:${token}`,state,CONFIRM_TTL);
    await put(key,{kind:'confirm',token},CONFIRM_TTL);
    return reply(message,`${operation === 'trash' ? 'Переместить в корзину' : 'Восстановить'} ${item.displayId || '#'+item.id} «${item.title}»?`,[[{text:operation === 'trash' ? 'В корзину' : 'Восстановить',callback_data:`c:${token}`}],[{text:'Отмена',callback_data:`x:${token}`}]]);
  }
  async function save(message,actor,group,snapshotMessage,annotation,overrideText,requestId,key) {
    const result = extractSnapshot(snapshotMessage,annotation,overrideText);
    if (result.error) return reply(message,result.error);
    const {item,duplicate} = await service.saveSnapshot(result.snapshot,actor,requestId,group);
    await del(key);
    if (duplicate && item.trashed) return confirm(message,actor,item,'restore',key,`${requestId}:restore`);
    await sendItem(message,item,duplicate ? 'Уже сохранено' : 'Сохранено');
    if (result.warning) await reply(message,result.warning);
  }
  async function message(message,ctx = {}) {
    if (!message?.chat) return;
    if (message.migrate_to_chat_id) return service.migrateChat(message.chat.id,message.migrate_to_chat_id);
    if (message.migrate_from_chat_id) return service.migrateChat(message.migrate_from_chat_id,message.chat.id);
    const isPrivate = message.chat.type === 'private';
    if (!isPrivate && !GROUP_CHATS.has(message.chat.type)) return;
    let command;
    // An ordinary message must not cause a remote call unless this actor has pending input.
    const couldBeCommand = typeof message.text === 'string' && /^[\/@]/.test(message.text);
    if (couldBeCommand) command = parseCommand(message.text,await getUsername());
    const user = message.from;
    if (!user || user.is_bot || message.sender_chat) {
      if (command) await reply(message,'От имени канала или анонимного администратора сохранить запись нельзя. Откройте Mini App от личного аккаунта.',openButton((await service.registerChat(message.chat))?.id));
      return;
    }
    const actor = actorOf(user), key = conversationKey(message,actor.id);
    const pending = await get(key);
    // Commands for another bot and unrecognized commands never become saved content.
    if (!command && couldBeCommand) return;
    if (!command && !pending) return;
    // Padded so the derived id always satisfies the request-id format.
    const updateId = ctx.update?.update_id;
    const requestId = `tg:${updateId == null ? `${message.chat.id}:${message.message_id}` : String(updateId).padStart(12,'0')}`;
    try {
      const group = isPrivate ? pending?.group : (await service.registerChat(message.chat))?.id;
      return await handle(message,actor,command,pending,group,requestId,key);
    } catch (error) {
      if (error?.name !== 'AppError') console.error('bot message failed', {chatId:message.chat.id,messageId:message.message_id,error});
      return reply(message,errorText(error));
    }
  }
  async function handle(message,actor,command,pending,group,requestId,key) {
    if (!command) {
      if (pending.kind === 'confirm') return;
      if (pending.kind === 'remember') return save(message,actor,group,message,'',undefined,requestId,key);
      if (pending.kind === 'find') {
        if (!message.text?.trim()) return prompt(message,'Пришлите поисковый запрос текстом или /cancel.');
        await service.authorize(actor,group);
        await del(key);
        return showSearch(message,actor,group,message.text.trim());
      }
      if (pending.kind === 'edit') {
        if (!message.text?.trim()) return prompt(message,'Пришлите новый текст или /cancel.');
        const result = await service.execute('update',{group,id:pending.id,expectedVersion:pending.version,requestId,body:message.text.trim()},actor);
        await del(key);
        return sendItem(message,result.item,'Изменено');
      }
      return;
    }
    const {action,args} = command;
    await registerCommands();
    const help = () => reply(message,HELP.replaceAll('@БОТ',`@${username}`),openButton(group));
    if (action === 'cancel') { await del(key); return reply(message,'Ввод отменён'); }
    if (action === 'help') return help();
    if (action === 'start') {
      const startArg = args.match(/^file_(g[1-9]\d*)_([1-9]\d*)$/);
      if (!startArg) return help();
      const result = await service.execute('attachment',{group:startArg[1],id:Number(startArg[2]),requestId:`${requestId}:file`},actor);
      if (result.status === 'sent') return reply(message,'Файл отправлен в этот чат.');
      if (result.status === 'unavailable') return reply(message,'Файл больше недоступен в Telegram. Запись в памяти сохранена.');
      return reply(message,'Не удалось отправить файл. Откройте память и повторите запрос.');
    }
    if (!group) {
      group = await pickGroup(message,actor,requestId);
      if (!group) return;
    }
    await service.authorize(actor,group);
    if (action === 'memory') return show(message,await panel.menu(actor,group));
    if (action === 'show') {
      const id = parseId(args);
      if (!id) return reply(message,'Укажите ID записи: /show 12');
      return show(message,await panel.card(actor,group,id));
    }
    if (action === 'remember') {
      if (message.external_reply && !message.reply_to_message) return reply(message,'Исходное сообщение из внешнего ответа недоступно. Перешлите его текст, фотографию или документ сюда.');
      if (message.reply_to_message) return save(message,actor,group,message.reply_to_message,args,undefined,requestId,key);
      if (args) return save(message,actor,group,message,'',args,requestId,key);
      await put(key,{kind:'remember',group});
      return prompt(message,'Пришлите текст, фотографию или документ ответом на это сообщение в течение 10 минут. /cancel — отменить.');
    }
    if (action === 'find' && !args) { await put(key,{kind:'find',group}); return prompt(message,'Что найти? Пришлите запрос ответом на это сообщение в течение 10 минут или /cancel.'); }
    if (action === 'find') return showSearch(message,actor,group,args);
    if (action === 'recent') return show(message,await panel.recent(actor,group));
    if (action === 'tags') return show(message,await panel.tags(actor,group));
    if (['edit','forget','restore'].includes(action)) {
      const id = parseId(args);
      if (!id) return reply(message,`Укажите ID записи: /${action} 12`);
      const item = await service.execute('read',{group,id},actor);
      if (action === 'edit') {
        if (item.trashed) return reply(message,'Сначала восстановите запись из корзины.');
        await put(key,{kind:'edit',group,id:item.id,version:item.version});
        return prompt(message,`Пришлите новый текст для ${item.displayId || '#'+item.id} ответом на это сообщение в течение 10 минут. Источник и история сохранятся. /cancel — отменить.`);
      }
      if (action === 'restore' && !item.trashed) return sendItem(message,item,'Запись уже активна');
      if (action === 'forget' && item.trashed) return sendItem(message,item,'Запись уже в корзине');
      return confirm(message,actor,item,action === 'forget' ? 'trash' : 'restore',key,requestId);
    }
  }
  // Group chosen for a private-chat command: replay the stored command against it.
  async function chosen(query,actor,answer) {
    const [,chatId,messageId,group] = query.data.split(':');
    const token = `${chatId}:${messageId}`, state = await get(`choose:${token}`);
    if (!state || state.actorId !== actor.id) return answer('Выбор истёк. Повторите команду.');
    await del(`choose:${token}`);
    await api.answerCallbackQuery({callback_query_id:query.id});
    const original = state.message;
    try {
      return await handle(original,actor,parseCommand(original.text,await getUsername()),null,group,state.requestId,conversationKey(original,actor.id));
    } catch (error) {
      if (error?.name !== 'AppError') console.error('bot group choice failed', {chatId:original.chat.id,error});
      return reply(original,errorText(error));
    }
  }
  // Panel button: re-authorize the presser, then redraw the same message.
  async function panelPress(query,actor,answer) {
    const message = query.message;
    const [,group,view,...args] = query.data.split(':');
    const num = i => Number(args[i]);
    const cursor = from => (args.length > from ? args.slice(from).join(':') : undefined);
    const key = conversationKey(message,actor.id);
    const ask = async (pending,text) => {
      await service.authorize(actor,group);
      await put(key,{...pending,group});
      return {text,keyboard:[[{text:'Отмена',callback_data:panelData(group,'c')}]]};
    };
    try {
      let result;
      if (view === 'm') result = await panel.menu(actor,group);
      else if (view === 'c') { await del(key); result = await panel.menu(actor,group); }
      else if (view === 'r') result = await panel.recent(actor,group,cursor(0));
      else if (view === 'x') result = await panel.trash(actor,group,cursor(0));
      else if (view === 't') result = await panel.tags(actor,group);
      else if (view === 'T') result = await panel.tagItems(actor,group,num(0),cursor(1));
      else if (view === 'v') result = await panel.card(actor,group,num(0));
      else if (view === 'd') result = await panel.confirmTrash(actor,group,num(0));
      else if (view === 'f') {
        const state = await get(searchKey(message.chat.id,message.message_id));
        if (!state) return answer('Поиск устарел. Повторите /find запрос.');
        result = await panel.search(actor,group,state.query,cursor(0));
      } else if (view === 'D' || view === 'R') {
        try {
          await service.execute(view === 'D' ? 'trash' : 'restore',{group,id:num(0),expectedVersion:num(1),requestId:`cb:${query.id}`},actor);
        } catch (error) {
          // Someone changed it first: the redrawn card shows the current state.
          if (error?.code !== 'CONFLICT') throw error;
        }
        result = await panel.card(actor,group,num(0));
      } else if (view === 's') result = await ask({kind:'find'},'Что найти? Ответьте на это сообщение текстом запроса.');
      else if (view === 'a') result = await ask({kind:'remember'},'Ответьте на это сообщение текстом, фотографией или документом — сохраню в память.');
      else if (view === 'e') result = await ask({kind:'edit',id:num(0),version:num(1)},`Ответьте на это сообщение новым текстом для M-${num(0)}. Источник и история сохранятся.`);
      else return answer('Недействительная кнопка');
      await edit(message,result);
      await api.answerCallbackQuery({callback_query_id:query.id});
    } catch (error) {
      if (error?.name !== 'AppError') console.error('bot panel failed', {chatId:message.chat.id,callbackId:query.id,error});
      return answer(errorText(error));
    }
  }
  async function callback(query) {
    if (!query?.data || !/^[cxgp]:/.test(query.data)) return;
    const answer = text => api.answerCallbackQuery({callback_query_id:query.id,text,show_alert:true});
    const message = query.message;
    if (!message?.chat || !query.from || query.from.is_bot) return answer('Кнопка недоступна');
    const actor = actorOf(query.from);
    if (query.data[0] === 'g') return chosen(query,actor,answer);
    if (query.data[0] === 'p') { await getUsername(); return panelPress(query,actor,answer); }
    const token = query.data.slice(2), key = conversationKey(message,actor.id);
    try {
      const state = await get(`confirm:${token}`), pending = await get(key);
      if (!state || state.expiresAt <= now() || !pending || pending.token !== token) return answer('Подтверждение истекло или отменено. Повторите команду.');
      if (state.actorId !== actor.id || state.chatId !== message.chat.id || state.topicId !== topicOf(message)) return answer('Эта кнопка предназначена другому участнику или диалогу.');
      if (query.data[0] === 'x') { await del(key); await del(`confirm:${token}`); return answer('Отменено'); }
      if (!['trash','restore'].includes(state.operation)) return answer('Недействительная кнопка');
      const result = await service.execute(state.operation,{group:state.group,id:state.id,expectedVersion:state.version,requestId:`${state.requestId}:${state.operation}`},actor);
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
    if (update?.chat && update.new_chat_member?.status) return service.botMembership(update.chat,update.new_chat_member.status);
  }
  return {message,callback,membership};
}
