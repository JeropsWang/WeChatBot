/** 注册成员、记忆、用量与素材 API。请求参数先校验，分页与冻结选择由服务端负责，响应只返回实际持久状态。 */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {memoryRow,type Database} from './db.js';
import type {MemoryManager} from './memory-management.js';
import type {MembersService} from './members.js';
import type {CommunityService} from './community.js';
import type {MediaService} from './media.js';
import type {UsageStore} from './usage.js';
import type {AppCache} from './cache.js';
import {getSearchSettings,saveSearchSettings,validateSearchSettings} from './search-settings.js';

export interface RevampRouteServices {
  db:Database; memory:MemoryManager; members:MembersService; community:CommunityService;
  media:MediaService; usage:UsageStore; cache:AppCache; changed:()=>void;
}
const uuid=z.string().uuid();
const paging=z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),pageSize:z.coerce.number().refine(n=>[20,50,100].includes(n),'每页只允许20、50或100条').default(20)});
const memoryFilters=paging.extend({q:z.string().max(2000).optional(),status:z.enum(['active','candidate','conflicted','deleted']).optional(),category:z.enum(['事实','偏好','关系','事件','经验']).optional(),visibility:z.enum(['global','chat','member','unassigned']).optional(),chatId:uuid.optional(),memberId:uuid.optional()}).strict();
const profile=z.object({summary:z.string().max(4000).optional(),interests:z.array(z.string().max(200)).max(30).optional(),preferences:z.array(z.string().max(200)).max(30).optional(),communication:z.string().max(2000).optional()}).strict();
const tags=z.object({emotion:z.array(z.string().trim().min(1).max(32)).max(12),scene:z.array(z.string().trim().min(1).max(32)).max(12),intensity:z.array(z.string().trim().min(1).max(32)).max(12)}).strict();
const mediaKind=z.enum(['image','gif','native-sticker']);
const foodFields=z.object({name:z.string().trim().min(1).max(160),description:z.string().max(4000).optional(),category:z.string().trim().max(100).optional(),tags:z.array(z.string().trim().min(1).max(100)).max(30).optional(),enabled:z.boolean().optional(),imageAssetId:uuid.nullable().optional()}).strict();
const timestamp=z.string().max(64).refine(value=>Number.isFinite(Date.parse(value)),'统计时间无效');
const usageFilters=z.object({from:timestamp.optional(),to:timestamp.optional(),modelId:z.string().trim().min(1).max(200).optional(),chatId:uuid.optional(),purpose:z.string().trim().min(1).max(100).optional()}).strict();
const withTimeOrder=<T extends {from?:string;to?:string}>(value:T)=>{if(value.from&&value.to&&Date.parse(value.from)>Date.parse(value.to))throw Object.assign(new Error('开始时间不能晚于结束时间'),{statusCode:400});return value;};
const emptyBody=z.object({}).strict().optional();
const fail=(message:string,statusCode=404)=>Object.assign(new Error(message),{statusCode});
const managedMedia=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){
  // OS filesystem errors contain absolute paths. Only the authenticated content bytes are public.
  if(error&&typeof error==='object'&&'path' in error)throw fail('托管素材文件暂不可用，请重新上传或检查文件状态','code' in error&&error.code==='ENOENT'?404:500);
  throw error;
}};
const idParam=(params:unknown)=>z.object({id:uuid}).strict().parse(params).id;
const memberParams=(params:unknown)=>z.object({id:uuid,memberId:uuid}).strict().parse(params);
const publicSnapshot=(snapshot:any)=>({id:snapshot.id,chatId:snapshot.chatId??snapshot.chat_id,number:snapshot.number,nickname:snapshot.nickname,aliases:snapshot.aliases,identityStatus:snapshot.identityStatus??snapshot.identity_status,profile:snapshot.profile??{},pinned:snapshot.pinned,version:snapshot.version});

