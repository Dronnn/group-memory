import {bot} from '../lib/bot-runtime.js';
export default async function(query) { return bot.callback(query); }
