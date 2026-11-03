import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../apps/server/db.js';
import {createApp} from '../apps/server/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('authenticated hunt configuration and local-only detection API',()=>{
 let runtime:Awaited<ReturnType<typeof createApp>>,admin:Database,schema:string,dir:string,cookie:string,chat:any,attachmentId:string;let calls=0;
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw Error('Requires liino_test');schema='hunt_api_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');dir=await mkdtemp(join(tmpdir(),'hunt-api-'));
  runtime=await createApp({databaseUrl:url.href,dataDir:dir,startWorkers:false,bridgeToken:'test-only-bridge-token-abcdefghijklmnopqrstuvwxyz',imageMatcher:{match:async()=>{calls++;return {status:'ok',metric:'cosine_similarity',calibrated:false,similarity:0.81,matchedReference:'reference-01',category:'合成表情',matches:[]};},close:()=>{},status:()=>({running:true,ready:true,referenceCount:8})}});
  // 此套件验证已有素材的检测接口；首次安装空图库由独立测试覆盖。
  await runtime.db.query("INSERT INTO hunt_references(id,name,source,category,path,digest,thumbnail) VALUES('reference-01','合成图片','builtin','合成测试','unused','fixture','unused')");
  await runtime.db.query("UPDATE settings SET value=value||$1::jsonb WHERE key='hunt'",[JSON.stringify({enabled:true,enabledReferenceIds:['reference-01']})]);
  const setup=await runtime.app.inject({method:'POST',url:'/api/setup',payload:{password:'test-long-password-hunt-only'}});expect(setup.statusCode).toBe(200);cookie=setup.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  chat=await runtime.db.createChat({name:'检测接口夹具',bindingKey:randomUUID()});const eventId=randomUUID();attachmentId=randomUUID();await runtime.pipeline.ingest({eventId,chatId:chat.id,accountId:'test',content:'[图片]',type:'image',isSelf:false,mentioned:false,observedAt:new Date().toISOString(),image:{attachmentId,status:'pending',quality:'thumbnail'}});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
  const payload={attachmentId,eventId,chatId:chat.id,mimeType:'image/png',width:3,height:2,sha256:createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),quality:'thumbnail',data:png};
  expect((await runtime.app.inject({method:'POST',url:'/bridge/attachments',headers:{cookie},payload})).statusCode).toBe(401);
  expect((await runtime.app.inject({method:'POST',url:'/bridge/attachments',headers:{authorization:'Bearer test-only-bridge-token-abcdefghijklmnopqrstuvwxyz'},payload})).statusCode).toBe(200);
 });
 afterAll(async()=>{await runtime?.app.close();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}if(dir?.startsWith(join(tmpdir(),'hunt-api-')))await rm(dir,{recursive:true,force:true});});
 it('requires admin login and rejects cross-origin configuration writes',async()=>{
  expect((await runtime.app.inject({url:'/api/hunt'})).statusCode).toBe(401);
  expect((await runtime.app.inject({method:'PUT',url:'/api/hunt/settings',headers:{cookie,origin:'https://evil.invalid'},payload:{}})).statusCode).toBe(403);
  const settings=(await runtime.app.inject({url:'/api/hunt',headers:{cookie}})).json().settings;
  expect(settings).toMatchObject({enabled:true,threshold:0.75});
  expect((await runtime.app.inject({method:'PUT',url:'/api/hunt/settings',headers:{cookie},payload:{...settings,threshold:2}})).statusCode).toBe(400);
  expect((await runtime.app.inject({method:'PUT',url:'/api/hunt/settings',headers:{cookie},payload:{...settings,threshold:0.8}})).statusCode).toBe(200);
  expect((await runtime.app.inject({method:'PUT',url:'/api/hunt/settings',headers:{cookie},payload:settings})).statusCode).toBe(409);
 });
 it('detects stored bytes without generating or sending a reply',async()=>{
  const response=await runtime.app.inject({method:'POST',url:'/api/hunt/test',headers:{cookie},payload:{chatId:chat.id,attachmentId}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({similarity:0.81,threshold:0.8,trigger:true,calibrated:false});expect(calls).toBe(1);
  expect((await runtime.db.query('SELECT count(*)::int n FROM sends')).rows[0].n).toBe(0);
  expect((await runtime.db.query("SELECT count(*)::int n FROM outbox WHERE kind='reply'")).rows[0].n).toBe(0);
 });
 it('lists capture failures and pending uploads with scoped counts and real pagination',async()=>{
  expect((await runtime.app.inject({url:'/api/hunt/queue'})).statusCode).toBe(401);
  for(const query of ['page=0','pageSize=30','stage=fake','chatId=bad'])expect((await runtime.app.inject({url:'/api/hunt/queue?'+query,headers:{cookie}})).statusCode).toBe(400);
  const other=await runtime.db.createChat({name:'队列隔离群',bindingKey:randomUUID()});
  const ingest=async(chatId:string,status:'pending'|'unavailable')=>{
   const id=randomUUID();await runtime.pipeline.ingest({eventId:randomUUID(),chatId,accountId:'test',content:'[动画表情]',type:'image',isSelf:false,mentioned:false,observedAt:new Date().toISOString(),image:{attachmentId:id,status,quality:'thumbnail',...(status==='unavailable'?{reason:'无法安全取得图片区域'}:{})}});return id;
  };
  const failed=await ingest(chat.id,'unavailable');for(let i=0;i<22;i++)await ingest(chat.id,'pending');await ingest(other.id,'pending');
  const get=async(query:string)=>(await runtime.app.inject({url:'/api/hunt/queue?chatId='+chat.id+'&'+query,headers:{cookie}})).json();
  const first=await get('pageSize=20');expect(first.total).toBe(24);expect(first.items).toHaveLength(20);expect(first.capacity).toEqual({model:4,match:1,upload:2});expect(first.summary).toMatchObject({capture_failed:1,waiting_upload:22,skipped:1});expect(first.items.every((i:any)=>i.chatId===chat.id)).toBe(true);
  const second=await get('page=2&pageSize=20');expect(second.items).toHaveLength(4);expect(new Set([...first.items,...second.items].map((i:any)=>i.attachmentId)).size).toBe(24);
  const failures=await get('stage=capture_failed&pageSize=50');expect(failures.total).toBe(1);expect(failures.items[0]).toMatchObject({attachmentId:failed,stage:'capture_failed',reason:'无法安全取得图片区域',detectTaskId:null});expect(failures.summary.waiting_upload).toBe(22);
  expect((await get('stage=active&pageSize=100')).total).toBe(22);
 });
 it('shows exhausted send attempts as failed instead of active queued sending',async()=>{
  const detectId=await runtime.db.enqueue('hunt-detect',chat.id,{},'queue-detect-fixture');
  const replyId=await runtime.db.enqueue('hunt-reply',chat.id,{},'queue-reply-fixture');
  const sendId=randomUUID();await runtime.db.query("INSERT INTO sends(id,chat_id,content,kind,attachment_id,epoch) VALUES($1,$2,'fixture','hunt',$3,0)",[sendId,chat.id,attachmentId]);
  const sendTask=await runtime.db.enqueue('send',chat.id,{sendId},'send-'+sendId);
  await runtime.db.query("UPDATE chat_images SET hunt_detect_task_id=$2,hunt_reply_task_id=$3,hunt_progress=jsonb_build_object('stage','queued_send') WHERE id=$1",[attachmentId,detectId,replyId]);
  await runtime.db.query("UPDATE tasks SET state='completed' WHERE id=ANY($1::uuid[])",[[detectId,replyId]]);
  await runtime.db.query("UPDATE tasks SET state='failed',attempts=3,error='微信桥接尚未就绪，确认未发送' WHERE id=$1",[sendTask]);
  const response=(await runtime.app.inject({url:'/api/hunt/queue?chatId='+chat.id+'&stage=failed',headers:{cookie}})).json();
  expect(response.total).toBe(1);expect(response.items[0]).toMatchObject({attachmentId,stage:'failed',attempts:3,reason:'微信桥接尚未就绪，确认未发送'});
  expect(response.summary.queued_send).toBe(0);
 });
 it('rejects a mismatched group and an expired attachment before matching',async()=>{
  const other=await runtime.db.createChat({name:'其他群',bindingKey:randomUUID()});
  expect((await runtime.app.inject({method:'POST',url:'/api/hunt/test',headers:{cookie},payload:{chatId:other.id,attachmentId}})).statusCode).toBe(410);
  await runtime.db.query("UPDATE chat_images SET observed_at=now()-interval '31 days' WHERE id=$1",[attachmentId]);
  expect((await runtime.app.inject({method:'POST',url:'/api/hunt/test',headers:{cookie},payload:{chatId:chat.id,attachmentId}})).statusCode).toBe(410);expect(calls).toBe(1);
 });
});
