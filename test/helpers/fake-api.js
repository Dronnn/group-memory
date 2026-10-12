/** Minimal Bot API stand-in for unit tests. Throws BotApiError-shaped errors. */
export function createFakeApi({
  botId = 777,
  botUsername = 'group_memory_bot',
  botStatus = 'administrator',
  members = {},
  memberError = null,
  botMemberError = null,
} = {}) {
  const calls = {
    getMe: 0,
    getChat: 0,
    getChatMember: 0,
    sendMessage: 0,
    sendPhoto: 0,
    sendDocument: 0,
    answerCallbackQuery: 0,
    setMyCommands: 0,
    editMessageText: 0,
  };
  const sent = [];
  const sentCommands = [];

  function botError(code, description) {
    const error = new Error(description);
    error.name = 'BotApiError';
    error.code = code;
    error.description = description;
    return error;
  }

  return {
    calls,
    sent,
    sentCommands,
    members,
    async getMe() {
      calls.getMe += 1;
      return { id: botId, is_bot: true, username: botUsername };
    },
    async getChat({ chat_id }) {
      calls.getChat += 1;
      return { id: chat_id, type: 'supergroup', title: 'Учебная группа' };
    },
    async getChatMember({ chat_id, user_id }) {
      calls.getChatMember += 1;
      if (user_id === botId) {
        if (botMemberError) throw botMemberError;
        return { status: botStatus, user: { id: botId, is_bot: true } };
      }
      if (memberError) throw memberError;
      const member = members[`${chat_id}:${user_id}`] || members[`*:${user_id}`];
      if (!member) throw botError(400, 'Bad Request: user not found');
      return member;
    },
    async sendMessage(params) {
      calls.sendMessage += 1;
      sent.push({ method: 'sendMessage', ...params });
      return { message_id: sent.length, chat: { id: params.chat_id } };
    },
    async sendPhoto(params) {
      calls.sendPhoto += 1;
      sent.push({ method: 'sendPhoto', ...params });
      return { message_id: sent.length };
    },
    async sendDocument(params) {
      calls.sendDocument += 1;
      sent.push({ method: 'sendDocument', ...params });
      return { message_id: sent.length };
    },
    async answerCallbackQuery(params) {
      calls.answerCallbackQuery += 1;
      sent.push({ method: 'answerCallbackQuery', ...params });
      return true;
    },
    async editMessageText(params) {
      calls.editMessageText += 1;
      sent.push({ method: 'editMessageText', ...params });
      return true;
    },
    async setMyCommands(params) {
      calls.setMyCommands += 1;
      sentCommands.push(params);
      return true;
    },
  };
}

export function member(status, extra = {}) {
  return { status, user: { id: 1 }, ...extra };
}
