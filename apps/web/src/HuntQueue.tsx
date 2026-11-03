/** 检测和追猎队列。区分检测、生成与发送；轮询仅观察状态，不自动重试不确定的微信发送。 */
import {Check} from '@phosphor-icons/react';
import {useEffect,useId,useRef,useState} from 'react';
import {ArrowClockwise} from '@phosphor-icons/react';
import {api,dateTime,queryString,type Chat} from './api';
import {Badge,Button,Empty,Field,Pagination,ResourceState} from './ui';
import './HuntQueue.css';
import {ReferenceImage} from './HuntGallery';

const stages = {
 capture_failed:'取图失败',waiting_upload:'等待上传',queued_match:'等待匹配',matching:'正在匹配',
 not_matched:'未达阈值',cooldown:'冷却中',blocked_identity:'无法确认发图者',queued_reply:'等待生成',
 waiting_model:'等待模型',generating:'正在生成',queued_send:'等待发送',sending:'正在发送',sent:'已发送',
 failed:'处理失败',cancelled:'已取消',expired:'已过期',skipped:'已跳过',unknown:'状态待核查',
} as const;
type Stage = keyof typeof stages;
interface QueueItem {
 attachmentId:string;chatId:string;chatName:string;imageNumber:string;ownerName:string|null;
 stage:Stage;reason:string|null;similarity:number|null;threshold:number|null;createdAt:string;updatedAt:string;
 matchedReference?:{id:string;name:string;previewUrl:string;galleryVersion:string};matchedReferenceId?:string|null;matchedReferenceName?:string|null;matchedReferencePreviewUrl?:string|null;galleryVersion?:string|null;
 detectTaskId:string|null;replyTaskId:string|null;sendId:string|null;attempts:number;
}
interface QueueResponse {
 items:QueueItem[];total:number;page:number;pageSize:number;serverNow:string;
 capacity:{model:number;match:number;upload:number};summary:Record<string,number>;
}
const activeStages:Stage[]=['waiting_upload','queued_match','matching','queued_reply','waiting_model','generating','queued_send','sending'];
const sum=(summary:Record<string,number>,keys:Stage[])=>keys.reduce((total,key)=>total+(summary[key]??0),0);
const tone=(stage:Stage)=>stage==='sent'?'good':activeStages.includes(stage)?'accent':['capture_failed','blocked_identity','failed','unknown'].includes(stage)?'warn':'neutral';
const score=(value:number|null)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(4):'尚未提供';
const updatedTime=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));

// A shared flight lock serializes refreshes, including filter and revision changes.
// Old responses never replace the newly selected query; errors keep its last good snapshot.
function useQueue(path:string,revision:string) {
 const [snapshot,setSnapshot]=useState<{path:string;data:QueueResponse}>();
 const [error,setError]=useState(''),[loading,setLoading]=useState(true);
 const desired=useRef({path,revision}),flight=useRef(false),pending=useRef(false);
 const refresh=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let alive=true;
  const run=async()=>{
   if(!alive||document.visibilityState==='hidden')return;
   if(flight.current){pending.current=true;return;}
   flight.current=true;pending.current=false;
   const requested=desired.current;
   setLoading(true);
   try {
    const data=await api<QueueResponse>(requested.path);
    if(alive&&desired.current.path===requested.path){setSnapshot({path:requested.path,data});setError('');}
   } catch(cause) {
    if(alive&&desired.current.path===requested.path)setError(cause instanceof Error?cause.message:'读取队列失败，请重试。');
   } finally {
    flight.current=false;
    if(alive)setLoading(false);
    if(pending.current)refresh.current();
   }
  };
  refresh.current=()=>{void run();};
  const timer=window.setInterval(()=>refresh.current(),2000);
  const visible=()=>{if(document.visibilityState==='visible')refresh.current();};
  document.addEventListener('visibilitychange',visible);
  return()=>{alive=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);refresh.current=()=>{};};
 },[]);
 useEffect(()=>{
  desired.current={path,revision};setError('');refresh.current();
 },[path,revision]);
 return {data:snapshot?.path===path?snapshot.data:undefined,error,loading,reload:()=>refresh.current()};
}

