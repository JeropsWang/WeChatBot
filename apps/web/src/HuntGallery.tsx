/** 图库上传与选择。上传、勾选、删除分阶段执行，实际启用随设置保存；取消请求并释放不再使用的预览资源。 */
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {CaretDown,CaretUp,Check,DotsThreeVertical,ImageSquare,Plus,MagnifyingGlass,Gear} from '@phosphor-icons/react';
import {api,queryString,useResource,type PageResult} from './api';
import {Button,Feedback,Modal} from './ui';

export interface HuntReference {id:string;name:string;source:'builtin'|'upload';status:'ready';previewUrl:string;enabled:boolean}
interface Upload {id:number;file:File;state:'uploading'|'processing'|'complete'|'failed';progress:number;message?:string}
export function ReferenceImage({reference,className=''}:{reference:{previewUrl:string;name:string};className?:string}) {
 const [failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[reference.previewUrl]);
 return <span className={`hunt-reference-image ${className}`}>{failed||!reference.previewUrl?<ImageSquare size={24} aria-label="图片不可用"/>:<img src={reference.previewUrl} alt={reference.name} onError={()=>setFailed(true)}/>}</span>;
}
export function HuntGallery({references,enabledIds,deletedIds,savedIds,onChange,onUploaded,revision}:{references:HuntReference[];enabledIds:string[];deletedIds:string[];savedIds:string[];onChange:(enabledIds:string[],deletedIds:string[])=>void;onUploaded:(item:HuntReference)=>void;revision:number}) {
 const [open,setOpen]=useState(false),[q,setQ]=useState(''),[source,setSource]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[refresh,setRefresh]=useState(0),[preview,setPreview]=useState<HuntReference>(),[uploads,setUploads]=useState<Upload[]>([]),[drag,setDrag]=useState(false),[menu,setMenu]=useState<{item:HuntReference;top:number;left:number}>();
 const fileInput=useRef<HTMLInputElement>(null),sequence=useRef(0),active=useRef(new Map<number,XMLHttpRequest>()),alive=useRef(true),removedUploads=useRef(new Set<number>());
 const manager=useId();
 const list=useResource<PageResult<HuntReference>>(open?'/api/hunt/references?'+queryString({q,source,page,pageSize}):'',revision+refresh);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current.forEach(request=>request.abort());};},[]);
 useEffect(()=>{if(list.data&&page>Math.max(1,Math.ceil(list.data.total/pageSize)))setPage(Math.max(1,Math.ceil(list.data.total/pageSize)));},[list.data,page,pageSize]);
 useEffect(()=>{if(!menu)return;const dismiss=(event:PointerEvent)=>{if(!(event.target as Element).closest('.hunt-gallery-menu-panel,.hunt-gallery-menu-trigger'))setMenu(undefined);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setMenu(undefined);};document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};},[menu]);
 const update=(id:number,patch:Partial<Upload>)=>{if(alive.current)setUploads(previous=>previous.map(item=>item.id===id?{...item,...patch}:item));};
 const upload=async(id:number,file:File)=>{
  update(id,{state:'uploading',progress:0,message:undefined});
  try {
   if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('仅支持 PNG、JPG 和静态 WebP 图片。');
   if(file.size>5*1024*1024)throw new Error('图片超过 5 MiB，请压缩后重试。');
   const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取文件，请重试。'));reader.readAsDataURL(file);});
   if(!alive.current||removedUploads.current.has(id))return;
   const result=await new Promise<{item:HuntReference;duplicate:boolean}>((resolve,reject)=>{
    const request=new XMLHttpRequest();active.current.set(id,request);request.open('POST','/api/hunt/references');request.withCredentials=true;request.setRequestHeader('Content-Type','application/json');request.timeout=120000;
    request.upload.onprogress=event=>{if(event.lengthComputable)update(id,{progress:Math.round(event.loaded/event.total*100)});};
    request.upload.onload=()=>update(id,{state:'processing',progress:100});
    request.onload=()=>{active.current.delete(id);try{const body=JSON.parse(request.responseText);if(request.status===401)window.dispatchEvent(new Event('liino-session-expired'));if(request.status<200||request.status>=300||body.ok===false)throw new Error(body.message||'上传失败，请重试。');resolve(body);}catch(error){reject(error);}};
    request.onerror=()=>reject(new Error('连接中断，请重试。'));request.ontimeout=()=>reject(new Error('上传超时，请重试。'));request.onabort=()=>reject(new Error('上传已取消。'));request.send(JSON.stringify({name:file.name,mimeType:file.type,data}));
   });
   if(!alive.current)return;
   onUploaded(result.item);setRefresh(value=>value+1);update(id,{state:'complete',message:result.duplicate?'已存在相同图片，未重复添加。':'上传完成，默认未启用。'});
  }catch(error){active.current.delete(id);update(id,{state:'failed',message:error instanceof Error?error.message:'上传失败，请重试。'});}
 };
 const addFiles=(files:FileList|File[])=>{for(const file of Array.from(files)){const id=++sequence.current;setUploads(previous=>[...previous,{id,file,state:'uploading',progress:0}]);void upload(id,file);}};
 const enabled=references.filter(item=>enabledIds.includes(item.id)&&!deletedIds.includes(item.id));
 const total=references.filter(item=>!deletedIds.includes(item.id)).length;
 const visible=enabled.length>4?enabled.slice(0,3):enabled;
 const toggle=(id:string)=>onChange(enabledIds.includes(id)?enabledIds.filter(value=>value!==id):[...enabledIds,id],deletedIds);
 return <section className={`hunt-gallery ${drag?'is-dragging':''}`} aria-label="触发图库" onDragOver={event=>{event.preventDefault();setDrag(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDrag(false);}} onDrop={event=>{event.preventDefault();setDrag(false);addFiles(event.dataTransfer.files);}}>
  <div className="hunt-gallery-heading"><h3>触发图库</h3><span className="hunt-gallery-count">已启用 {enabled.length} / 共 {total} 张</span><Button type="button" aria-expanded={open} aria-controls={manager} onClick={()=>setOpen(!open)}><Gear size={16}/>管理图库</Button></div>
  <div className="hunt-gallery-strip">{visible.map(item=><button type="button" className="hunt-gallery-thumb" key={item.id} title={item.name} aria-label={`预览 ${item.name}`} onClick={()=>setPreview(item)}><ReferenceImage reference={item}/><span className="hunt-thumb-check"><Check size={12}/></span></button>)}{enabled.length>4&&<button type="button" className="hunt-gallery-more" onClick={()=>setOpen(true)} aria-label={`还有 ${enabled.length-3} 张已启用图片，打开图库管理`}>+{enabled.length-3}</button>}<button type="button" className="hunt-gallery-add" onClick={()=>fileInput.current?.click()}><Plus size={24}/><span>上传图片</span></button></div>
  {enabled.length===0&&<p className="hint">尚未启用参考图，可在图库管理中选择。</p>}
  <p className="hint hunt-gallery-note">仅匹配已启用图片，修改后保存生效。支持拖入 PNG、JPG、静态 WebP，每张最多 5 MiB。</p>
  <input ref={fileInput} className="hunt-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="上传参考图片" onChange={event=>{if(event.target.files)addFiles(event.target.files);event.target.value='';}}/>
  {uploads.length>0&&<ul className="hunt-upload-list" aria-label="上传任务">{uploads.map(item=><li key={item.id}><div><strong title={item.file.name}>{item.file.name}</strong><span role="status">{item.state==='uploading'?`上传中 ${item.progress}%`:item.state==='processing'?'正在处理图片…':item.message}</span>{item.state==='uploading'&&<progress value={item.progress} max={100} aria-label={`${item.file.name} 上传进度`}/>}</div>{item.state==='failed'&&<Button type="button" onClick={()=>void upload(item.id,item.file)}>重试</Button>}<Button type="button" aria-label={`移除上传任务 ${item.file.name}`} disabled={item.state==='processing'} onClick={()=>{removedUploads.current.add(item.id);active.current.get(item.id)?.abort();active.current.delete(item.id);setUploads(previous=>previous.filter(value=>value.id!==item.id));}}>移除</Button></li>)}</ul>}
  <div id={manager} hidden={!open} className="hunt-gallery-manager">
   <div className="hunt-gallery-manager-heading"><button type="button" className="hunt-gallery-collapse" onClick={()=>setOpen(false)} aria-expanded={open}><CaretDown size={16}/>图库管理</button><label className="hunt-gallery-search"><MagnifyingGlass size={17}/><input type="search" value={q} aria-label="搜索参考图片" placeholder="搜索图片" onChange={event=>{setQ(event.target.value);setPage(1);}}/></label></div>
   <div className="hunt-gallery-tabs" role="group" aria-label="参考图来源">{[['','全部'],['builtin','原有参考图'],['upload','我的上传']].map(([value,label])=><button type="button" key={value} aria-pressed={source===value} onClick={()=>{setSource(value);setPage(1);}}>{label}</button>)}</div>
   <Feedback error={list.error}/>{list.error&&<Button type="button" onClick={()=>void list.reload()}>重试读取图库</Button>}{list.loading&&<p className="hint" role="status">正在读取图库…</p>}
   <ul className="hunt-gallery-list" aria-label="参考图片">{list.data?.items.map(item=>{const removed=deletedIds.includes(item.id),checked=enabledIds.includes(item.id),pending=checked!==savedIds.includes(item.id);return <li key={item.id} className={removed?'is-deleted':''}><input type="checkbox" aria-label={`启用 ${item.name}`} checked={checked&&!removed} disabled={removed} onChange={()=>toggle(item.id)}/><button type="button" className="hunt-gallery-row-preview" aria-label={`预览 ${item.name}`} onClick={()=>setPreview(item)}><ReferenceImage reference={item}/></button><span className="hunt-gallery-row-info"><span className="hunt-gallery-name" title={item.name}>{item.name}</span><span className={`hunt-gallery-source ${item.source}`}>{item.source==='builtin'?'原有参考图':'我的上传'}</span><span className={`hunt-gallery-status ${checked&&!removed?'enabled':''}`}>{removed?'待删除':pending?(checked?'待启用':'待停用'):checked?'已启用':'未启用'}</span></span>{removed?<button type="button" className="hunt-gallery-undo" onClick={()=>onChange(enabledIds,deletedIds.filter(id=>id!==item.id))}>撤销</button>:<button type="button" className="hunt-gallery-menu-trigger" aria-label={`${item.name} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.item.id===item.id} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu(menu?.item.id===item.id?undefined:{item,top:Math.min(rect.bottom+4,window.innerHeight-108),left:Math.max(8,Math.min(rect.right-172,window.innerWidth-180))});}}><DotsThreeVertical size={20}/></button>}</li>;})}</ul>
   {list.data?.total===0&&<p className="hint hunt-gallery-empty">{q?'没有找到匹配的图片。':'当前来源暂无图片。'}</p>}
   {list.data&&<nav className="hunt-gallery-pagination" aria-label="参考图库分页"><span>共 {list.data.total} 张</span><label>每页 <select value={pageSize} disabled={list.loading} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>{[20,50,100].map(size=><option key={size}>{size}</option>)}</select></label><Button type="button" disabled={list.loading||page<=1} onClick={()=>setPage(page-1)}>上一页</Button><span>{page} / {Math.max(1,Math.ceil(list.data.total/pageSize))}</span><Button type="button" disabled={list.loading||page*pageSize>=list.data.total} onClick={()=>setPage(page+1)}>下一页</Button></nav>}
   <button type="button" className="hunt-gallery-close" onClick={()=>setOpen(false)}><CaretUp size={16}/>收起图库</button>
  </div>
  {menu&&<div className="hunt-gallery-menu-panel" role="menu" aria-label={`${menu.item.name} 操作`} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));const current=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:(current-1+buttons.length)%buttons.length;buttons[next]?.focus();}}} style={{position:'fixed',top:menu.top,left:menu.left}}><button type="button" role="menuitem" autoFocus onClick={()=>{setPreview(menu.item);setMenu(undefined);}}>预览图片</button>{menu.item.source==='upload'&&<button type="button" role="menuitem" onClick={()=>{onChange(enabledIds,[...deletedIds,menu.item.id]);setMenu(undefined);}}>删除（保存生效）</button>}</div>}
  {preview&&createPortal(<Modal title={preview.name} onClose={()=>setPreview(undefined)}><div className="hunt-reference-preview"><ReferenceImage reference={preview}/></div><p className="hunt-reference-full-name">{preview.name}</p></Modal>,document.body)}
 </section>;
}
