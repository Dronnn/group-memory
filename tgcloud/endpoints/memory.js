import { EndpointError } from 'sdk';
import { AppError } from '../lib/errors.js';
import { service } from '../lib/runtime.js';

/**
 * Mini App RPC facade. Identity comes only from platform-validated initData.
 * Membership is rechecked inside service.execute for every action.
 */
export default async function memory(input, ctx) {
  const user = ctx?.initData?.user;
  if (!user || !Number.isSafeInteger(user.id)) {
    throw new EndpointError('Войдите через Telegram', { code: 'ACCESS_DENIED' });
  }
  const action = input?.action;
  if (typeof action !== 'string' || !action) {
    throw new EndpointError('Укажите action', { code: 'VALIDATION', fields: ['action'] });
  }
  const { action: _ignored, ...fields } = input;
  try {
    return await service.execute(action, fields, {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
      is_bot: user.is_bot,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw new EndpointError(error.message, {
        code: error.code,
        ...error.details,
      });
    }
    console.error('memory endpoint failed', { action, userId: user.id, error });
    throw error;
  }
}
