/** 组装本机 HTTP API、管理员会话、桥接进程和业务服务。启动迁移失败会暴露未就绪状态；密钥字段必须经 sanitizedSettings 过滤后才能返回。 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { randomBytes,randomUUID,createHash,scryptSync,timingSafeEqual } from 'node:crypto';
import { mkdir,readFile,writeFile,access,open } from 'node:fs/promises';
import { spawn,execFile,type ChildProcess } from 'node:child_process';
import { join,resolve,extname } from 'node:path';
import { z } from 'zod';
import { extractText } from 'unpdf';
import { Database } from './db.js';
import { config,modelConcurrency } from './config.js';
import { SecretStore } from './secrets.js';
import { BridgeHub } from './channel.js';
import { ModelGateway } from './models.js';
import { KnowledgeService } from './knowledge.js';
import { Pipeline,safeError } from './pipeline.js';
import { createNetworkProvider,fetchPage } from './network.js';
import {deepseekBaseUrl,deepseekSecretId} from './deepseek.js';
import {AppCache} from './cache.js';
import {UsageStore} from './usage.js';
import {getSearchSettings} from './search-settings.js';
import {MemoryManager} from './memory-management.js';
import {MembersService} from './members.js';
import {CommunityService} from './community.js';
import {ChatImagesService} from './chat-images.js';
import {HuntService,getHuntSettings,saveHuntSettings,huntWhitelistMembers} from './hunt.js';
import {LocalImageMatcher,type ImageMatcher} from './image-matcher.js';
import {huntQueue} from './hunt-queue.js';
import {HuntGallery} from './hunt-gallery.js';
import {MediaService} from './media.js';
import {registerRevampRoutes} from './revamp-routes.js';
import {pageQuery} from './pagination.js';
import type { AppSettings } from '../../packages/contracts.js';

const personaSchema=z.object({prompt:z.string().max(30000),length:z.enum(['简短','适中','详细']),formality:z.enum(['自然','正式']),humor:z.enum(['克制','偶尔幽默','活泼']),emoji:z.enum(['不用','偶尔','经常']),examples:z.string().max(10000)});
const endpoint=z.string().max(2048).refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}},'请输入HTTP或HTTPS服务地址');
const modelSchema=z.object({name:z.string().trim().min(1).max(100),protocol:z.enum(['openai-compatible','openai','anthropic','google']),model:z.string().trim().min(1).max(200),baseUrl:endpoint,contextWindow:z.number().int().min(2048).max(2000000),supportsTools:z.boolean(),supportsVision:z.boolean().default(false),pricing:z.object({inputPerMillion:z.number().nonnegative(),outputPerMillion:z.number().nonnegative(),cacheReadPerMillion:z.number().nonnegative().optional(),cacheWritePerMillion:z.number().nonnegative().optional(),currency:z.string().trim().min(1).max(12)}).nullable().optional(),apiKey:z.string().max(8192).optional(),clearApiKey:z.boolean().optional()});
const memorySchema=z.object({content:z.string().trim().min(1).max(4000),category:z.enum(['事实','偏好','关系','事件','经验']),tags:z.array(z.string().max(50)).max(30).default([]),pinned:z.boolean().default(false),status:z.enum(['active','candidate','conflicted']).default('active'),visibility:z.enum(['global','chat','member','unassigned']).optional(),scopeChatId:z.uuid().nullable().optional(),memberId:z.uuid().nullable().optional()});
const settingsSchema=z.object({paused:z.boolean(),persona:personaSchema,chatModelId:z.string(),decisionModelId:z.string(),memoryModelId:z.string(),visionModelId:z.string().default(''),proactive:z.object({cooldownSeconds:z.number().int().min(10).max(86400),hourlyLimit:z.number().int().min(1).max(100),judgeIntervalSeconds:z.number().int().min(20).max(600)}),network:z.object({enabled:z.boolean(),searxngUrl:endpoint,provider:z.enum(['searxng','deepseek']).default('searxng'),deepseekBaseUrl:endpoint.default(deepseekBaseUrl),apiKey:z.string().trim().max(8192).optional(),hasApiKey:z.boolean().optional(),clearApiKey:z.boolean().optional()}),embedding:z.object({enabled:z.boolean(),baseUrl:endpoint,model:z.string().max(200),apiKey:z.string().max(8192).optional(),clearApiKey:z.boolean().optional(),version:z.number().int().optional(),hasApiKey:z.boolean().optional()})});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const passwordHash=(password:string)=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');};
const passwordMatches=(password:string,stored:string)=>{const [salt,hash]=stored.split(':');const expected=Buffer.from(hash,'hex'),actual=scryptSync(password,salt,64);return expected.length===actual.length&&timingSafeEqual(expected,actual);};
export interface RuntimeOptions { huntSeedManifest?:string; port:number; databaseUrl:string;redisUrl:string;dataDir:string;bridgeToken:string;startWorkers:boolean;webDir:string;queuePrefix:string;imageMatcher?:ImageMatcher }
export async function createApp(overrides:Partial<RuntimeOptions>={}){
  const options={...config,startWorkers:true,...overrides};const app=Fastify({logger:false,bodyLimit:8_000_000});
  const db=new Database(options.databaseUrl),cache=new AppCache({redisUrl:options.redisUrl,prefix:options.queuePrefix+'-cache'}),usage=new UsageStore(db,cache),gateway=new ModelGateway(usage,modelConcurrency),secrets=new SecretStore(options.dataDir);
  await secrets.init();await mkdir(join(options.dataDir,'attachments'),{recursive:true});
  let token=options.bridgeToken;
  if(!token){try{token=(await readFile(join(options.dataDir,'bridge.token'),'utf8')).trim();}catch{token=randomBytes(32).toString('hex');await writeFile(join(options.dataDir,'bridge.token'),token,{mode:0o600,flag:'wx'});}}
  let ready=false,dependencyError='';try{await db.migrate();ready=true;}catch(error){dependencyError=safeError(error);}
  const clients=new Set<any>();const changed=()=>{for(const response of clients){try{response.write('event: state\ndata: '+JSON.stringify({at:Date.now()})+'\n\n');}catch{clients.delete(response);}}};
  const imageMatcher=options.imageMatcher??new LocalImageMatcher(),gallery=new HuntGallery(db,options.dataDir,imageMatcher,{seedManifest:options.huntSeedManifest});
  let galleryError='';
  if(ready)try{await gallery.init();}catch(error){galleryError=safeError(error);}
  app.addHook('preHandler',async request=>{if(galleryError&&request.url.startsWith('/api/hunt')){try{await gallery.init();galleryError='';}catch(error){throw Object.assign(new Error('触发图库暂不可用：'+safeError(error)),{statusCode:503});}}});
  const members=new MembersService(db),hunt=new HuntService(db,members,gallery);
  const chatImages=new ChatImagesService(db,options.dataDir,gateway,secrets,(c,image)=>hunt.enqueue(c,image));
  const bridge=new BridgeHub(db,changed),knowledge=new KnowledgeService(db,gateway,secrets,{usage,cache}),community=new CommunityService(db),media=new MediaService(db,options.dataDir,gateway,secrets,changed),memory=new MemoryManager(db),pipeline=new Pipeline(db,bridge,gateway,secrets,knowledge,changed,options.redisUrl,options.queuePrefix,{cache,members,community,media,chatImages,hunt,imageMatcher});
  bridge.ingest=event=>pipeline.ingest(event);
  let child:ChildProcess|undefined,guardian:ChildProcess|undefined,startingBridge=false;let retryTimer:ReturnType<typeof setInterval>|undefined;
  const processStatus=()=>({...bridge.status(),managed:Boolean(child),compatibility:Boolean(guardian)});
  const stopBridge=async()=>{
    const owned=child,guard=guardian;if(!owned)return false;
    // Guardian is a sibling, deliberately outside this process tree. It watches
    // the launcher handle and restores the byte even after a bridge crash.
    if(owned.pid&&owned.exitCode===null){
      if(process.platform==='win32')await new Promise<void>((resolve,reject)=>execFile('taskkill.exe',['/PID',String(owned.pid),'/T','/F'],error=>error&&owned.exitCode===null?reject(error):resolve()));
      else owned.kill('SIGTERM');
    }
    if(guard&&guard.exitCode===null)await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('兼容守护进程尚未确认恢复，请查看运行记录')),8000);
      guard.once('exit',()=>{clearTimeout(timer);resolve();});
      if(guard.exitCode!==null){clearTimeout(timer);resolve();}
    });
    if(child===owned)child=undefined;if(guardian===guard)guardian=undefined;changed();return true;
  };
  await app.register(cookie);await app.register(websocket,{options:{maxPayload:300000}});await app.register(rateLimit,{max:600,timeWindow:'1 minute'});
  app.setErrorHandler((error:any,_request,reply)=>{const status=error instanceof z.ZodError?400:error.statusCode&&error.statusCode>=400&&error.statusCode<600?error.statusCode:500;reply.code(status).send({message:error instanceof z.ZodError?error.issues.map((i:any)=>i.path.join('.')+'：'+i.message).join('；'):safeError(error)});});
  app.addHook('onRequest',async(request,reply)=>{
    const host=(request.headers.host??'localhost').replace(/:\d+$/,'');if(!['127.0.0.1','localhost','[::1]'].includes(host)){return reply.code(403).send({message:'只允许本机访问'});}
    if(request.headers.origin){let origin:URL;try{origin=new URL(request.headers.origin);}catch{return reply.code(403).send({message:'请求来源无效'});}if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return reply.code(403).send({message:'不允许跨站访问工作台'});}
    if(!request.url.startsWith('/api/'))return;
    if(['/api/setup/status','/api/setup','/api/login','/api/health'].includes(request.url.split('?')[0]))return;
    if(!ready)return reply.code(503).send({message:'数据库尚未就绪：'+dependencyError});
    const value=request.cookies.liino_session;if(!value)return reply.code(401).send({message:'请先登录工作台'});
    const session=await db.query('SELECT 1 FROM sessions WHERE id_hash=$1 AND expires_at>now()',[sha(value)]);if(!session.rowCount)return reply.code(401).send({message:'登录已过期，请重新登录'});
  });
  const issueSession=async(reply:any)=>{const value=randomBytes(32).toString('hex');await db.query("INSERT INTO sessions(id_hash,expires_at) VALUES($1,now()+interval '7 days')",[sha(value)]);reply.setCookie('liino_session',value,{httpOnly:true,sameSite:'strict',path:'/',maxAge:604800});};
  const sanitizedSettings=async()=>{const value=await db.settings();delete value.embedding.apiKey;value.embedding.hasApiKey=secrets.has('embedding');delete value.network.apiKey;delete value.network.clearApiKey;value.network.provider??='searxng';value.network.deepseekBaseUrl??=deepseekBaseUrl;value.network.hasApiKey=secrets.has(deepseekSecretId);return value;};
  const models=async()=>(await db.query('SELECT config FROM models ORDER BY config->>\'name\'')).rows.map(r=>{const {apiKey,...value}=r.config;return {...value,hasApiKey:secrets.has('model:'+value.id)};});
  const overview=async()=>{const counts=(await db.query("SELECT (SELECT count(*)::int FROM memories WHERE status='active') memories,(SELECT count(*)::int FROM memories WHERE status IN ('candidate','conflicted')) candidates,(SELECT count(*)::int FROM documents) documents,(SELECT count(*)::int FROM tasks WHERE state IN ('pending','running','retrying')) pending,(SELECT count(*)::int FROM sends WHERE status='unknown') unknown")).rows[0];return {settings:await sanitizedSettings(),models:await models(),chats:await db.chats(),bridge:processStatus(),counts};};
  app.get('/api/health',async()=>({ready,dependencyError,bridge:bridge.status()}));
  app.get('/api/setup/status',async(request)=>{if(!ready)return {ready:false,initialized:false,authenticated:false,error:dependencyError};const initialized=Boolean((await db.query('SELECT 1 FROM admins')).rowCount);const value=request.cookies.liino_session;const authenticated=Boolean(value&&(await db.query('SELECT 1 FROM sessions WHERE id_hash=$1 AND expires_at>now()',[sha(value)])).rowCount);return {ready:true,initialized,authenticated};});
  app.post('/api/setup',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
    if(!ready)return reply.code(503).send({message:'数据库尚未就绪'});const {password}=z.object({password:z.string().min(12).max(200)}).parse(request.body);
    const inserted=await db.query('INSERT INTO admins(id,password_hash) VALUES(1,$1) ON CONFLICT(id) DO NOTHING RETURNING id',[passwordHash(password)]);if(!inserted.rowCount)return reply.code(409).send({message:'管理员已创建，请登录'});await issueSession(reply);return {ok:true};
  });
  app.post('/api/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{if(!ready)return reply.code(503).send({message:'数据库尚未就绪'});const {password}=z.object({password:z.string().max(200)}).parse(request.body);const admin=(await db.query('SELECT password_hash FROM admins WHERE id=1')).rows[0];if(!admin||!passwordMatches(password,admin.password_hash))return reply.code(401).send({message:'密码不正确'});await issueSession(reply);return {ok:true};});
  app.post('/api/logout',async(request,reply)=>{if(request.cookies.liino_session)await db.query('DELETE FROM sessions WHERE id_hash=$1',[sha(request.cookies.liino_session)]);reply.clearCookie('liino_session',{path:'/'});return {ok:true};});
  app.get('/api/bootstrap',overview);
  app.get('/api/events',async(_request,reply)=>{reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});reply.raw.write('event: state\ndata: {}\n\n');clients.add(reply.raw);const heartbeat=setInterval(()=>reply.raw.write(': heartbeat\n\n'),15000);reply.raw.on('close',()=>{clearInterval(heartbeat);clients.delete(reply.raw);});});
  app.get('/api/settings',sanitizedSettings);
  app.put('/api/settings',async(request)=>{
    const input=settingsSchema.parse(request.body);
    for(const id of [input.chatModelId,input.decisionModelId,input.memoryModelId,input.visionModelId].filter(Boolean)){z.uuid().parse(id);await pipeline.model(id);}
    if(input.visionModelId&&!(await pipeline.model(input.visionModelId)).supportsVision)throw Object.assign(new Error('图片识别模型必须支持视觉'),{statusCode:400});
    let embeddingChanged=false,wasPaused=true;
    const next=await db.updateSettings(async old=>{
      const networkKey=input.network.apiKey,hasNetworkKey=Boolean(networkKey)||(!input.network.clearApiKey&&secrets.has(deepseekSecretId));
      if(input.network.enabled&&input.network.provider==='deepseek'&&!hasNetworkKey)throw Object.assign(new Error('请先填写 DeepSeek API 密钥，或关闭联网后保存'),{statusCode:400});
      if(networkKey)await secrets.set(deepseekSecretId,networkKey);else if(input.network.clearApiKey)await secrets.set(deepseekSecretId,'');
      wasPaused=old.paused;embeddingChanged=old.embedding.baseUrl!==input.embedding.baseUrl||old.embedding.model!==input.embedding.model||old.embedding.enabled!==input.embedding.enabled||Boolean(input.embedding.apiKey)||Boolean(input.embedding.clearApiKey);
      if(input.embedding.apiKey)await secrets.set('embedding',input.embedding.apiKey);else if(input.embedding.clearApiKey)await secrets.set('embedding','');
      const {apiKey,hasApiKey,clearApiKey,...embedding}=input.embedding;const {apiKey:networkApiKey,hasApiKey:networkHasApiKey,clearApiKey:networkClearApiKey,...network}=input.network;return {...input,network,embedding:{...embedding,version:embeddingChanged?old.embedding.version+1:old.embedding.version}};
    });
    if(next.paused&&!wasPaused)await pipeline.stopAll();if(embeddingChanged)await knowledge.reindexAll();changed();return sanitizedSettings();
  });
  app.get('/api/models',models);
  async function saveModel(request:any){const id=request.params?.id?z.uuid().parse(request.params.id):randomUUID();const input=modelSchema.parse(request.body);const {apiKey,clearApiKey,pricing,...fields}=input;if(apiKey)await secrets.set('model:'+id,apiKey);else if(clearApiKey)await secrets.set('model:'+id,'');const value={...fields,id,...(pricing?{pricing}:{})};await db.query('INSERT INTO models(id,config) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config',[id,value]);changed();return {...value,hasApiKey:secrets.has('model:'+id)};}
  app.post('/api/models',saveModel);app.put('/api/models/:id',saveModel);
  app.delete('/api/models/:id',async(request)=>{const id=z.uuid().parse((request.params as any).id);await db.query('DELETE FROM models WHERE id=$1',[id]);await secrets.set('model:'+id,'');await db.updateSettings(s=>{for(const key of ['chatModelId','decisionModelId','memoryModelId','visionModelId'] as const)if(s[key]===id)s[key]='';return s;});changed();return {ok:true};});
  app.post('/api/models/:id/test',async(request)=>{const model=await pipeline.model(z.uuid().parse((request.params as any).id));const started=Date.now();const result=await gateway.run({model,apiKey:await secrets.get('model:'+model.id),systemPrompt:'连通性测试。只回复“连接成功”。',input:'请测试文字回复',history:[],tools:[],context:{purpose:'model-test'}});return {ok:true,text:result.text,milliseconds:Date.now()-started};});
  app.get('/api/chats',async()=>db.chats());
  app.post('/api/chats',async(request)=>{const {name}=z.object({name:z.string().trim().min(1).max(150)}).parse(request.body);const chat=await db.createChat({name,bindingKey:'wx4py:group:'+encodeURIComponent(name)});await bridge.configure();changed();return chat;});
  app.patch('/api/chats/:id',async(request)=>{const id=z.uuid().parse((request.params as any).id);const input=z.object({enabled:z.boolean().optional(),proactive:z.boolean().optional(),persona:personaSchema.partial().optional()}).parse(request.body);const result=await db.updateChat(id,input);await pipeline.stopChat(id);await bridge.configure();changed();return result;});
  app.get('/api/chats/:id/messages',async(request)=>db.messages(z.uuid().parse((request.params as any).id)));
  app.post('/api/chats/:id/test',async(request,reply)=>{const id=z.uuid().parse((request.params as any).id),chat=await db.chat(id);if(!chat?.enabled){return reply.code(409).send({message:'请先启用测试群监听'});}const sendId=randomUUID();await pipeline.reply(sendId,id,null,'【WeChatBot工作台测试】微信桥接收发验证 '+sendId.slice(0,8),'admin-test');await pipeline.flushOutbox();return {ok:true,sendId};});
  app.post('/api/chats/:id/verify',async(request,reply)=>{const id=z.uuid().parse((request.params as any).id);const caps=bridge.status().capabilities;const sent=(await db.query("SELECT 1 FROM sends WHERE chat_id=$1 AND kind='admin-test' AND status='sent' AND sent_at>now()-interval '30 minutes'",[id])).rowCount;const incoming=(await db.query("SELECT 1 FROM messages WHERE chat_id=$1 AND direction='in' AND mentioned=true AND created_at>now()-interval '30 minutes'",[id])).rowCount;if(!bridge.status().connected||!caps.groupListening||!caps.mentions||!sent||!incoming)return reply.code(409).send({message:'尚未通过真实收发验收：请确保桥接正常、测试消息发送成功，并在群中 @机器人发送一条测试消息后重试。'});await db.query('UPDATE chats SET verified=true WHERE id=$1',[id]);changed();return {ok:true};});
  app.post('/api/chats/:id/stop',async(request)=>{await pipeline.stopChat(z.uuid().parse((request.params as any).id));return {ok:true};});
  app.get('/api/bridge/status',async()=>processStatus());
  app.post('/api/bridge/start',async(request)=>{
    const {compatibility}=z.object({compatibility:z.boolean().default(false)}).parse(request.body??{});
    if(startingBridge)return {starting:true};
    if(bridge.status().transportConnected||child)return processStatus();
    if(guardian)throw new Error('上次兼容会话仍在恢复，请稍后再启动');
    startingBridge=true;
    try{
      const executable=resolve('.venv/Scripts/python.exe');await access(executable);const logfile=await open(join(options.dataDir,'bridge.log'),'a');
      const spawnOptions={cwd:process.cwd(),windowsHide:true,stdio:['ignore',logfile.fd,logfile.fd] as ['ignore',number,number],env:{...process.env,BRIDGE_TOKEN:token,PYTHONUTF8:'1'}};
      const owned=spawn(executable,['bridge/main.py','run','--store',join(options.dataDir,'bridge.sqlite'),'--url','ws://127.0.0.1:'+options.port+'/bridge'],spawnOptions);child=owned;
      owned.on('error',()=>{void db.log('error','微信桥接启动失败');if(child===owned)child=undefined;void logfile.close();changed();});
      owned.on('exit',()=>{if(child===owned)child=undefined;void logfile.close();changed();});
      if(compatibility&&owned.pid){
        const guard=spawn(executable,['scripts/runtime-accessibility-lease.py','--enable-for-bridge','--watch-bridge-pid',String(owned.pid),'--state-dir',options.dataDir],spawnOptions);guardian=guard;
        const failed=()=>{void db.log('error','临时无障碍兼容未能启用或恢复，请查看data/bridge.log与runtime-accessibility.json');if(child===owned)void stopBridge().catch(()=>{});};
        guard.on('error',failed);guard.on('exit',code=>{if(code!==0)failed();if(guardian===guard)guardian=undefined;changed();});
      }
      changed();return {starting:true,message:compatibility?'已启动临时无障碍兼容桥接，停止时恢复原标志':'已启动本机桥接，正在诊断微信窗口'};
    }finally{startingBridge=false;}
  });
  app.post('/api/bridge/stop',async(_request,reply)=>await stopBridge()?{ok:true,message:'桥接已停止，兼容守护进程已退出'}:reply.code(409).send({message:'没有由工作台启动的桥接；手动启动的桥接请在原窗口停止'}));
  app.post('/api/bridge/refresh',async()=>{await bridge.configure();return bridge.status();});
  app.get('/api/bridge/chats',async()=>bridge.listChats());
  app.post('/bridge/attachments',async(request,reply)=>{
    const actual=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({message:'桥接认证失败'});
    const result=await chatImages.upload(request.body);changed();return result;
  });
  app.get('/api/hunt',async()=>({settings:await getHuntSettings(db),references:await gallery.all(),whitelistMembers:await huntWhitelistMembers(db),matcher:imageMatcher.status()}));
  app.get('/api/hunt/references',async request=>gallery.list(request.query));
  app.post('/api/hunt/references',async request=>{const result=await gallery.upload(request.body);changed();return result;});
  app.get('/api/hunt/references/:id/content',async(request,reply)=>reply.header('Cache-Control','private, max-age=86400').type('image/png').send(await gallery.content((request.params as any).id)));
  app.put('/api/hunt/settings',async(request)=>{const result=await saveHuntSettings(db,request.body,gallery);changed();return result;});
  app.get('/api/hunt/recent',async(request)=>hunt.recent(z.object({chatId:z.uuid().optional()}).parse(request.query).chatId));
  app.get('/api/hunt/queue',async(request)=>huntQueue(db,request.query,modelConcurrency));
  app.get('/api/hunt/images',async(request)=>chatImages.list(z.object({chatId:z.uuid()}).parse(request.query).chatId));
  app.post('/api/hunt/test',async(request)=>{
    const input=z.object({attachmentId:z.uuid(),chatId:z.uuid()}).parse(request.body);
    const image=await chatImages.content(input.attachmentId,input.chatId),settings=await getHuntSettings(db);
    if(!settings.enabledReferenceIds?.length)throw Object.assign(new Error('请先选择至少一张触发图片并保存设置'),{statusCode:400});
    const galleryVersion=await hunt.matchGallery(settings.version),result=await imageMatcher.match({...image,galleryVersion});
    if((await getHuntSettings(db)).version!==settings.version)throw Object.assign(new Error('检测期间图库设置已改变，请重新检测'),{statusCode:409});
    return {...result,threshold:settings.threshold,comparison:'>',trigger:result.similarity>settings.threshold,personaScope:'single-reply'};
  });
  app.get('/bridge',{websocket:true},(socket,request)=>{const value=request.headers.authorization??'';const expected='Bearer '+token;const actualBytes=Buffer.from(value),expectedBytes=Buffer.from(expected);if(actualBytes.length!==expectedBytes.length||!timingSafeEqual(actualBytes,expectedBytes)){socket.close(1008,'unauthorized');return;}bridge.attach(socket);});
  app.post('/api/preview',async(request)=>{const input=z.object({text:z.string().trim().min(1).max(8000),chatId:z.uuid().optional(),persona:personaSchema.optional()}).parse(request.body);return pipeline.preview(input.text,input.chatId,input.persona);});
  app.get('/api/memories',async(request)=>memory.list(request.query as Parameters<MemoryManager['list']>[0]));
  app.post('/api/memories',async(request)=>{const value=memorySchema.parse(request.body);const memory=await db.saveMemory({...value,confidence:1});changed();return memory;});
  app.patch('/api/memories/:id',async(request)=>{const value=memorySchema.parse(request.body);const result=await db.saveMemory({...value,id:z.uuid().parse((request.params as any).id)});changed();return result;});
  app.delete('/api/memories/:id',async(request)=>{await db.deleteMemory(z.uuid().parse((request.params as any).id));changed();return {ok:true};});
  app.get('/api/memories/:id/versions',async(request)=>(await db.query('SELECT version,snapshot,created_at FROM memory_versions WHERE memory_id=$1 ORDER BY version DESC',[z.uuid().parse((request.params as any).id)])).rows);
  app.post('/api/memories/merge',async(request)=>{const input=z.object({ids:z.array(z.uuid()).min(2).max(20).refine(a=>new Set(a).size===a.length),content:z.string().trim().min(1).max(4000),category:memorySchema.shape.category}).parse(request.body);const result=await db.mergeMemories(input.ids,input.content,input.category);changed();return result;});
  app.get('/api/documents',async(request)=>memory.listDocuments(request.query as Parameters<MemoryManager['listDocuments']>[0]));
  app.post('/api/documents',async(request)=>{
    const input=z.object({title:z.string().trim().min(1).max(200),content:z.string().max(500000).optional(),url:z.url().optional(),filename:z.string().max(200).optional(),base64:z.string().max(7000000).optional(),category:z.string().max(50).default('资料'),tags:z.array(z.string().max(50)).max(30).default([])}).parse(request.body);
    let content=input.content??'',source='手动导入',bytes:Buffer|undefined,extension='';
    if(input.url){const page=await fetchPage(input.url);content=page.content;source=page.url;}
    else if(input.base64){bytes=Buffer.from(input.base64,'base64');if(bytes.length>5_000_000)throw new Error('文件不能超过5MB');extension=extname(input.filename??'').toLowerCase();if(!['.txt','.md','.pdf'].includes(extension))throw new Error('仅支持TXT、Markdown和文字型PDF');content=extension==='.pdf'?(await extractText(new Uint8Array(bytes),{mergePages:true})).text:bytes.toString('utf8');source='上传：'+(input.filename??input.title);}
    if(!content.trim())throw new Error('没有可导入的文字；扫描版PDF需要先做文字识别');const document=await knowledge.importDocument({...input,content,source});if(bytes)await writeFile(join(options.dataDir,'attachments',document.id+extension),bytes,{mode:0o600});changed();return document;
  });
  app.delete('/api/documents/:id',async(request)=>{await db.tx(async c=>{await c.query('DELETE FROM documents WHERE id=$1',[z.uuid().parse((request.params as any).id)]);await db.invalidateData(c,['knowledge']);});changed();return {ok:true};});
  app.post('/api/knowledge/search',async(request)=>{const input=z.object({query:z.string().trim().min(1).max(2000),chatId:z.uuid().optional(),memberId:z.uuid().optional()}).parse(request.body);return knowledge.search(input.query,{chatId:input.chatId,memberId:input.memberId});});
  app.post('/api/knowledge/reindex',async()=>{await knowledge.reindexAll();changed();return {ok:true};});
  app.post('/api/embedding/test',async()=>knowledge.embeddingTest());
  app.post('/api/network/search',async(request)=>{const query=z.object({query:z.string().trim().min(1).max(1000)}).parse(request.body).query;const s=await db.settings();if(!s.network.enabled)throw new Error('请先启用并保存联网配置');return createNetworkProvider(s.network,secrets,{onResults:(hits,context)=>knowledge.rememberWebResults(hits,context),settings:()=>getSearchSettings(db),cache,scope:'public'}).search(query);});
  app.post('/api/network/fetch',async(request)=>{const {url}=z.object({url:z.string().trim().min(1).max(8192)}).parse(request.body);const s=await db.settings();if(!s.network.enabled)throw new Error('请先启用并保存联网配置');return createNetworkProvider(s.network,secrets,{onResults:(hits,context)=>knowledge.rememberWebResults(hits,context),cache,scope:'public'}).fetch(url);});
  app.get('/api/tasks',async(request)=>{const q=z.object({status:z.string().max(30).optional()}).parse(request.query);const from="FROM tasks t LEFT JOIN chats c ON c.id=t.chat_id LEFT JOIN outbox o ON o.id=t.id LEFT JOIN sends s ON s.id=CASE WHEN t.kind='send' THEN nullif(o.payload->>'sendId','')::uuid ELSE t.id END LEFT JOIN messages m ON m.id::text=o.payload->>'messageId'";const skip=q.status==='skipped';return pageQuery(db,request.query,'t.*,c.name chat_name,s.status delivery_status,m.state observation_state',from,'t.created_at DESC,t.id',skip?"(t.result->>'status'='skipped' OR (t.kind='chat' AND m.state='observed' AND s.id IS NULL))":q.status?'t.state=$1':'TRUE',q.status&&!skip?[q.status]:[]);});
  app.post('/api/tasks/:id/retry',async(request)=>{await pipeline.retryTask(z.uuid().parse((request.params as any).id));changed();return {ok:true};});
  app.get('/api/sends',async(request)=>{const q=z.object({status:z.string().max(30).optional()}).parse(request.query);return pageQuery(db,request.query,'s.*,c.name chat_name','FROM sends s LEFT JOIN chats c ON c.id=s.chat_id','s.created_at DESC,s.id',q.status?'s.status=$1':'TRUE',q.status?[q.status]:[]);});
  app.post('/api/sends/:id/resolve',async(request,reply)=>{
    const id=z.uuid().parse((request.params as any).id);const {action}=z.object({action:z.enum(['sent','cancel','retry'])}).parse(request.body);
    const resolved=await db.tx(async c=>{
      await c.query('SELECT id FROM memory_control WHERE id=1 FOR SHARE');
      const target=(await c.query('SELECT chat_id FROM sends WHERE id=$1',[id])).rows[0];if(!target)return false;
      await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[target.chat_id]);
      const send=(await c.query('SELECT * FROM sends WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!send||send.status!=='unknown')return false;
      if(action==='sent'){
        await c.query("UPDATE sends SET status='sent',sent_at=now(),detail='管理员核查确认已发送' WHERE id=$1",[id]);
        if(!send.payload_expired)await c.query("INSERT INTO messages(id,event_id,chat_id,content,direction,observed_at,state) VALUES($1,$2,$3,$4,'out',now(),'sent') ON CONFLICT(event_id) DO NOTHING",[randomUUID(),'sent-'+id,send.chat_id,send.content_kind==='image'?'[图片]':send.content]);
      }else{
        await c.query("UPDATE sends SET status='cancelled',detail='管理员核查确认未发送' WHERE id=$1",[id]);
        if(action==='retry'){
          if(send.payload_expired)throw Object.assign(new Error('发送正文已按保留期限清理，不能重试'),{statusCode:409});
          const chat=(await c.query('SELECT generation_epoch FROM chats WHERE id=$1 FOR UPDATE',[send.chat_id])).rows[0],nextId=randomUUID();
          await c.query('INSERT INTO sends(id,chat_id,source_message_id,content,kind,epoch,origin_at,content_kind,asset_id,parent_id,actor_member_id,reply_priority,review_version,reply_mode,mode_version,attachment_id,hunt_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[nextId,send.chat_id,send.source_message_id,send.content,send.kind,send.kind==='hunt'?send.epoch:chat.generation_epoch,send.origin_at??send.created_at,send.content_kind,send.asset_id,send.parent_id,send.actor_member_id,send.reply_priority,send.review_version,send.reply_mode,send.mode_version,send.attachment_id,send.hunt_version]);
          await db.addJob(c,'send',send.chat_id,{sendId:nextId,priority:send.reply_priority},'send-'+nextId);
        }
      }
      await c.query("UPDATE tasks t SET state=$2,updated_at=now() FROM outbox o WHERE o.id=t.id AND o.kind='send' AND o.payload->>'sendId'=$1",[id,action==='sent'?'completed':'cancelled']);
      return true;
    });
    if(!resolved)return reply.code(409).send({message:'该记录已被核查或不是待核查状态'});changed();return {ok:true};
  });
  app.get('/api/logs',async(request)=>{const q=z.object({level:z.string().max(20).optional()}).parse(request.query);return pageQuery(db,request.query,'*','FROM runtime_logs','id DESC',q.level?'level=$1':'TRUE',q.level?[q.level]:[]);});
  await registerRevampRoutes(app,{db,memory,members,community,media,usage,cache,changed});
  try{await access(join(options.webDir,'index.html'));await app.register(fastifyStatic,{root:options.webDir});app.setNotFoundHandler((request,reply)=>request.method==='GET'&&!request.url.startsWith('/api/')?reply.sendFile('index.html'):reply.code(404).send({message:'接口不存在'}));}catch{}
  if(options.startWorkers){if(ready)await pipeline.start();retryTimer=setInterval(()=>{if(!ready)void db.migrate().then(async()=>{ready=true;dependencyError='';await pipeline.start();changed();}).catch(e=>{dependencyError=safeError(e);});},15000);}
  app.addHook('onClose',async()=>{if(retryTimer)clearInterval(retryTimer);for(const response of clients)response.end();try{await stopBridge();}finally{bridge.close();imageMatcher.close();await pipeline.close();await cache.close();await db.close();}});
  return {app,db,pipeline,bridge,knowledge,secrets,memory,members,community,media,chatImages,hunt,imageMatcher,gallery,usage,cache};
}
