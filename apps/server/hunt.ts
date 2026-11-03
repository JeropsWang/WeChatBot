/** 根据群成员、白名单和图库快照决定图片触发。余弦相似度不是概率；生成前与发送前均须检查最新白名单及取消状态。 */
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {Database} from './db.js';
import type {MembersService} from './members.js';
import type {ImageMatchResult} from './image-matcher.js';
import type {ReplyContext} from './pipeline.js';
import {setHuntProgress} from './hunt-queue.js';
import {referenceIds,type HuntGallery} from './hunt-gallery.js';

const error=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const whitelistEntry=z.object({chatId:z.uuid(),memberId:z.uuid()}).strict();
export const huntSettingsInput=z.object({enabled:z.boolean(),threshold:z.number().finite().min(0).max(1),cooldownSeconds:z.number().int().min(0).max(3600),prompt:z.string().trim().min(1).max(10000),version:z.number().int().positive(),whitelist:z.array(whitelistEntry).max(1000).optional(),enabledReferenceIds:referenceIds.optional(),deletedReferenceIds:referenceIds.optional()});
export type HuntSettings=Omit<z.infer<typeof huntSettingsInput>,'whitelist'>&{enabledAt:string;whitelist:z.infer<typeof whitelistEntry>[];galleryVersion?:string};
type Queryable={query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>};
export async function getHuntSettings(db:Queryable):Promise<HuntSettings>{const value=(await db.query("SELECT value FROM settings WHERE key='hunt'")).rows[0].value;return {...value,whitelist:value.whitelist??[]};}
export const isHuntWhitelisted=(settings:HuntSettings,chatId:string,memberId?:string|null)=>Boolean(memberId&&settings.whitelist.some(item=>item.chatId===chatId&&item.memberId===memberId));
export async function huntWhitelistMembers(db:Queryable){
 return (await db.query(`SELECT m.chat_id "chatId",m.id "memberId",m.nickname,m.number FROM members m JOIN settings s ON s.key='hunt'
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.value->'whitelist','[]'::jsonb)) entry WHERE entry->>'chatId'=m.chat_id::text AND entry->>'memberId'=m.id::text) ORDER BY m.chat_id,m.number`)).rows;
}
export async function saveHuntSettings(db:Database,input:unknown,gallery?:HuntGallery){
 const value=huntSettingsInput.parse(input);
 let prepared:string|undefined;
 try{
 if(gallery){const old=await getHuntSettings(db);if(old.version!==value.version)throw error('追猎设置已被修改，请刷新后重试；当前草稿未保存',409);prepared=await gallery.stage(old,value);}
 const result=await db.tx(async c=>{
  await gallery?.lock(c);
  await c.query('SELECT id FROM memory_control WHERE id=1 FOR SHARE');
  await c.query('SELECT id FROM chats ORDER BY id FOR UPDATE');
  const old=(await c.query("SELECT value FROM settings WHERE key='hunt' FOR UPDATE")).rows[0].value as HuntSettings;
  if(old.version!==value.version)throw error('追猎设置已被修改，请刷新后重试；当前草稿未保存',409);
  const entries=value.whitelist??old.whitelist??[];
  const whitelist=[...new Map(entries.map(entry=>[entry.chatId+':'+entry.memberId,entry])).values()];
  if(whitelist.length){
   const valid=(await c.query(`SELECT m.id FROM members m JOIN jsonb_to_recordset($1::jsonb) AS entry("chatId" uuid,"memberId" uuid) ON m.chat_id=entry."chatId" AND m.id=entry."memberId"`,[JSON.stringify(whitelist)])).rowCount;
   if(valid!==whitelist.length)throw error('白名单中的群成员不存在或不属于所选群聊，请刷新成员列表');
  }
  const selection=gallery?await gallery.save(c,old,value,prepared!):{enabledReferenceIds:old.enabledReferenceIds,galleryVersion:old.galleryVersion};
  const {deletedReferenceIds:_deleted,...persisted}=value;
  const next={...persisted,...selection,whitelist,version:old.version+1,enabledAt:value.enabled&&!old.enabled?new Date().toISOString():old.enabledAt};
  await c.query("UPDATE settings SET value=$1 WHERE key='hunt'",[next]);
  await c.query("UPDATE sends SET status='cancelled',detail='追猎设置已改变' WHERE hunt_version IS NOT NULL AND status='pending'");
  await c.query("UPDATE tasks t SET state='cancelled',updated_at=now() FROM outbox o WHERE o.id=t.id AND o.kind IN ('reply','hunt-detect','hunt-reply') AND o.payload->>'hunt'='true' AND t.state IN ('pending','retrying','running')");
  await c.query("UPDATE messages m SET state='observed' FROM chat_images i WHERE i.message_id=m.id AND m.state='pending' AND i.hunt_result->>'status' IN ('queued','matched')");
  return next;
 });if(prepared)gallery?.committed(prepared);return result;}catch(e){if(prepared)gallery?.discard(prepared);throw e;}
}

