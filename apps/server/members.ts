/** 按群管理成员、身份证据与权限。昵称相同不代表同一人；只有当前消息的唯一身份依据可写个人记忆，不能从页面识别自动授予权限。 */
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {IncomingMessage} from '../../packages/contracts.js';
import type {Database} from './db.js';
import {avatarDescriptorSchema} from './avatar-descriptor.js';
import {queueMemberCompaction} from './memory-compaction.js';

const error=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type Queryable={query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>};
const profileSchema=z.object({summary:z.string().max(4000).optional(),interests:z.array(z.string().max(200)).max(30).optional(),preferences:z.array(z.string().max(200)).max(30).optional(),communication:z.string().max(2000).optional()}).strict();
const paging=z.object({q:z.string().max(1000).optional(),page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().refine(n=>[20,50,100].includes(n)).default(20)}).strict();
export type MemberFilters=z.input<typeof paging>;
export type MemberProfile=z.infer<typeof profileSchema>;
export type MemberMode='normal'|'jerops'|'plan';
export type ModeCommand='jerops'|'plan'|'cancel';
export interface MemberRecord {id:string;chatId:string;number:number;nickname:string;aliases:string[];identityStatus:'verified'|'unknown'|'conflicted';identitySource:'wechat-database'|'wechat-ui-profile'|'unknown';profile:MemberProfile;impression:{id:string;content:string;tags:string[];updatedAt:string}|null;pinned:boolean;mode:MemberMode;evidence:{id:string;content:string;observedAt:string;sourceMessageId:string|null}[];version:number;manualReview:{status:'unreviewed'|'approved'|'revoked'|'needs-review';version:number;reviewedAt:string|null}}