/** Registered in the authenticated application scope; deliberately exposes no identity-binding or mode-command bypass. */
export function registerRevampRoutes(app:FastifyInstance,{db,memory,members,community,media,usage,cache,changed}:RevampRouteServices){
  app.get('/api/tasks/:id',async request=>{const id=idParam(request.params);const row=(await db.query('SELECT id,state,error,result FROM tasks WHERE id=$1',[id])).rows[0];if(!row)throw fail('任务不存在');return row;});
  const checkChat=async(id:string)=>{if(!await db.chat(id))throw fail('群聊不存在');};
  app.get('/api/chats/:id/sticker-settings',async request=>{const id=idParam(request.params);await checkChat(id);return {enabled:Boolean((await db.query('SELECT enabled FROM chat_sticker_settings WHERE chat_id=$1',[id])).rows[0]?.enabled)};});
  app.put('/api/chats/:id/sticker-settings',async request=>{const id=idParam(request.params),{enabled}=z.object({enabled:z.boolean()}).strict().parse(request.body);await checkChat(id);await db.tx(async c=>{await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[id]);await c.query('INSERT INTO chat_sticker_settings(chat_id,enabled) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET enabled=$2',[id,enabled]);if(!enabled)await c.query("UPDATE sends SET status='cancelled',detail='本群自动表情已关闭' WHERE chat_id=$1 AND kind='sticker' AND status='pending'",[id]);});changed();return {enabled};});
  const modeResponse=async(chatId?:string)=>{
    if(chatId)await checkChat(chatId);
    const merged=await members.modeSettings(chatId);
    if(!chatId)return merged;
    const local=(await db.query('SELECT value FROM mode_settings WHERE scope=$1',['chat:'+chatId])).rows[0]?.value;
    return {...merged,overrides:{jeropsPrompt:local?.jeropsPrompt??null,planPrompt:local?.planPrompt??null}};
  };

  app.post('/api/memories/selection',async request=>{
    const value=z.object({ids:z.array(uuid).min(1).max(100_000).optional(),filters:memoryFilters.optional()}).strict().refine(value=>(value.ids===undefined)!==(value.filters===undefined),'请指定记忆ID或筛选条件之一').parse(request.body);
    return memory.createSelection(value);
  });
  app.post('/api/memories/bulk-delete',async request=>{
    const value=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),includePinned:z.boolean()}).strict().parse(request.body);
    const result=await memory.deleteSelection(value);changed();return result;
  });
  app.get('/api/memories/:id',async request=>{
    const id=idParam(request.params),row=(await db.query("SELECT m.*,c.name source_name FROM memories m LEFT JOIN chats c ON c.id=m.source_chat_id WHERE m.id=$1 AND m.status<>'deleted'",[id])).rows[0];
    if(!row)throw fail('记忆不存在');
    const entry=memoryRow(row);
    const sourceMessages=entry.sourceChatId&&entry.sourceMessageIds.length?(await db.query('SELECT id,content,observed_at "observedAt" FROM messages WHERE chat_id=$1 AND id::text=ANY($2::text[]) ORDER BY seq',[entry.sourceChatId,entry.sourceMessageIds])).rows:[];
    return {...entry,sourceMessages};
  });

  app.get('/api/chats/:id/members',async request=>{const id=idParam(request.params);await checkChat(id);return members.list(id,paging.extend({q:z.string().max(1000).optional()}).strict().parse(request.query));});
  app.post('/api/chats/:id/members',async request=>{const id=idParam(request.params),value=z.object({nickname:z.string().trim().min(1).max(200),aliases:z.array(z.string().trim().min(1).max(200)).max(30).optional()}).strict().parse(request.body);const result=await members.create(id,value);changed();return result;});
  app.delete('/api/chats/:id/members/:memberId',async request=>{const {id,memberId}=memberParams(request.params);const result=await members.remove(id,memberId);changed();return result;});
  app.post('/api/chats/:id/members/:memberId/compact',async request=>{emptyBody.parse(request.body);const {id,memberId}=memberParams(request.params);const result=await members.compact(id,memberId);changed();return result;});
  app.post('/api/chats/:id/members/confirm-ui-name',async request=>{const id=idParam(request.params),{taskId}=z.object({taskId:uuid}).strict().parse(request.body);const result=await members.confirmUiName(id,taskId);changed();return result;});
  app.post('/api/chats/:id/members/:memberId/review',async request=>{const {id,memberId}=memberParams(request.params),value=z.object({action:z.enum(['approve','revoke']),evidenceMessageId:uuid.optional()}).strict().parse(request.body);const result=await members.reviewMember(id,memberId,value);changed();return result;});
  app.get('/api/chats/:id/members/:memberId',async request=>{const {id,memberId}=memberParams(request.params);return members.detail(id,memberId);});
  app.patch('/api/chats/:id/members/:memberId',async request=>{
    const {id,memberId}=memberParams(request.params),value=z.object({profile:profile.optional(),pinned:z.boolean().optional(),nickname:z.string().trim().min(1).max(200).optional(),aliases:z.array(z.string().trim().min(1).max(200)).max(30).optional()}).strict().refine(value=>Object.keys(value).length>0,'请提供称呼或固定状态').parse(request.body);
    const result=await members.update(id,memberId,value);changed();return result;
  });
  app.get('/api/chats/:id/members/:memberId/versions',async request=>{const {id,memberId}=memberParams(request.params);return (await members.history(id,memberId)).map(item=>({version:item.version,snapshot:publicSnapshot(item.snapshot),created_at:item.createdAt}));});
  app.post('/api/chats/:id/members/:memberId/reset-mode',async request=>{emptyBody.parse(request.body);const {id,memberId}=memberParams(request.params),result=await members.resetMode(id,memberId);changed();return result;});
  app.get('/api/chats/:id/plan-members',async request=>{const id=idParam(request.params);await checkChat(id);return members.planMembers(id);});
  app.put('/api/chats/:id/plan-members',async request=>{const id=idParam(request.params),{memberIds}=z.object({memberIds:z.array(uuid).max(2)}).strict().parse(request.body),result=await members.setPlanMembers(id,memberIds);changed();return result;});
  app.get('/api/mode-settings',async request=>{const {chatId}=z.object({chatId:uuid.optional()}).strict().parse(request.query);return modeResponse(chatId);});
  app.put('/api/mode-settings',async request=>{
    const value=z.object({chatId:uuid.optional(),jeropsPrompt:z.string().max(20_000).nullable(),planPrompt:z.string().max(20_000).nullable()}).strict().refine(value=>!!value.chatId||(value.jeropsPrompt!==null&&value.planPrompt!==null),'全局模式提示词需使用字符串').parse(request.body);
    await members.saveModeSettings(value);changed();return modeResponse(value.chatId);
  });

  app.get('/api/foods',async request=>community.listFoods(paging.extend({q:z.string().max(1000).optional(),category:z.string().max(100).optional(),enabled:z.enum(['true','false']).optional()}).strict().parse(request.query)));
  const saveFood=async(id:string|undefined,input:unknown)=>{
    let value=id?foodFields.partial().refine(value=>Object.keys(value).length>0,'请提供菜品修改').parse(input):foodFields.parse(input);
    if(value.imageAssetId){const asset=await media.get(value.imageAssetId);if(!asset||asset.kind!=='image'||!asset.enabled||asset.status==='deleted')throw fail('菜品图片必须是可用的托管图片',400);}
    const fields={...value};
    if(id&&!fields.name){const old=(await db.query('SELECT name FROM foods WHERE id=$1',[id])).rows[0];if(!old)throw fail('菜品不存在');fields.name=old.name;}
    const result=await community.saveFood(id,{...fields,name:fields.name!,...(fields.category===''?{category:undefined}:{})});changed();return result;
  };
  app.post('/api/foods',async request=>saveFood(undefined,request.body));
  app.patch('/api/foods/:id',async request=>saveFood(idParam(request.params),request.body));
  app.delete('/api/foods/:id',async request=>{const result=await community.deleteFood(idParam(request.params));changed();return result;});
  app.get('/api/chats/:id/foods',async request=>{const id=idParam(request.params);await checkChat(id);return community.chatFoods(id);});
  app.put('/api/chats/:id/foods',async request=>{const id=idParam(request.params),{foodIds}=z.object({foodIds:z.array(uuid).max(100_000)}).strict().parse(request.body),result=await community.setChatFoods(id,foodIds);changed();return result;});
  app.post('/api/foods/preview',async request=>{
    const {chatId}=z.object({chatId:uuid}).strict().parse(request.body);await checkChat(chatId);
    const preview=await community.preview(chatId),candidates=preview.candidates.map(food=>({id:food.id,name:food.name})),image=await managedMedia(()=>media.wheel({food:{id:preview.food.id,name:preview.food.name},candidates}));return {...image,food:preview.food,candidates};
  });

  app.get('/api/media-assets',async request=>media.list(paging.extend({q:z.string().max(2000).optional(),kind:mediaKind.optional(),status:z.string().max(30).optional()}).strict().parse(request.query)));
  app.get('/api/media-assets/:id',async request=>{const result=await media.get(idParam(request.params));if(!result)throw fail('素材不存在');return result;});
  app.post('/api/media-assets',async request=>{
    const value=z.object({name:z.string().trim().min(1).max(120),kind:mediaKind,data:z.string().max(7*1024*1024).optional(),mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif']).optional(),nativeRef:z.object({id:z.string().trim().min(1).max(512),hash:z.string().regex(/^[0-9a-f]{64}$/i)}).strict().optional(),tags:tags.optional()}).strict().parse(request.body);
    const result=await managedMedia(()=>media.upload(value));changed();return result;
  });
  app.patch('/api/media-assets/:id',async request=>{const value=z.object({name:z.string().trim().min(1).max(120).optional(),tags:tags.optional(),manualTags:z.boolean().optional(),enabled:z.boolean().optional()}).strict().refine(value=>Object.keys(value).length>0,'请提供素材修改').parse(request.body),result=await media.update(idParam(request.params),value);changed();return result;});
  app.delete('/api/media-assets/:id',async request=>{const result=await media.remove(idParam(request.params));changed();return result;});
  app.get('/api/media-assets/:id/content',async(request,reply)=>{
    const content=await managedMedia(()=>media.content(idParam(request.params)));
    reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Disposition','inline');
    return reply.type(content.mimeType).send(content.bytes);
  });
  app.post('/api/media-assets/:id/tag',async request=>{emptyBody.parse(request.body);const result=await managedMedia(()=>media.tag(idParam(request.params)));changed();return result;});

  app.get('/api/usage/summary',async request=>usage.summary(withTimeOrder(usageFilters.parse(request.query))));
  app.get('/api/usage/calls',async request=>usage.calls(withTimeOrder(usageFilters.extend(paging.shape).parse(request.query))));
  app.get('/api/usage/calls/:id',async request=>{const result=await usage.getCall(idParam(request.params));if(!result)throw fail('调用记录不存在');return result;});
  app.get('/api/cache/stats',async()=>cache.stats());
  app.get('/api/search-settings',async()=>getSearchSettings(db));
  app.put('/api/search-settings',async request=>{
    const value=z.object({trustedDomains:z.array(z.string().trim().min(1).max(253)).max(200),timeRange:z.enum(['auto','all','day','week','month','year']),maxResults:z.number().int().min(1).max(20).optional(),candidateLimit:z.number().int().min(1).max(100).optional()}).strict().parse(request.body);
    const current=await getSearchSettings(db);let validated;
    try{validated=validateSearchSettings({...current,...value});}catch(error){throw fail(error instanceof Error?error.message:'搜索配置无效',400);}
    const result=await saveSearchSettings(db,validated);changed();return result;
  });
}
