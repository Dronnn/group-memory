import { api, db } from 'sdk';
import { config } from './config.js';
import { createService } from './service.js';
import { createStore } from './store.js';

export { api, config };
export const store = createStore(db);
export const service = createService({ store, api, config });