export function parseModeCommand(text:string,mentioned=false):{name:ModeCommand;argument:string}|null {
  let root=text.trim();
  if(mentioned)root=root.replace(/^@[^\s@]+[\s\u2005]+/u,'').trimStart();
  const match=/^(#JEROPS|\/plan|#CANCEL)(?=$|\s)([\s\S]*)$/iu.exec(root);
  if(!match)return null;
  return {name:match[1].toLowerCase()==='#jerops'?'jerops':match[1].toLowerCase()==='/plan'?'plan':'cancel',argument:match[2].trim()};
}

const like=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
const trustedSql=(a='m')=>`(${a}.identity_status<>'conflicted' AND ((${a}.identity_status='verified' AND NOT EXISTS(SELECT 1 FROM member_reviews r WHERE r.chat_id=${a}.chat_id AND r.member_id=${a}.id AND r.status<>'approved')) OR EXISTS(SELECT 1 FROM member_reviews r JOIN member_ui_evidence u ON u.chat_id=r.chat_id AND u.member_id=r.member_id WHERE r.chat_id=${a}.chat_id AND r.member_id=${a}.id AND r.status='approved' AND u.appearance_hash IS NOT NULL AND r.evidence->>'appearanceHash'=u.appearance_hash AND r.evidence->>'name'=u.name)))`;
const recordSelect=`SELECT m.*,mm.mode saved_mode,${trustedSql()} modes_trusted,
  EXISTS(SELECT 1 FROM member_ui_evidence ui WHERE ui.chat_id=m.chat_id AND ui.member_id=m.id) ui_observed,
  (SELECT jsonb_build_object('status',r.status,'version',r.approval_version,'reviewedAt',r.reviewed_at) FROM member_reviews r WHERE r.chat_id=m.chat_id AND r.member_id=m.id) manual_review,
  EXISTS(SELECT 1 FROM plan_members pm WHERE pm.chat_id=m.chat_id AND pm.member_id=m.id) plan_allowed,
  ARRAY(SELECT memory.content FROM memories memory WHERE memory.status='active' AND memory.visibility='member'
    AND memory.scope_chat_id=m.chat_id AND memory.member_id=m.id ORDER BY memory.pinned DESC,memory.updated_at DESC,memory.id LIMIT 5) derived_contents,
  (SELECT jsonb_build_object('id',memory.id,'content',memory.content,'tags',memory.tags,'updatedAt',memory.updated_at)
    FROM memories memory WHERE memory.status='active' AND memory.visibility='member' AND memory.scope_chat_id=m.chat_id
    AND memory.member_id=m.id AND memory.subject_key='member-impression' ORDER BY memory.updated_at DESC,memory.id LIMIT 1) impression,
  (SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM (SELECT message.id,message.content,message.observed_at "observedAt",message.raw->>'sourceMessageId' "sourceMessageId"
    FROM messages message WHERE message.chat_id=m.chat_id AND message.direction='in'
      AND message.seq>(SELECT memory_reset_seq FROM chats WHERE id=m.chat_id)
      AND ((message.raw->>'memberId'=m.id::text AND message.raw->>'identityStatus'='verified' AND m.identity_status='verified')
        OR (message.raw->>'uiMemberId'=m.id::text AND message.raw->>'uiIdentityStatus'='matched'
          AND (m.identity_status='verified' OR m.sender_key LIKE 'ui-profile:%')))
      ORDER BY message.seq DESC LIMIT 20) e) evidence
  FROM members m LEFT JOIN member_modes mm ON mm.chat_id=m.chat_id AND mm.member_id=m.id`;

export class MembersService {
  constructor(private db:Database){}
  async authorization(chatId:string,memberId:string,message?:any,client?:PoolClient):Promise<{allowed:boolean;version:number}>{
    const row=(await ((client??this.db) as Queryable).query(`SELECT m.identity_status,${trustedSql()} trusted,r.approval_version,r.evidence FROM members m LEFT JOIN member_reviews r ON r.chat_id=m.chat_id AND r.member_id=m.id WHERE m.chat_id=$1 AND m.id=$2`,[chatId,memberId])).rows[0];
    if(!row)return {allowed:false,version:0};
    let allowed=Boolean(row.trusted);
    if(message){const raw=message.raw??{};const sameChat=(message.chat_id??message.chatId)===chatId;
      const verified=sameChat&&raw.identityStatus==='verified'&&raw.memberId===memberId&&row.identity_status==='verified';
      const ui=sameChat&&raw.uiIdentityStatus==='matched'&&raw.uiMemberId===memberId&&raw.identitySource==='wechat-ui-profile'&&row.evidence?.appearanceHash&&raw.uiAppearanceHash===row.evidence.appearanceHash&&(raw.uiObservedAppearanceHash??raw.uiAppearanceHash)===(row.evidence.observedAppearanceHash??row.evidence.appearanceHash);
      allowed=allowed&&Boolean(verified||ui);
    }
    return {allowed,version:row.approval_version??0};
  }
  private async cancelPrivileged(c:PoolClient,chatId:string,memberId:string){
    await c.query('DELETE FROM member_modes WHERE chat_id=$1 AND member_id=$2',[chatId,memberId]);
    await c.query('DELETE FROM plan_members WHERE chat_id=$1 AND member_id=$2',[chatId,memberId]);
    await c.query("UPDATE sends SET status='cancelled',detail='成员核实或权限已撤销' WHERE chat_id=$1 AND actor_member_id=$2 AND status='pending' AND coalesce(to_jsonb(sends)->>'reply_mode','normal') IN ('plan','jerops')",[chatId,memberId]);
  }
  private async invalidateReview(c:PoolClient,chatId:string,memberId:string){
    const row=(await c.query("UPDATE member_reviews SET status='needs-review',approval_version=approval_version+1,reviewed_at=now() WHERE chat_id=$1 AND member_id=$2 AND status='approved' RETURNING *",[chatId,memberId])).rows[0];
    if(row){await c.query('INSERT INTO member_review_audit(chat_id,member_id,status,approval_version,evidence) VALUES($1,$2,$3,$4,$5)',[chatId,memberId,row.status,row.approval_version,row.evidence]);await this.cancelPrivileged(c,chatId,memberId);await this.invalidate(c,chatId,memberId);}
  }
  async reviewMember(chatId:string,memberId:string,input:{action:'approve'|'revoke';evidenceMessageId?:string}){
    const value=z.object({action:z.enum(['approve','revoke']),evidenceMessageId:z.string().uuid().optional()}).strict().parse(input);
    await this.db.tx(async c=>{
      await this.lockedChat(c,chatId);
      const member=(await c.query('SELECT * FROM members WHERE chat_id=$1 AND id=$2 FOR UPDATE',[chatId,memberId])).rows[0];if(!member)throw error('群成员不存在',404);
      let evidence:any={};
      if(value.action==='approve'){
        const ui=(await c.query('SELECT * FROM member_ui_evidence WHERE chat_id=$1 AND member_id=$2 FOR SHARE',[chatId,memberId])).rows[0];
        if(member.identity_status!=='verified'&&(!ui?.appearance_hash||!ui.source_event_id))throw error('缺少可核实的资料卡与外观证据，请等待成员重新发言',409);
        const source=(await c.query(`SELECT * FROM messages WHERE chat_id=$1 AND direction='in' AND ($2::uuid IS NULL OR id=$2) AND ((raw->>'identityStatus'='verified' AND raw->>'memberId'=$3) OR (raw->>'uiIdentityStatus'='matched' AND raw->>'identitySource'='wechat-ui-profile' AND raw->>'uiMemberId'=$3 AND raw->>'uiAppearanceHash'=$4 AND $4::text IS NOT NULL)) ORDER BY seq DESC LIMIT 1 FOR SHARE`,[chatId,value.evidenceMessageId??null,memberId,ui?.appearance_hash??null])).rows[0];
        if(!source)throw error('缺少当前群可确认的真实消息依据',409);
        const duplicate=(await c.query('SELECT id FROM members WHERE chat_id=$1 AND id<>$2 AND (nickname=$3 OR aliases ? $3) LIMIT 1',[chatId,memberId,member.nickname])).rowCount;
        if(member.identity_status==='conflicted'||duplicate)throw error('当前身份存在冲突，请先区分同名成员',409);
        evidence={name:ui?.name??member.nickname,appearanceHash:ui?.appearance_hash??null,observedAppearanceHash:source.raw?.uiObservedAppearanceHash??ui?.appearance_hash??null,eventId:source.event_id,sourceMessageId:source.id,observedAt:source.observed_at,source:member.identity_status==='verified'?'wechat-database':'wechat-ui-profile'};
      }
      const row=(await c.query(`INSERT INTO member_reviews(chat_id,member_id,status,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,member_id) DO UPDATE SET status=EXCLUDED.status,evidence=CASE WHEN EXCLUDED.status='approved' THEN EXCLUDED.evidence ELSE member_reviews.evidence END,approval_version=member_reviews.approval_version+1,reviewed_at=now() RETURNING *`,[chatId,memberId,value.action==='approve'?'approved':'revoked',evidence])).rows[0];
      await c.query('INSERT INTO member_review_audit(chat_id,member_id,status,approval_version,evidence) VALUES($1,$2,$3,$4,$5)',[chatId,memberId,row.status,row.approval_version,row.evidence]);
      if(value.action==='revoke')await this.cancelPrivileged(c,chatId,memberId);
      await this.invalidate(c,chatId,memberId);
    });return this.detail(chatId,memberId);
  }
  async resolveUiName(chatId:string,name:string,appearanceHash?:string,eventId?:string,client?:PoolClient,appearanceDescriptor?:unknown){
    const nickname=z.string().trim().min(1).max(200).parse(name);
    if(appearanceHash!==undefined)z.string().regex(/^[a-f0-9]{64}$/).parse(appearanceHash);
    if(eventId!==undefined)z.string().min(1).max(150).parse(eventId);
    const descriptor=appearanceDescriptor===undefined?undefined:avatarDescriptorSchema.parse(appearanceDescriptor);
    const work=async(c:PoolClient)=>{
      await this.lockedChat(c,chatId);
      if(eventId&&(await c.query("SELECT raw->>'memberDeleted' deleted FROM messages WHERE chat_id=$1 AND event_id=$2",[chatId,eventId])).rows[0]?.deleted==='true')return {status:'unknown' as const,reason:'该消息关联的成员已删除'};
      const rows=(await c.query('SELECT * FROM members WHERE chat_id=$1 AND (nickname=$2 OR aliases ? $2) ORDER BY number LIMIT 2 FOR UPDATE',[chatId,nickname])).rows;
      if(rows.length>1){for(const candidate of rows){await this.invalidateReview(c,chatId,candidate.id);await c.query('UPDATE member_ui_evidence SET evidence_version=evidence_version+1 WHERE member_id=$1 AND chat_id=$2',[candidate.id,chatId]);}return {status:'ambiguous' as const,reason:'当前群有同名成员'};}
      let row=rows[0];
      let canonicalHash=appearanceHash;
      if(row){
        if(row.identity_status==='conflicted'||(row.identity_status!=='verified'&&!row.sender_key?.startsWith('ui-profile:'))){await this.invalidateReview(c,chatId,row.id);return {status:'unknown' as const,reason:'成员身份来源不可用'};}
        const evidence=(await c.query('SELECT appearance_hash,appearance_descriptor FROM member_ui_evidence WHERE member_id=$1 AND chat_id=$2 FOR UPDATE',[row.id,chatId])).rows;
        canonicalHash=evidence[0]?.appearance_hash??appearanceHash;
      }else{
        const sequence=(await c.query('UPDATE chats SET member_sequence=greatest(member_sequence,(SELECT coalesce(max(number),0) FROM members WHERE chat_id=$1))+1 WHERE id=$1 RETURNING member_sequence',[chatId])).rows[0].member_sequence;
        row=(await c.query("INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status) VALUES($1,$2,$3,$4,$5,'unknown') RETURNING *",[randomUUID(),chatId,sequence,'ui-profile:'+randomUUID(),nickname])).rows[0];
      }
      // Ordinary attribution uses the unique live profile name in this group.
      // Preserve old appearance evidence solely for the independent permission audit.
      const accepted=(await c.query(`INSERT INTO member_ui_evidence(member_id,chat_id,name,appearance_hash,source_event_id,confirmation,appearance_descriptor)
        VALUES($1,$2,$3,$4,$5,'{}',$6) ON CONFLICT(member_id) DO UPDATE SET name=EXCLUDED.name,
        appearance_hash=coalesce(member_ui_evidence.appearance_hash,EXCLUDED.appearance_hash),appearance_descriptor=coalesce(member_ui_evidence.appearance_descriptor,EXCLUDED.appearance_descriptor),source_event_id=EXCLUDED.source_event_id RETURNING evidence_version`,[row.id,chatId,nickname,appearanceHash??null,eventId??null,descriptor??null])).rows[0];
      await this.invalidate(c,chatId,row.id);
      return {status:'matched' as const,memberId:row.id as string,number:row.number as number,nickname:row.nickname as string,appearanceHash:canonicalHash,evidenceVersion:accepted.evidence_version as number};
    };return client?work(client):this.db.tx(work);
  }
  async confirmUiName(chatId:string,taskId:string):Promise<MemberRecord>{
    z.string().uuid().parse(taskId);
    const memberId=await this.db.tx(async c=>{
      await this.lockedChat(c,chatId);
      const saved=(await c.query(`SELECT member_id id FROM member_ui_evidence WHERE chat_id=$1 AND (confirmation->>'taskId'=$2 OR (confirmation->'tasks') ? $2) LIMIT 1`,[chatId,taskId])).rows[0];
      if(saved)return saved.id as string;
      const evidence=(await c.query(`SELECT t.result,m.id source_message_id FROM tasks t JOIN outbox o USING(id)
        JOIN messages m ON m.event_id=o.payload->>'eventId' AND m.chat_id=o.chat_id
        WHERE t.id=$1 AND o.chat_id=$2 AND t.chat_id=$2 AND o.kind='identity-status' AND t.state='completed'
        AND m.direction='in' AND m.content='认人实时测试' AND coalesce(m.raw->>'memberDeleted','false')<>'true'
        AND t.updated_at>now()-interval '24 hours'`,[taskId,chatId])).rows[0];
      if(!evidence||evidence.result?.status!=='candidate'||evidence.result?.identitySource!=='wechat-ui-profile')throw error('没有当前群可确认的资料卡名称',409);
      const name=z.string().trim().min(1).max(200).parse(evidence.result.name);
      const rows=(await c.query('SELECT * FROM members WHERE chat_id=$1 AND (nickname=$2 OR aliases ? $2) ORDER BY number LIMIT 2 FOR UPDATE',[chatId,name])).rows;
      if(rows.length>1)throw error('当前群有同名成员，请先人工区分',409);
      let row=rows[0];
      if(!row){
        const sequence=(await c.query('UPDATE chats SET member_sequence=greatest(member_sequence,(SELECT coalesce(max(number),0) FROM members WHERE chat_id=$1))+1 WHERE id=$1 RETURNING member_sequence',[chatId])).rows[0].member_sequence;
        row=(await c.query("INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status) VALUES($1,$2,$3,$4,$5,'unknown') RETURNING *",[randomUUID(),chatId,sequence,'ui-profile:'+randomUUID(),name])).rows[0];
      }
      const confirmation={taskId,sourceMessageId:evidence.source_message_id,name,identitySource:'wechat-ui-profile',confirmedAt:new Date().toISOString()};
      await c.query(`INSERT INTO member_ui_evidence(member_id,chat_id,name,confirmation) VALUES($1,$2,$3,$4)
        ON CONFLICT(member_id) DO UPDATE SET confirmation=member_ui_evidence.confirmation || jsonb_build_object('tasks',
          coalesce(member_ui_evidence.confirmation->'tasks','{}'::jsonb) || (EXCLUDED.confirmation->'tasks'))`,[row.id,chatId,name,{...confirmation,tasks:{[taskId]:confirmation}}]);
      await this.invalidate(c,chatId,row.id);return row.id as string;
    });
    return this.detail(chatId,memberId);
  }
  async matchUiName(chatId:string,name:string){
    const nickname=z.string().trim().min(1).max(200).parse(name);
    const rows=(await this.db.query('SELECT id,number,nickname FROM members WHERE chat_id=$1 AND (nickname=$2 OR aliases ? $2) ORDER BY number LIMIT 2',[chatId,nickname])).rows;
    if(rows.length!==1)return {status:rows.length?'ambiguous' as const:'new' as const};
    return {status:'matched' as const,memberId:rows[0].id as string,number:rows[0].number as number,nickname:rows[0].nickname as string};
  }
  private async lockedChat(c:PoolClient,chatId:string){await c.query('SELECT epoch FROM memory_control WHERE id=1 FOR SHARE');if(!(await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[chatId])).rowCount)throw error('群聊不存在',404);}
  private async invalidate(c:PoolClient,chatId:string,memberId?:string){await this.db.invalidateData(c,['members','chat:'+chatId,...(memberId?['member:'+chatId+':'+memberId]:[])]);}
  async observe(event:IncomingMessage,client?:PoolClient):Promise<IncomingMessage>{
    const unknown={...event,memberId:null,identityStatus:'unknown' as const};
    if(event.isSelf||event.identityStatus!=='verified'||event.identitySource!=='wechat-database'||![event.senderId,event.sourceMessageId,event.nativeChatId,event.accountId].every(value=>typeof value==='string'&&value.trim()))return unknown;
    const work=async(c:PoolClient):Promise<IncomingMessage>=>{
      await this.lockedChat(c,event.chatId);
      const binding=(await c.query("SELECT chat_id FROM identity_bindings WHERE chat_id=$1 AND account_id=$2 AND native_chat_id=$3 AND source='wechat-database' AND approved=true AND verified_at IS NOT NULL FOR SHARE",[event.chatId,event.accountId,event.nativeChatId])).rows[0];
      if(!binding)return unknown;
      const senderKey=createHash('sha256').update(JSON.stringify([event.accountId,event.senderId])).digest('hex');
      let row=(await c.query('SELECT * FROM members WHERE chat_id=$1 AND sender_key=$2 FOR UPDATE',[event.chatId,senderKey])).rows[0];
      const nickname=(event.senderName??'').trim().slice(0,200);
      if(!row){
        const sequence=(await c.query('UPDATE chats SET member_sequence=greatest(member_sequence,(SELECT coalesce(max(number),0) FROM members WHERE chat_id=$1))+1 WHERE id=$1 RETURNING member_sequence',[event.chatId])).rows[0].member_sequence;
        row=(await c.query("INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status) VALUES($1,$2,$3,$4,$5,'verified') RETURNING *",[randomUUID(),event.chatId,sequence,senderKey,nickname])).rows[0];
        await this.invalidate(c,event.chatId,row.id);
      }else if((nickname&&row.nickname!==nickname)||row.identity_status!=='verified'){
        await c.query('INSERT INTO member_profile_versions(member_id,version,snapshot) VALUES($1,$2,$3)',[row.id,row.version,row]);
        const aliases=[...new Set([...(row.aliases as string[]),...(row.nickname&&nickname&&row.nickname!==nickname?[row.nickname]:[])])];
        row=(await c.query("UPDATE members SET nickname=$2,aliases=$3,identity_status='verified',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id,nickname||row.nickname,JSON.stringify(aliases)])).rows[0];
        await this.invalidate(c,event.chatId,row.id);
      }
      return {...event,memberId:row.id,identityStatus:'verified' as const};
    };return client?work(client):this.db.tx(work);
  }
  private async settings(c:Queryable,chatId?:string):Promise<{jeropsPrompt:string;planPrompt:string}>{
    const rows=(await c.query('SELECT scope,value FROM mode_settings WHERE scope=ANY($1::text[])',[['global',...(chatId?['chat:'+chatId]:[])]] )).rows;
    const global=rows.find(row=>row.scope==='global')?.value??{},local=rows.find(row=>row.scope==='chat:'+chatId)?.value??{};
    return {jeropsPrompt:local.jeropsPrompt??global.jeropsPrompt??'',planPrompt:local.planPrompt??global.planPrompt??''};
  }
  private map(row:any,settings:{jeropsPrompt:string;planPrompt:string}):MemberRecord {
    const profile:MemberProfile=row.impression&&!row.pinned?{summary:row.impression.content}:{...row.profile};
    if(!row.pinned&&row.impression)profile.summary=row.impression.content;
    else if(!row.manual_profile&&!row.pinned&&row.derived_contents?.length)profile.summary=Array.from(row.derived_contents.join('\n')).slice(0,1200).join('');
    const allowed=row.modes_trusted&&((row.saved_mode==='jerops'&&Boolean(settings.jeropsPrompt.trim()))||(row.saved_mode==='plan'&&row.plan_allowed&&Boolean(settings.planPrompt.trim())));
    return {id:row.id,chatId:row.chat_id,number:row.number,nickname:row.nickname,aliases:row.aliases,identityStatus:row.identity_status,identitySource:row.sender_key?.startsWith('ui-profile:')&&row.ui_observed?'wechat-ui-profile':row.identity_status==='verified'?'wechat-database':'unknown',profile,impression:row.impression??null,pinned:row.pinned,mode:allowed?row.saved_mode:'normal',evidence:row.evidence??[],version:row.version,manualReview:row.manual_review??{status:'unreviewed',version:0,reviewedAt:null}};
  }
  async list(chatId:string,filters:MemberFilters={}){
    const f=paging.parse(filters),values:any[]=[chatId],clauses=['m.chat_id=$1'];
    if(f.q?.trim()){values.push(like(f.q.trim()));clauses.push(`(m.nickname ILIKE $2 OR m.number::text ILIKE $2 OR m.aliases::text ILIKE $2)`);}
    const where=clauses.join(' AND '),total=Number((await this.db.query('SELECT count(*) total FROM members m WHERE '+where,values)).rows[0].total);
    const settings=await this.modeSettings(chatId);
    const rows=(await this.db.query(recordSelect+' WHERE '+where+` ORDER BY m.number,m.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,f.pageSize,(f.page-1)*f.pageSize])).rows;
    return {items:rows.map(row=>this.map(row,settings)),total,page:f.page,pageSize:f.pageSize};
  }
  async detail(chatId:string,memberId:string):Promise<MemberRecord>{
    const row=(await this.db.query(recordSelect+' WHERE m.chat_id=$1 AND m.id=$2',[chatId,memberId])).rows[0];
    if(!row)throw error('群成员不存在',404);return this.map(row,await this.modeSettings(chatId));
  }
  async create(chatId:string,input:{nickname:string;aliases?:string[]}){
    const value=z.object({nickname:z.string().trim().min(1).max(200),aliases:z.array(z.string().trim().min(1).max(200)).max(30).default([])}).strict().parse(input);
    const id=randomUUID();await this.db.tx(async c=>{
      await this.lockedChat(c,chatId);
      const sequence=(await c.query('UPDATE chats SET member_sequence=greatest(member_sequence,(SELECT coalesce(max(number),0) FROM members WHERE chat_id=$1))+1 WHERE id=$1 RETURNING member_sequence',[chatId])).rows[0].member_sequence;
      await c.query('INSERT INTO members(id,chat_id,number,sender_key,nickname,aliases) VALUES($1,$2,$3,$4,$5,$6)',[id,chatId,sequence,'ui-profile:'+id,value.nickname,JSON.stringify([...new Set(value.aliases)].filter(alias=>alias!==value.nickname))]);
      await this.invalidate(c,chatId,id);
    });return this.detail(chatId,id);
  }
  async compact(chatId:string,memberId:string){
    return this.db.tx(async c=>{await this.lockedChat(c,chatId);
      if(!(await c.query("SELECT id FROM members WHERE chat_id=$1 AND id=$2 AND (identity_status='verified' OR sender_key LIKE 'ui-profile:%') FOR SHARE",[chatId,memberId])).rowCount)throw error('成员不存在或身份尚不可用于记忆',404);
      const epoch=(await c.query('SELECT epoch FROM memory_control WHERE id=1')).rows[0].epoch;
      const taskId=await queueMemberCompaction(this.db,c,chatId,memberId,epoch,true);
      return {taskId,queued:Boolean(taskId),message:taskId?'已排队由 Agent 整理':'暂无至少两条可整合的新记忆，或相同任务已排队'};
    });
  }
  async remove(chatId:string,memberId:string){
    return this.db.tx(async c=>{
      await this.lockedChat(c,chatId);
      if(!(await c.query('SELECT id FROM members WHERE chat_id=$1 AND id=$2 FOR UPDATE',[chatId,memberId])).rowCount)throw error('群成员不存在',404);
      // Invalidate every in-flight reply's epoch before disconnecting the actor.
      await c.query('UPDATE chats SET generation_epoch=generation_epoch+1 WHERE id=$1',[chatId]);
      await c.query(`UPDATE tasks t SET state='cancelled',result=NULL,error=NULL,updated_at=now() FROM outbox o WHERE t.id=o.id AND t.chat_id=$1
        AND t.state IN ('pending','running','retrying','failed') AND (o.payload->>'memberId'=$2 OR o.payload->'replyContext'->>'memberId'=$2
          OR t.kind IN ('chat','route','reply','hunt-detect','hunt-reply','proactive'))`,[chatId,memberId]);
      await c.query("UPDATE sends SET status='cancelled',detail='成员档案已删除' WHERE chat_id=$1 AND status='pending' AND kind<>'admin-test'",[chatId]);
      await c.query('UPDATE sends SET actor_member_id=NULL WHERE actor_member_id=$1',[memberId]);
      await c.query(`UPDATE messages SET raw=(raw-'memberId'-'uiMemberId'-'uiAppearanceHash'-'uiObservedAppearanceHash')||'{"identityStatus":"unknown","uiIdentityStatus":"unknown","memberDeleted":true}'::jsonb,memory_processed_at=now()
        WHERE chat_id=$1 AND (raw->>'memberId'=$2 OR raw->>'uiMemberId'=$2
          OR event_id IN (SELECT source_event_id FROM member_ui_evidence WHERE chat_id=$1 AND member_id=$2::uuid)
          OR id::text IN (SELECT confirmation->>'sourceMessageId' FROM member_ui_evidence WHERE chat_id=$1 AND member_id=$2::uuid
            UNION ALL SELECT item.value->>'sourceMessageId' FROM member_ui_evidence ui CROSS JOIN LATERAL jsonb_each(coalesce(ui.confirmation->'tasks','{}'::jsonb)) item
              WHERE ui.chat_id=$1 AND ui.member_id=$2::uuid))`,[chatId,memberId]);
      await c.query('UPDATE chat_images SET owner_member_id=NULL WHERE chat_id=$1 AND owner_member_id=$2',[chatId,memberId]);
      const memoryIds=(await c.query('SELECT id FROM memories WHERE member_id=$1 ORDER BY id FOR UPDATE',[memberId])).rows.map(row=>row.id);
      await c.query('DELETE FROM memory_selections WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot) item WHERE item->>\'id\'=ANY($1::text[]))',[memoryIds]);
      await c.query('DELETE FROM memory_versions WHERE memory_id=ANY($1::uuid[])',[memoryIds]);
      await c.query('UPDATE memories SET supersedes=NULL WHERE supersedes=ANY($1::uuid[])',[memoryIds]);
      await c.query('DELETE FROM memories WHERE member_id=$1',[memberId]);
      for(const table of ['plan_members','member_modes','member_reviews','member_review_audit','member_ui_evidence','hunt_cooldowns'])await c.query(`DELETE FROM ${table} WHERE chat_id=$1 AND member_id=$2`,[chatId,memberId]);
      await c.query('DELETE FROM member_profile_versions WHERE member_id=$1',[memberId]);
      await c.query('DELETE FROM members WHERE chat_id=$1 AND id=$2',[chatId,memberId]);
      await this.db.invalidateData(c,['knowledge','memory','members','chat:'+chatId,'member:'+chatId+':'+memberId]);
      return {deleted:true,deletedMemories:memoryIds.length};
    });
  }
  async update(chatId:string,memberId:string,input:{profile?:MemberProfile;pinned?:boolean;nickname?:string;aliases?:string[]}){
    const value=z.object({profile:profileSchema.optional(),pinned:z.boolean().optional(),nickname:z.string().trim().min(1).max(200).optional(),aliases:z.array(z.string().trim().min(1).max(200)).max(30).optional()}).strict().refine(x=>Object.keys(x).length>0).parse(input);
    await this.db.tx(async c=>{
      await this.lockedChat(c,chatId);const old=(await c.query(recordSelect+' WHERE m.chat_id=$1 AND m.id=$2 FOR UPDATE OF m',[chatId,memberId])).rows[0];
      if(!old)throw error('群成员不存在',404);
      const freezing=value.pinned===true&&!old.pinned;
      const profile=value.profile??(freezing?this.map(old,await this.settings(c,chatId)).profile:old.profile);
      await c.query('INSERT INTO member_profile_versions(member_id,version,snapshot) VALUES($1,$2,$3)',[memberId,old.version,old]);
      await c.query('UPDATE members SET profile=$3,pinned=$4,manual_profile=$5,version=version+1,updated_at=now() WHERE chat_id=$1 AND id=$2',[chatId,memberId,profile,value.pinned??old.pinned,old.manual_profile||value.profile!==undefined||freezing]);
      const nickname=value.nickname??old.nickname,aliases=[...new Set(value.aliases??old.aliases)].filter(alias=>alias!==nickname);
      await c.query('UPDATE members SET nickname=$3,aliases=$4 WHERE chat_id=$1 AND id=$2',[chatId,memberId,nickname,JSON.stringify(aliases)]);
      if(nickname!==old.nickname||JSON.stringify(aliases)!==JSON.stringify(old.aliases)){
        await c.query("UPDATE member_reviews SET status='needs-review',approval_version=approval_version+1 WHERE chat_id=$1 AND member_id=$2",[chatId,memberId]);
        await this.cancelPrivileged(c,chatId,memberId);
      }
      await this.invalidate(c,chatId,memberId);
    });return this.detail(chatId,memberId);
  }
  async history(chatId:string,memberId:string){
    await this.detail(chatId,memberId);
    return (await this.db.query('SELECT id,version,snapshot,created_at "createdAt" FROM member_profile_versions WHERE member_id=$1 ORDER BY version DESC,id DESC',[memberId])).rows.map(row=>{
      const old=row.snapshot;
      return {...row,snapshot:{id:old.id,chatId:old.chat_id,number:old.number,nickname:old.nickname,aliases:old.aliases,identityStatus:old.identity_status,profile:old.profile,pinned:old.pinned,version:old.version}};
    });
  }
  async resetMode(chatId:string,memberId:string){
    await this.db.tx(async c=>{await this.lockedChat(c,chatId);if(!(await c.query('SELECT id FROM members WHERE chat_id=$1 AND id=$2',[chatId,memberId])).rowCount)throw error('群成员不存在',404);await c.query('DELETE FROM member_modes WHERE chat_id=$1 AND member_id=$2',[chatId,memberId]);await this.invalidate(c,chatId,memberId);});
    return this.detail(chatId,memberId);
  }
  async planMembers(chatId:string){return {memberIds:(await this.db.query("SELECT pm.member_id FROM plan_members pm JOIN members m ON m.id=pm.member_id AND m.chat_id=pm.chat_id WHERE pm.chat_id=$1 AND "+trustedSql()+" ORDER BY pm.slot",[chatId])).rows.map(row=>row.member_id as string)};}
  async setPlanMembers(chatId:string,ids:string[]){
    const memberIds=z.array(z.string().uuid()).max(2,'每群最多授权2位计划成员').parse(ids);
    if(new Set(memberIds).size!==memberIds.length)throw error('授权成员不能重复');
    await this.db.tx(async c=>{
      await this.lockedChat(c,chatId);const rows=await c.query(`SELECT m.id FROM members m WHERE m.chat_id=$1 AND m.id=ANY($2::uuid[]) AND ${trustedSql()} FOR SHARE`,[chatId,memberIds]);
      if(rows.rowCount!==memberIds.length)throw error('授权成员必须是当前群已验证的成员');
      await c.query('DELETE FROM plan_members WHERE chat_id=$1',[chatId]);
      for(const [index,id] of memberIds.entries())await c.query('INSERT INTO plan_members(chat_id,slot,member_id) VALUES($1,$2,$3)',[chatId,index+1,id]);
      await c.query("DELETE FROM member_modes WHERE chat_id=$1 AND mode='plan' AND NOT(member_id=ANY($2::uuid[]))",[chatId,memberIds]);
      await this.invalidate(c,chatId);
    });return this.planMembers(chatId);
  }
  async modeSettings(chatId?:string){return this.settings(this.db,chatId);}
  async saveModeSettings(input:{chatId?:string;jeropsPrompt:string|null;planPrompt:string|null}){
    const value=z.object({chatId:z.string().uuid().optional(),jeropsPrompt:z.string().max(20000).nullable(),planPrompt:z.string().max(20000).nullable()}).strict().parse(input);
    await this.db.tx(async c=>{
      if(value.chatId)await this.lockedChat(c,value.chatId);else await c.query('SELECT epoch FROM memory_control WHERE id=1 FOR SHARE');
      const scope=value.chatId?'chat:'+value.chatId:'global';
      await c.query('INSERT INTO mode_settings(scope,value) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET value=EXCLUDED.value',[scope,{jeropsPrompt:value.jeropsPrompt?.trim()??null,planPrompt:value.planPrompt?.trim()??null}]);
      await this.db.invalidateData(c,['modes',...(value.chatId?['chat:'+value.chatId]:['global'])]);
    });return this.modeSettings(value.chatId);
  }
  async modeCommand(chatId:string,memberId:string,command:ModeCommand):Promise<{ok:boolean;reason?:string;mode?:MemberMode;prompt?:string}>{
    z.enum(['jerops','plan','cancel']).parse(command);
    return this.db.tx(async c=>{
      await this.lockedChat(c,chatId);const member=(await c.query(`SELECT m.id FROM members m WHERE m.chat_id=$1 AND m.id=$2 AND ${trustedSql()} FOR SHARE`,[chatId,memberId])).rows[0];
      if(!member)return {ok:false,reason:'需要当前群已验证的成员身份'};
      if(command==='cancel'){await c.query('DELETE FROM member_modes WHERE chat_id=$1 AND member_id=$2',[chatId,memberId]);await this.invalidate(c,chatId,memberId);return {ok:true,mode:'normal'};}
      if(command==='plan'&&!(await c.query('SELECT 1 FROM plan_members WHERE chat_id=$1 AND member_id=$2',[chatId,memberId])).rowCount)return {ok:false,reason:'你还没有获得本群计划模式授权'};
      const settings=await this.settings(c,chatId),prompt=command==='jerops'?settings.jeropsPrompt:settings.planPrompt;
      if(!prompt.trim())return {ok:false,reason:'管理员尚未配置此模式的人格提示词'};
      await c.query('INSERT INTO member_modes(chat_id,member_id,mode) VALUES($1,$2,$3) ON CONFLICT(chat_id,member_id) DO UPDATE SET mode=EXCLUDED.mode,updated_at=now()',[chatId,memberId,command]);
      await this.invalidate(c,chatId,memberId);return {ok:true,mode:command,prompt};
    });
  }
  async activeMode(chatId:string,memberId:string):Promise<{mode:MemberMode;prompt?:string}>{
    return this.db.tx(async c=>{
      await c.query('SELECT epoch FROM memory_control WHERE id=1 FOR SHARE');
      if(!(await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[chatId])).rowCount)return {mode:'normal'};
      const row=(await c.query(recordSelect+' WHERE m.chat_id=$1 AND m.id=$2',[chatId,memberId])).rows[0];
      if(!row)return {mode:'normal'};
      const settings=await this.settings(c,chatId),member=this.map(row,settings);
      if(member.mode==='normal'){
        if(row.saved_mode){await c.query('DELETE FROM member_modes WHERE chat_id=$1 AND member_id=$2',[chatId,memberId]);await this.invalidate(c,chatId,memberId);}
        return {mode:'normal'};
      }
      return {mode:member.mode,prompt:member.mode==='jerops'?settings.jeropsPrompt:settings.planPrompt};
    });
  }
}
