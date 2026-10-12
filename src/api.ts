export class ApiError extends Error { constructor(public code:string,message:string,public details:Record<string,unknown>={}) {super(message)} }
export type Transport = <T>(input:Record<string,unknown>)=>Promise<T>;
const productionTransport:Transport = input => new Promise((resolve,reject)=>{
  const app=window.Telegram?.WebApp;
  if(!navigator.onLine) return reject(new ApiError('OFFLINE','Нет соединения с интернетом'));
  if(!app?.initData || !app.Serverless?.call) return reject(new ApiError('SESSION_REQUIRED','Откройте приложение в Telegram'));
  const timer=setTimeout(()=>reject(new ApiError('TEMPORARY','Ответ задерживается. Повторите попытку')),25000);
  try {app.Serverless.call('memory',input,(error,result)=>{clearTimeout(timer);if(error){const details=error.parameters||{};reject(new ApiError(String(details.code || (error.type?.includes('AUTH')?'SESSION_EXPIRED':'TEMPORARY')),error.message||'Не удалось выполнить запрос',details));}else resolve(result);});} catch {clearTimeout(timer);reject(new ApiError('TEMPORARY','Не удалось связаться с Telegram'));}
});
let transport:Transport=productionTransport;
export async function initializeTransport(){if(import.meta.env.DEV && import.meta.env.VITE_DEV_FIXTURE==='1'){const {fixtureTransport}=await import('./dev/fixture');transport=fixtureTransport;}}
// Every call names its group; the Mini App is not told which chat it was opened from.
let group:string|undefined;
export const setGroup=(id?:string)=>{group=id;};
export const rpc=<T>(action:string,input:Record<string,unknown>={})=>transport<T>({action,...(group?{group}:{}),...input});
export const requestId=()=>crypto.randomUUID();
export function errorText(error:unknown){const e=error as ApiError;return ({ACCESS_DENIED:'Эта память доступна только участникам группы. Если вы уже участник, проверьте доступ бота в группе.',AUTH_UNAVAILABLE:'Не удалось проверить участие в группе. Попробуйте позже.',NO_GROUPS:'Откройте память кнопкой из своей группы: команда /memory в группе. Бот должен быть администратором группы.',SESSION_REQUIRED:'Откройте «Общую память» через бота в Telegram.',SESSION_EXPIRED:'Сессия устарела. Закройте приложение и откройте его снова через бота.',NOT_FOUND:'Запись не найдена или больше недоступна.',HISTORY_LIMIT:'История этой записи достигла лимита. Сохраните новую запись, чтобы не потерять изменения.',OFFLINE:'Вы не в сети. Изменения пока нельзя отправить.',CONFLICT:'Запись уже изменил другой участник. Ваш черновик сохранён на экране.'} as Record<string,string>)[e.code] || e.message || 'Не удалось выполнить действие. Попробуйте ещё раз';}
