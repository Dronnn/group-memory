import {bot} from '../lib/bot-runtime.js';
export default async function(update) { return bot.membership(update); }