export function QueueProgress({stage,stale=false}:{stage:string;stale?:boolean}) {
 const phase:Record<string,number>={waiting_upload:0,queued_match:1,matching:1,queued_reply:2,waiting_model:2,generating:2,queued_send:3,sending:3,sent:4,not_matched:2,cooldown:2,blocked_identity:2,capture_failed:0};
 const current=phase[stage]??0;
 const stopped=['not_matched','cooldown','blocked_identity','capture_failed'].includes(stage)||!(stage in phase);
 return <ol className="queue-progress" aria-label={`处理阶段：${stages[stage as Stage]??'状态待核查'}${stale?'，更新中断':''}`}>{['上传','匹配','生成','发送'].map((label,index)=><li key={label} className={`${index<current?'done':''} ${index===current&&!stopped?'current':''} ${index===current&&!stopped&&!stale&&['matching','generating','sending'].includes(stage)?'moving':''}`}><span className="queue-node">{index<current&&<Check size={13} weight="bold"/>}</span><span>{label}</span></li>)}</ol>;
}

export function HuntQueue({chats,chatId,onChatChange,revision}:{chats:Chat[];chatId:string;onChatChange:(id:string)=>void;revision:string}) {
 const heading=useId();
 const [stage,setStage]=useState(''),[paging,setPaging]=useState({chatId,page:1,pageSize:20});
 const page=paging.chatId===chatId?paging.page:1;
 const path='/api/hunt/queue?'+queryString({chatId,stage,page,pageSize:paging.pageSize});
 const {data,error,loading,reload}=useQueue(path,revision);
 useEffect(()=>{if(paging.chatId!==chatId)setPaging(previous=>({...previous,chatId,page:1}));},[chatId,paging.chatId]);
 useEffect(()=>{
  if(data&&data.page>Math.max(1,Math.ceil(data.total/data.pageSize)))setPaging(previous=>({...previous,page:Math.max(1,Math.ceil(data.total/data.pageSize))}));
 },[data]);
 const summary=data?.summary;
 return <section className={`hunt-test hunt-queue ${error?'is-stale':''}`} aria-labelledby={heading}>
  <div className="hunt-queue-heading"><div><h2 id={heading}>追猎实时队列</h2><p className="hint">上传 → 本地匹配 → 回复生成 → 微信发送。每条图片显示服务报告的当前阶段。</p></div><Button onClick={reload} busy={loading}><ArrowClockwise size={17}/>刷新队列</Button></div>
  <div className="hunt-queue-filters">
   <Field label="队列群聊"><select value={chatId} onChange={event=>onChatChange(event.target.value)}><option value="">全部群聊</option>{chats.map(chat=><option key={chat.id} value={chat.id}>{chat.name}</option>)}</select></Field>
   <Field label="处理状态"><select value={stage} onChange={event=>{setStage(event.target.value);setPaging(previous=>({...previous,chatId,page:1}));}}><option value="">全部状态</option><option value="active">等待与处理中</option>{Object.entries(stages).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field>
  </div>
  {data&&summary&&<>
   <dl className="hunt-queue-summary" aria-label="当前群聊范围的队列汇总">
    <div><dt>处理中</dt><dd>{sum(summary,activeStages)}</dd></div>
    <div><dt>已发送</dt><dd>{summary.sent??0}</dd></div>
    <div><dt>失败</dt><dd>{sum(summary,['capture_failed','failed'])}</dd></div>
    <div><dt>身份待确认</dt><dd>{summary.blocked_identity??0}</dd></div>
   </dl>
   <details className="hunt-queue-counts"><summary>队列信息</summary><dl>{Object.entries(stages).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{summary[key]??0}</dd></div>)}</dl>
   <p className="hunt-queue-capacity">并发上限：上传 {data.capacity.upload} · 本地匹配 {data.capacity.match} · 模型 {data.capacity.model}<span>服务更新于 {updatedTime(data.serverNow)} · 页面可见时每 2 秒刷新</span></p></details>
  </>}
  <div className="hunt-queue-records">
  <ResourceState loading={loading&&!data} error={error} retry={reload}/>
  {error&&data&&<p className="hint hunt-queue-stale">更新中断，保留上次记录与最后成功时间。可重试或等待自动刷新。</p>}
  {data&&data.items.length===0&&<Empty title={stage||chatId?'没有符合筛选条件的图片':'还没有追猎队列记录'}>收到的图片会按实际取图、上传和处理结果显示在这里。</Empty>}
  {!!data?.items.length&&<ul className="hunt-queue-list" aria-label="图片处理记录">{data.items.map(item=><li key={item.attachmentId}>
   <div className="hunt-queue-item-heading"><strong>图片 {item.imageNumber}</strong><Badge tone={tone(item.stage)}>{stages[item.stage]??'状态待核查'}</Badge></div>
   <p className="hunt-queue-owner">{item.chatName} · {item.ownerName??'发图者身份未确认'}</p>
   {!['waiting_upload','queued_match','matching','capture_failed'].includes(item.stage)&&(item.matchedReference||item.matchedReferenceName)?<div className="queue-reference-match"><ReferenceImage reference={{name:item.matchedReference?.name??item.matchedReferenceName??'',previewUrl:item.matchedReference?.previewUrl??item.matchedReferencePreviewUrl??''}}/><div className="hunt-queue-flow"><span className="queue-reference-label">{item.stage==='not_matched'?'最相近参考图':'命中'}：<strong>{item.matchedReference?.name??item.matchedReferenceName}</strong></span><QueueProgress stage={item.stage} stale={Boolean(error)}/></div></div>:<QueueProgress stage={item.stage} stale={Boolean(error)}/>}
   <p className="queue-stage-label">当前阶段：{stages[item.stage]??'状态待核查'}</p>
   {item.stage==='not_matched'&&<p className="queue-score">匹配分数 / 阈值：{score(item.similarity)} / {score(item.threshold)}</p>}
   <details className="queue-item-details"><summary>详情</summary>
   <dl className="hunt-queue-item-data"><div><dt>匹配分数 / 阈值</dt><dd>{score(item.similarity)} / {score(item.threshold)}</dd></div><div><dt>尝试次数</dt><dd>{item.attempts}</dd></div><div><dt>更新时间</dt><dd><time dateTime={item.updatedAt}>{updatedTime(item.updatedAt)}</time></dd></div></dl>
   {item.reason&&<p className={`hunt-queue-reason ${['failed','capture_failed'].includes(item.stage)?'is-error':''}`}><strong>处理说明：</strong>{item.reason}</p>}
   <details className="hunt-queue-trace"><summary>查看处理标识</summary><dl><div><dt>附件</dt><dd>{item.attachmentId}</dd></div><div><dt>匹配任务</dt><dd>{item.detectTaskId??'未建立'}</dd></div><div><dt>生成任务</dt><dd>{item.replyTaskId??'未建立'}</dd></div><div><dt>发送记录</dt><dd>{item.sendId??'未建立'}</dd></div><div><dt>收取时间</dt><dd>{dateTime(item.createdAt)}</dd></div></dl></details>
   </details>
  </li>)}</ul>}
  </div>
  {data&&<p className="queue-updated">服务更新于 {updatedTime(data.serverNow)}</p>}
  {data&&<Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={next=>setPaging(previous=>({...previous,chatId,page:next}))} onPageSize={pageSize=>setPaging({chatId,page:1,pageSize})} busy={loading}/>}
 </section>;
}
