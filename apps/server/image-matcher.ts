/** 拥有独立离线 Python 编码进程，以请求 ID 关联图像与结果。校验有限数值及摘要；超时或协议异常终止本模块进程，不操作微信客户端。 */
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {z} from 'zod';

const resultSchema=z.object({status:z.literal('ok'),metric:z.literal('cosine_similarity'),calibrated:z.literal(false),similarity:z.number().finite().min(-1).max(1),matchedReference:z.string().min(1).max(100),category:z.string().min(1).max(100),matches:z.array(z.unknown()).max(5)});
export type ImageMatchResult=z.infer<typeof resultSchema>;
export interface ImageMatcher {match(image:{path:string;sha256:string;galleryVersion?:string},signal?:AbortSignal,onStart?:()=>void|Promise<void>):Promise<ImageMatchResult>;prepareGallery?(version:string,manifest:string):Promise<void>;activateGallery?(version:string):void;discardGallery?(version:string):void;close():void;status():{running:boolean;ready:boolean;referenceCount:number}}

/** One owned, offline Python encoder. JSON request IDs bind each score to its image. */
export class LocalImageMatcher implements ImageMatcher {
 private galleries=new Map<string,LocalImageMatcher>();private activeGallery?:string;
 private child?:ChildProcessWithoutNullStreams;private ready=false;private referenceCount=0;private closed=false;
 private starting?:Promise<void>;private rejectStart?:(error:Error)=>void;private tail:Promise<unknown>=Promise.resolve();
 private pending?:{id:string;resolve:(value:ImageMatchResult)=>void;reject:(error:Error)=>void};
 constructor(private options:{python?:string;script?:string;manifest?:string;timeoutMs?:number;startupTimeoutMs?:number}={}){}
 status():{running:boolean;ready:boolean;referenceCount:number}{const worker=this.galleries.get(this.activeGallery??'')??[...this.galleries.values()].at(-1);return worker?worker.status():{running:Boolean(this.child),ready:this.ready,referenceCount:this.referenceCount};}
 async prepareGallery(version:string,manifest:string){
  if(this.closed)throw new Error('图像匹配进程已关闭');
  let worker=this.galleries.get(version);
  if(!worker){worker=new LocalImageMatcher({...this.options,manifest});this.galleries.set(version,worker);}
  try{await worker.start();}catch(e){this.discardGallery(version);throw e;}
 }
 activateGallery(version:string){this.activeGallery=version;for(const key of this.galleries.keys())if(key!==version)this.discardGallery(key);}
 discardGallery(version:string){this.galleries.get(version)?.close();this.galleries.delete(version);}
 private fail(error:Error){
  const child=this.child;this.child=undefined;this.ready=false;this.starting=undefined;
  this.rejectStart?.(error);this.rejectStart=undefined;this.pending?.reject(error);this.pending=undefined;
  if(child&&!child.killed)child.kill();
 }
 private start(){
  if(this.closed)return Promise.reject(new Error('图像匹配进程已关闭'));
  if(this.ready)return Promise.resolve();if(this.starting)return this.starting;
  this.starting=new Promise<void>((done,reject)=>{
   this.rejectStart=reject;
   const child=spawn(this.options.python??resolve('.venv-image-match/Scripts/python.exe'),[this.options.script??resolve('scripts/image_match.py'),'serve','--manifest',this.options.manifest??resolve('data/image-match/references.json')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'}});
   this.child=child;let buffer='';
   const timer=setTimeout(()=>this.fail(new Error('图像匹配模型加载超时')),this.options.startupTimeoutMs??90000);
   const startDone=()=>{clearTimeout(timer);this.rejectStart=undefined;done();};
   this.rejectStart=error=>{clearTimeout(timer);reject(error);};
   child.stdout.setEncoding('utf8');child.stderr.resume();
   child.stdout.on('data',(chunk:string)=>{
    if(this.child!==child)return;buffer+=chunk;if(buffer.length>131072){this.fail(new Error('图像匹配协议超过长度限制'));return;}
    while(buffer.includes('\n')){
     const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
     try{
      const value=JSON.parse(line);
      if(value.type==='ready'&&!this.ready&&Number.isInteger(value.referenceCount)&&value.referenceCount>0){this.referenceCount=value.referenceCount;this.ready=true;startDone();continue;}
      if(!this.pending||value.id!==this.pending.id)throw Error('id');
      const result=resultSchema.parse(value.result);const pending=this.pending;this.pending=undefined;pending.resolve(result);
     }catch{this.fail(new Error('图像匹配协议无效或图片请求不一致'));return;}
    }
   });
   child.stdin.on('error',()=>{if(this.child===child)this.fail(new Error('图像匹配输入通道中断'));});
   child.on('error',()=>{if(this.child===child)this.fail(new Error('本地图像匹配环境不可用'));});
   child.on('exit',()=>{if(this.child===child)this.fail(new Error('本地图像匹配进程退出'));});
  });return this.starting;
 }
 match(image:{path:string;sha256:string;galleryVersion?:string},signal?:AbortSignal,onStart?:()=>void|Promise<void>):Promise<ImageMatchResult>{
  if(image.galleryVersion){const worker=this.galleries.get(image.galleryVersion);if(!worker)return Promise.reject(new Error('所选图库尚未准备就绪'));return worker.match({path:image.path,sha256:image.sha256},signal,onStart);}
  let ownsWorker=false;
  const work=this.tail.catch(()=>{}).then(async()=>{
   if(signal?.aborted)throw new Error('图像匹配已停止');
   ownsWorker=true;
   try{
    await onStart?.();if(signal?.aborted)throw new Error('图像匹配已停止');
    await this.start();if(signal?.aborted)throw new Error('图像匹配已停止');
    return await new Promise<ImageMatchResult>((done,reject)=>{
     const id=randomUUID();const timer=setTimeout(()=>this.fail(new Error('图像匹配计算超时')),this.options.timeoutMs??30000);
     this.pending={id,resolve:value=>{clearTimeout(timer);done(value);},reject:error=>{clearTimeout(timer);reject(error);}};
     this.child!.stdin.write(JSON.stringify({id,path:image.path,sha256:image.sha256})+'\n');
    });
   }finally{ownsWorker=false;}
  });this.tail=work;
  if(!signal)return work;
  return new Promise((done,reject)=>{
   const abort=()=>{const error=new Error('图像匹配已停止');if(ownsWorker)this.fail(error);reject(error);};
   signal.addEventListener('abort',abort,{once:true});
   work.then(value=>{signal.removeEventListener('abort',abort);done(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
   if(signal.aborted)abort();
  });
 }
 close(){this.closed=true;for(const worker of this.galleries.values())worker.close();this.galleries.clear();this.fail(new Error('图像匹配已关闭'));}
}
