import {bot} from '../lib/bot-runtime.js';
export default async function(message,ctx) { return bot.message(message,ctx); }
