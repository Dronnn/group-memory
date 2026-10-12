import {service,store,api,config} from './runtime.js';
import {createBot} from './bot.js';
export const bot = createBot({service,store,api,config});
