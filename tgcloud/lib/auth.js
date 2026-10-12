import { fail } from './errors.js';
import { actorIdentity } from './validation.js';

function isBotApiError(error) {
  return Boolean(error && (error.name === 'BotApiError' || error.method || error.description));
}

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

/**
 * Membership and bot-admin checks for every protected operation.
 * No positive membership cache — callers must invoke this on each request.
 */
export function createAuth({ store, api, config }) {
  async function resolveGroup() {
    if (!Number.isSafeInteger(config.initialChatId) || config.initialChatId === 0) {
      fail('CONFIG_REQUIRED', 'Укажите идентификатор группы в конфигурации');
    }
    let group = await store.getGroup(config.groupId);
    if (!group) {
      group = await store.ensureGroup(config.groupId, config.initialChatId, config.groupTitle);
    }
    if (!group?.chatId) fail('CONFIG_REQUIRED', 'Группа ещё не подключена');
    return group;
  }

  function acceptMembership(member) {
    if (!member || typeof member.status !== 'string') return false;
    if (MEMBER_STATUSES.has(member.status)) return true;
    if (member.status === 'restricted' && member.is_member === true) return true;
    return false;
  }

  async function requireBotCanAuthorize(group) {
    if (group.botStatus === 'left' || group.botStatus === 'kicked') {
      fail('AUTH_UNAVAILABLE', 'Бот удалён из группы. Доступ временно закрыт');
    }
    try {
      const me = await api.getMe();
      const self = await api.getChatMember({ chat_id: group.chatId, user_id: me.id });
      const status = self?.status;
      if (status !== 'administrator' && status !== 'creator') {
        fail(
          'AUTH_UNAVAILABLE',
          'Бот должен быть администратором группы, чтобы проверять участников',
        );
      }
      if (group.botStatus !== status) await store.setBotStatus(group.id, group.chatId, status);
    } catch (error) {
      if (isBotApiError(error)) {
        fail('AUTH_UNAVAILABLE', 'Не удалось проверить статус бота в группе. Попробуйте позже');
      }
      throw error;
    }
  }

  async function requireMember(rawActor) {
    const actor = actorIdentity(rawActor);
    const group = await resolveGroup();
    await requireBotCanAuthorize(group);
    try {
      const member = await api.getChatMember({ chat_id: group.chatId, user_id: actor.id });
      if (!acceptMembership(member)) fail('ACCESS_DENIED', 'Доступ только для участников группы');
    } catch (error) {
      if (error?.code === 'ACCESS_DENIED' || error?.code === 'AUTH_UNAVAILABLE' || error?.code === 'CONFIG_REQUIRED') {
        throw error;
      }
      if (isBotApiError(error)) {
        const description = String(error.description || '').toLowerCase();
        // Telegram answers 400 "user not found" when the user is unknown to the chat:
        // a definite non-membership, unlike transient failures.
        if (error.code === 400 && (description.includes('user not found') || description.includes('participant'))) {
          fail('ACCESS_DENIED', 'Доступ только для участников группы');
        }
        fail('AUTH_UNAVAILABLE', 'Не удалось проверить участие в группе. Попробуйте позже');
      }
      throw error;
    }
    let title = group.title;
    try {
      const chat = await api.getChat({ chat_id: group.chatId });
      if (chat?.title && chat.title !== group.title) {
        await store.ensureGroup(group.id, group.chatId, chat.title);
        title = chat.title;
      }
    } catch {
      // Title refresh is best-effort; membership already verified.
    }
    return { actor, group: { id: group.id, chatId: group.chatId, title } };
  }

  /** Private chats and the configured group both reach the same collection. */
  async function requireConversation(chatId, rawActor) {
    const auth = await requireMember(rawActor);
    if (chatId === auth.group.chatId) return auth;
    // Private chat with the bot: same shared collection after membership check.
    if (typeof chatId === 'number' && chatId > 0) return auth;
    fail('ACCESS_DENIED', 'Эта команда работает в настроенной группе или в личке с ботом');
  }

  return { resolveGroup, requireMember, requireConversation, acceptMembership };
}
