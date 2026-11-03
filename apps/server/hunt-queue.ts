/** 从持久任务和发送账本投影追猎队列。检测完成不等于回复已发送，界面状态必须反映可确认的阶段。 */
import {z} from 'zod';
import type {Database} from './db.js';
export const huntStages=['capture_failed','waiting_upload','queued_match','matching','not_matched','cooldown','blocked_identity','queued_reply','waiting_model','generating','queued_send','sending','sent','failed','cancelled','expired','skipped','unknown'] as const;
export type HuntStage=typeof huntStages[number];
export const huntQueueQuery=z.object({chatId:z.uuid().optional(),stage:z.enum(['active',...huntStages]).optional(),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().refine(v=>[20,50,100].includes(v)).default(20)});
type Queryable={query(sql:string,values?:any[]):Promise<{rows:any[];rowCount:number|null}>};
export async function setHuntProgress(db:Queryable,id:string,stage:HuntStage,reason?:string){
 await db.query("UPDATE chat_images SET hunt_progress=hunt_progress||jsonb_build_object('stage',$2::text,'reason',$3::text,'updatedAt',clock_timestamp()) WHERE id=$1",[id,stage,reason??null]);
}
const active=['waiting_upload','queued_match','matching','queued_reply','waiting_model','generating','queued_send','sending'];
const rowsSql=`SELECT i.id attachment_id,i.chat_id,c.name chat_name,'I'||lpad(i.number::text,4,'0') image_number,me.nickname owner_name,
 i.hunt_result->>'similarity' similarity,i.hunt_result->>'threshold' threshold,i.hunt_result->>'matchedReference' matched_reference,i.hunt_result->>'matchedReferenceName' matched_reference_name,i.hunt_result->>'matchedReferencePreviewUrl' matched_reference_preview_url,i.hunt_result->>'galleryVersion' gallery_version,i.created_at,
 greatest(i.created_at,coalesce((i.hunt_progress->>'updatedAt')::timestamptz,i.created_at),coalesce(td.updated_at,i.created_at),coalesce(tr.updated_at,i.created_at),coalesce(ts.updated_at,i.created_at),coalesce(s.sent_at,i.created_at)) updated_at,
 coalesce(i.hunt_detect_task_id,o.id) detect_task_id,i.hunt_reply_task_id reply_task_id,s.id send_id,
 greatest(coalesce(td.attempts,0),coalesce(tr.attempts,0),coalesce(ts.attempts,0)) attempts,
 CASE WHEN i.status='expired' THEN 'expired' WHEN m.direction='out' THEN 'skipped'
 WHEN i.status='unavailable' THEN 'capture_failed' WHEN i.status='pending' THEN 'waiting_upload'
 WHEN s.status='sent' THEN 'sent' WHEN s.status='sending' THEN 'sending' WHEN s.status='unknown' THEN 'unknown'
 WHEN s.status='cancelled' OR td.state='cancelled' OR tr.state='cancelled' OR ts.state='cancelled' THEN 'cancelled'
 WHEN td.state='failed' OR tr.state='failed' OR ts.state='failed' THEN 'failed' WHEN s.status='pending' THEN 'queued_send'
 WHEN i.hunt_progress->>'stage' IS NOT NULL THEN i.hunt_progress->>'stage'
 WHEN i.hunt_result->>'status'='not-matched' THEN 'not_matched' WHEN i.hunt_result->>'status'='cooldown' THEN 'cooldown'
 WHEN i.hunt_result->>'status'='queued' THEN 'queued_match' ELSE 'skipped' END stage,
 CASE WHEN m.direction='out' THEN '机器人自己发送的图片不触发追猎'
 WHEN i.status='unavailable' THEN coalesce(i.reason,'图片区域暂不可安全取得')
 WHEN i.status='pending' THEN '等待桥接上传图片内容' WHEN i.status='expired' THEN '图片或来源已过期'
 WHEN td.state='failed' OR tr.state='failed' OR ts.state='failed' THEN coalesce(ts.error,tr.error,td.error,'处理失败，请查看运行记录')
 WHEN s.status='cancelled' THEN coalesce(s.detail,'发送已取消')
 ELSE coalesce(i.hunt_progress->>'reason',CASE WHEN i.hunt_result IS NULL THEN '此图片未进入自动追猎（旧图片、功能未启用或来源条件不满足）' ELSE NULL END) END reason
 FROM chat_images i JOIN chats c ON c.id=i.chat_id LEFT JOIN messages m ON m.id=i.message_id
 LEFT JOIN members me ON me.id=i.owner_member_id AND me.chat_id=i.chat_id
 LEFT JOIN outbox o ON o.unique_key='hunt-'||i.id::text
 LEFT JOIN tasks td ON td.id=coalesce(i.hunt_detect_task_id,o.id) LEFT JOIN tasks tr ON tr.id=i.hunt_reply_task_id
 LEFT JOIN LATERAL (SELECT id,status,detail,sent_at FROM sends WHERE attachment_id=i.id AND kind='hunt' ORDER BY created_at DESC LIMIT 1) s ON true
 LEFT JOIN outbox os ON os.unique_key='send-'||s.id::text LEFT JOIN tasks ts ON ts.id=os.id
 WHERE ($1::uuid IS NULL OR i.chat_id=$1) AND i.created_at>now()-interval '30 days'`;
export async function huntQueue(db:Database,input:unknown,modelCapacity=4){
 const q=huntQueueQuery.parse(input),filter=q.stage==='active'?active:q.stage?[q.stage]:null;
 return db.tx(async c=>{
  // A consistent list/count snapshot also prevents transient totals during stage changes.
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const summaryRows=(await c.query('WITH queue AS ('+rowsSql+') SELECT stage,count(*)::int count FROM queue GROUP BY stage',[q.chatId??null])).rows;
  const summary=Object.fromEntries(huntStages.map(stage=>[stage,0]));for(const row of summaryRows)summary[row.stage]=row.count;
  const total=(await c.query('WITH queue AS ('+rowsSql+') SELECT count(*)::int count FROM queue WHERE ($2::text[] IS NULL OR stage=ANY($2))',[q.chatId??null,filter])).rows[0].count;
  const values=[q.chatId??null,filter,q.pageSize,(q.page-1)*q.pageSize];
  const rows=(await c.query('WITH queue AS ('+rowsSql+') SELECT * FROM queue WHERE ($2::text[] IS NULL OR stage=ANY($2)) ORDER BY created_at DESC,attachment_id LIMIT $3 OFFSET $4',values)).rows;
  return {items:rows.map(r=>({attachmentId:r.attachment_id,chatId:r.chat_id,chatName:r.chat_name,imageNumber:r.image_number,ownerName:r.owner_name??null,stage:r.stage,reason:r.reason??null,similarity:r.similarity===null?null:Number(r.similarity),threshold:r.threshold===null?null:Number(r.threshold),createdAt:r.created_at,updatedAt:r.updated_at,detectTaskId:r.detect_task_id??null,replyTaskId:r.reply_task_id??null,sendId:r.send_id??null,attempts:r.attempts,matchedReference:r.matched_reference??null,matchedReferenceName:r.matched_reference_name??null,matchedReferencePreviewUrl:r.matched_reference_preview_url??null,galleryVersion:r.gallery_version??null})),total,page:q.page,pageSize:q.pageSize,summary,capacity:{model:modelCapacity,match:1,upload:2},serverNow:new Date().toISOString()};
 });
}