/** Business rules stay in the service; a model's claimed trigger is never trusted. */
export class HuntService {
 constructor(private db:Database,private members:MembersService,private gallery?:HuntGallery){}
 async matchGallery(version:number){const settings=await getHuntSettings(this.db);if(settings.version!==version)throw error('图库设置已改变',409);if(this.gallery&&!settings.galleryVersion)throw error('触发图库尚未准备就绪',503);if(settings.galleryVersion){await this.gallery?.prepare(settings.galleryVersion);const current=await getHuntSettings(this.db);if(current.version!==version){this.gallery?.discard(settings.galleryVersion);throw error('图库设置已改变',409);}}return settings.galleryVersion;}
 async baseSource(attachmentId:string,chatId:string,c:Queryable=this.db){
  const row=(await c.query(`SELECT i.*,m.raw,m.seq,m.state,m.direction,m.created_at message_created_at,
   ch.enabled,ch.verified,ch.generation_epoch current_generation_epoch,ch.memory_reset_seq,
   g.reset_at,me.nickname,me.number member_number,me.identity_status,
   u.appearance_hash current_appearance_hash,u.evidence_version current_evidence_version
   FROM chat_images i JOIN messages m ON m.id=i.message_id AND m.chat_id=i.chat_id
   JOIN chats ch ON ch.id=i.chat_id CROSS JOIN memory_control g
   LEFT JOIN members me ON me.id=i.owner_member_id AND me.chat_id=i.chat_id
   LEFT JOIN member_ui_evidence u ON u.member_id=me.id AND u.chat_id=me.chat_id
   WHERE i.id=$1 AND i.chat_id=$2 AND g.id=1`,[attachmentId,chatId])).rows[0];
  if(!row||row.status!=='ready'||row.direction!=='in'||!row.enabled||!row.verified||row.generation_epoch!==row.current_generation_epoch)return;
  if(new Date(row.observed_at).getTime()<Date.now()-30*86400000||new Date(row.message_created_at).getTime()<Date.now()-30*86400000||new Date(row.observed_at)<=new Date(row.reset_at)||BigInt(row.seq)<=BigInt(row.memory_reset_seq))return;
  return row;
 }
 async source(attachmentId:string,chatId:string,c:Queryable=this.db){
  const row=await this.baseSource(attachmentId,chatId,c);if(!row||!row.owner_member_id||row.identity_status==='conflicted')return;
  const native=row.identity_status==='verified'&&row.raw?.identityStatus==='verified'&&row.raw?.memberId===row.owner_member_id;
  const ui=row.raw?.uiIdentityStatus==='matched'&&row.raw?.uiMemberId===row.owner_member_id&&row.raw?.identitySource==='wechat-ui-profile'&&row.raw?.uiEvidenceVersion===row.current_evidence_version;
  return native||ui?row:undefined;
 }
 async enqueue(c:PoolClient,image:any){
  const settings=await getHuntSettings(c),app=(await c.query("SELECT value FROM settings WHERE key='app'")).rows[0].value;
  if(!settings.enabled||app.paused){await setHuntProgress(c,image.id,'skipped',app.paused?'全局暂停，未进入自动追猎':'追猎开关未开启');return;}
  const source=await this.baseSource(image.id,image.chat_id,c);
  if(!source||new Date(source.observed_at)<new Date(settings.enabledAt)){await setHuntProgress(c,image.id,'skipped','来源已停止、过期、群未验收或图片早于启用边界');return;}
  if(isHuntWhitelisted(settings,source.chat_id,source.owner_member_id)){await setHuntProgress(c,image.id,'skipped','发图者在本群追猎白名单中');return;}
  const identified=await this.source(image.id,image.chat_id,c);
  const auth=identified?await this.members.authorization(source.chat_id,source.owner_member_id,source,c):{allowed:false,version:0};
  const mode=auth.allowed?(await c.query('SELECT mode,updated_at::text version FROM member_modes WHERE chat_id=$1 AND member_id=$2',[source.chat_id,source.owner_member_id])).rows[0]:undefined;
  const plan=mode?.mode==='plan'&&Boolean((await c.query('SELECT 1 FROM plan_members WHERE chat_id=$1 AND member_id=$2',[source.chat_id,source.owner_member_id])).rowCount);
  const context:ReplyContext={memberId:identified?.owner_member_id,mode:mode?.mode==='plan'&&!plan?'normal':mode?.mode??'normal',reviewVersion:mode?auth.version:undefined,modeVersion:mode?.version,priority:plan?1:5,attachmentId:source.id,huntVersion:settings.version};
  const job=await this.db.addJob(c,'hunt-detect',source.chat_id,{hunt:true,chatId:source.chat_id,messageId:source.message_id,attachmentId:source.id,epoch:source.generation_epoch,context,priority:context.priority},'hunt-'+source.id);
  if(job){await c.query("UPDATE messages SET state='pending' WHERE id=$1",[source.message_id]);await c.query("UPDATE chat_images SET hunt_result=$2,hunt_detect_task_id=$3 WHERE id=$1",[source.id,{status:'queued',settingsVersion:settings.version,galleryVersion:settings.galleryVersion},job]);await setHuntProgress(c,source.id,'queued_match','等待本地图像匹配');}
 }
 async intakeValid(attachmentId:string,chatId:string,version:number,c:Queryable=this.db){
  const settings=await getHuntSettings(c),source=await this.baseSource(attachmentId,chatId,c);
  return Boolean(settings.enabled&&settings.version===version&&source&&!isHuntWhitelisted(settings,chatId,source.owner_member_id)&&new Date(source.observed_at)>=new Date(settings.enabledAt));
 }
 async valid(attachmentId:string,chatId:string,memberId:string|undefined,version:number,c:Queryable=this.db){
  const settings=await getHuntSettings(c);if(!settings.enabled||settings.version!==version)return false;
  const source=await this.source(attachmentId,chatId,c);
  return Boolean(source&&source.owner_member_id===memberId&&!isHuntWhitelisted(settings,chatId,source.owner_member_id)&&new Date(source.observed_at)>=new Date(settings.enabledAt));
 }
 async claim(payload:any,result:ImageMatchResult,taskId:string){
  if(!Number.isFinite(result.similarity)||result.similarity< -1||result.similarity>1)throw error('图片匹配分数无效');
  return this.db.tx(async c=>{
   await c.query('SELECT id FROM memory_control WHERE id=1 FOR SHARE');
   await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[payload.chatId]);
   const settings=await getHuntSettings(c),app=(await c.query("SELECT value FROM settings WHERE key='app'")).rows[0].value;
   const source=await this.baseSource(payload.attachmentId,payload.chatId,c);
   if(app.paused||!source||source.state!=='pending'||source.generation_epoch!==payload.epoch||source.message_id!==payload.messageId||!await this.intakeValid(payload.attachmentId,payload.chatId,payload.context.huntVersion,c))return;
   if(this.gallery&&!settings.enabledReferenceIds?.includes(result.matchedReference))throw error('匹配结果不属于当前启用的图库版本',409);
   // Check the numeric value ourselves, even if a detector includes trigger:true.
   const matched=Number.isFinite(result.similarity)&&result.similarity>settings.threshold;
   const identified=await this.source(payload.attachmentId,payload.chatId,c);
   const identityValid=Boolean(identified&&identified.owner_member_id===payload.context.memberId);
   let accepted=matched&&identityValid;
   if(accepted){const claim=await c.query(`INSERT INTO hunt_cooldowns(chat_id,member_id,task_id) VALUES($1,$2,$3)
    ON CONFLICT(chat_id,member_id) DO UPDATE SET task_id=EXCLUDED.task_id,last_trigger_at=now()
    WHERE hunt_cooldowns.task_id=$3 OR hunt_cooldowns.last_trigger_at<=now()-($4*interval '1 second') RETURNING task_id`,[source.chat_id,source.owner_member_id,taskId,settings.cooldownSeconds]);accepted=Boolean(claim.rowCount);}
   const stage=accepted?'queued_reply':!matched?'not_matched':!identityValid?'blocked_identity':'cooldown';
   const reason=accepted?'已匹配，等待生成回复':!matched?'匹配分数未严格超过阈值':!identityValid?'已匹配，但未确认发图者：'+(source.raw?.uiIdentityReason??'未取得当前图片的资料卡凭据'):'同一群友处于冷却期';
   const reference=(await c.query('SELECT name FROM hunt_references WHERE id=$1',[result.matchedReference])).rows[0];
   await c.query('UPDATE chat_images SET hunt_result=$2,hunt_checked_at=now() WHERE id=$1',[source.id,{status:accepted?'matched':stage,similarity:result.similarity,threshold:settings.threshold,matchedReference:result.matchedReference,matchedReferenceName:reference?.name??result.matchedReference,matchedReferencePreviewUrl:reference?'/api/hunt/references/'+encodeURIComponent(result.matchedReference)+'/content':null,galleryVersion:settings.galleryVersion,category:result.category,metric:result.metric,calibrated:false,settingsVersion:settings.version}]);
   await setHuntProgress(c,source.id,stage,reason);
   if(!accepted)await c.query("UPDATE messages SET state='observed' WHERE id=$1 AND state='pending'",[source.message_id]);
   return {accepted,source,settings};
  });
 }
 async recent(chatId?:string){return (await this.db.query(`SELECT i.id attachment_id,i.chat_id,'I'||lpad(i.number::text,4,'0') image_number,me.nickname owner_name,i.hunt_result result,i.hunt_checked_at checked_at,t.state task_state,s.status delivery_status
  FROM chat_images i LEFT JOIN members me ON me.id=i.owner_member_id AND me.chat_id=i.chat_id
  LEFT JOIN outbox o ON o.unique_key='hunt-'||i.id::text LEFT JOIN tasks t ON t.id=o.id
  LEFT JOIN LATERAL (SELECT status FROM sends WHERE attachment_id=i.id AND kind='hunt' ORDER BY created_at DESC LIMIT 1) s ON true
  WHERE i.hunt_result IS NOT NULL AND ($1::uuid IS NULL OR i.chat_id=$1) ORDER BY i.created_at DESC LIMIT 20`,[chatId??null])).rows;}
}
