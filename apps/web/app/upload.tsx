'use client';
import { useRef,useState,type DragEvent } from 'react';
import { CloudUpload, FolderOpen, Music, X } from 'lucide-react';
import { bytes, extension, formats } from '@resonant/shared';
import { createClient } from '@resonant/api-client';
import type { UploadPlan } from '@resonant/types';
const api=createClient('/gateway');
type Part={number:number;etag:string};
type Item={key:string;file:File;progress:number;state:string;title?:string;id?:string;rate?:number};
const recoveryKey='resonant-pending-verification';

function put(url:string, blob:Blob, mime:string|null, signal:AbortSignal, progress:(n:number)=>void) {
  return new Promise<string>((resolve,reject)=>{
    const request=new XMLHttpRequest();
    const abort=()=>request.abort();
    if (signal.aborted) return reject(new DOMException('Cancelled','AbortError'));
    request.open('PUT',url);
    request.timeout=180000;
    if (mime) request.setRequestHeader('Content-Type',mime);
    signal.addEventListener('abort',abort,{once:true});
    request.onloadend=()=>signal.removeEventListener('abort',abort);
    request.upload.onprogress=e=>progress(e.loaded);
    request.onload=()=>request.status>=200&&request.status<300?resolve(request.getResponseHeader('ETag')??''):reject(new Error('Storage rejected the transfer ('+request.status+')'));
    request.onerror=request.ontimeout=()=>reject(new Error('Storage connection failed'));
    request.onabort=()=>reject(new DOMException('Cancelled','AbortError'));
    request.send(blob);
  });
}
async function hashFile(file:File,signal:AbortSignal) {
  const {sha256}=await import('@noble/hashes/sha2.js');
  const hash=sha256.create();
  const reader=file.stream().getReader();
  try {
    while (!signal.aborted) {
      const chunk=await reader.read();
      if (chunk.done) return Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('');
      hash.update(chunk.value);
    }
    throw new DOMException('Cancelled','AbortError');
  } finally { await reader.cancel(); }
}
const recovery=():Record<string,Part[]>=>JSON.parse(localStorage.getItem(recoveryKey)??'{}');
function remember(id:string,parts:Part[]|null) {
  const current=recovery();
  if (parts) current[id]=parts;
  else delete current[id];
  localStorage.setItem(recoveryKey,JSON.stringify(current));
}
export default function Upload({refresh}:{refresh:()=>void}) {
  const [items,setItems]=useState<Item[]>([]);
  const [running,setRunning]=useState(false);
  const [drag,setDrag]=useState(false);
  const [message,setMessage]=useState('');
  const [concurrency,setConcurrency]=useState(3);
  const files=useRef<HTMLInputElement>(null), folder=useRef<HTMLInputElement>(null);
  const controllers=useRef(new Map<string,AbortController>());
  const patch=(key:string,fields:Partial<Item>)=>setItems(rows=>rows.map(row=>row.key===key?{...row,...fields}:row));
  function add(files:FileList|File[]) {
    setItems(old=>[...old,...Array.from(files,file=>({key:crypto.randomUUID(),file,progress:0,
      state:!Object.hasOwn(formats,extension(file.name))?'Unsupported format':!file.size?'Empty file':'Ready'}))]);
  }
  async function recover() {
    setRunning(true);
    let remaining=0, restored=0;
    try {
      for (const [id,parts] of Object.entries(recovery())) {
        try {await api('/api/uploads/'+id+'/complete',{method:'POST',body:{parts},timeoutMs:180000}); remember(id,null); restored++;}
        catch {
          const job=await api<{state:string}>('/api/uploads/'+id+'/status').catch(()=>null);
          if (job && ['failed','cancelled','complete'].includes(job.state)) remember(id,null);
          else remaining++;
        }
      }
      setMessage(restored+' recovered · '+remaining+' still pending'); refresh();
    } finally {setRunning(false);}
  }
  async function start() {
    const batch=items.filter(i=>i.state==='Ready'||i.state.startsWith('Failed'));
    if (!batch.length) return;
    if (batch.length>100) {setMessage('Select up to 100 files per batch');return;}
    setRunning(true);setMessage('');
    const prepared:{item:Item;hash:string;controller:AbortController}[]=[];
    try {
      for (const item of batch) {
        const controller=new AbortController();
        controllers.current.set(item.key,controller);
        patch(item.key,{state:'Reading tags and hashing',progress:0,rate:0,id:undefined});
        try {
          const hash=await hashFile(item.file,controller.signal);
          const {parseBlob}=await import('music-metadata');
          const metadata=await parseBlob(item.file).catch(()=>null);
          if (controller.signal.aborted) {patch(item.key,{state:'Cancelled'});continue;}
          patch(item.key,{title:metadata?.common.title,state:'Waiting'});
          prepared.push({item,hash,controller});
        } catch(error) { patch(item.key,{state:controller.signal.aborted?'Cancelled':'Failed: '+(error as Error).message}); }
      }
      if (!prepared.length) return;
      const {plans}=await api<{plans:UploadPlan[]}>('/api/uploads/initiate',{method:'POST',
        body:{files:prepared.map(({item,hash})=>({filename:item.file.name,size:item.file.size,hash}))}});
      let index=0;
      const worker=async()=>{
        while(index<prepared.length) {
          const position=index++;
          const {item,controller}=prepared[position];
          const plan=plans[position];
          if (plan.duplicate) {patch(item.key,{state:'Duplicate',progress:1});continue;}
          patch(item.key,{id:plan.id,state:'Uploading'});
          const parts:Part[]=[];
          let sent=0; const began=performance.now();
          try {
            for (const part of plan.parts) {
              const blob=item.file.slice(sent,sent+plan.partSize);
              let etag='';
              for (let attempt=0;attempt<3;attempt++) {
                try {
                  etag=await put(part.url,blob,plan.parts.length===1?formats[extension(item.file.name)]:null,controller.signal,n=>{
                    patch(item.key,{progress:(sent+n)/item.file.size,rate:(sent+n)*1000/Math.max(500,performance.now()-began)});
                  });break;
                } catch(error) {if (attempt===2||controller.signal.aborted) throw error;
                  await new Promise(resolve=>setTimeout(resolve,500*2**attempt));}
              }
              if (plan.parts.length>1 && !etag) throw new Error('R2 CORS must expose the ETag response header');
              if (etag) parts.push({number:part.number,etag});
              sent+=blob.size;
            }
            if (controller.signal.aborted) throw new DOMException('Cancelled','AbortError');
            remember(plan.id,parts);
            patch(item.key,{state:'Verifying',progress:1,rate:0});
            await api('/api/uploads/'+plan.id+'/complete',{method:'POST',body:{parts},timeoutMs:180000});
            remember(plan.id,null);
            patch(item.key,{state:'Complete',progress:1,rate:0});
          } catch(error) {
            if (sent<item.file.size || controller.signal.aborted)
              await api('/api/uploads/'+plan.id+'/cancel',{method:'POST'}).catch(()=>{});
            patch(item.key,{state:controller.signal.aborted?'Cancelled':'Failed: '+(error as Error).message,rate:0});
          } finally {controllers.current.delete(item.key);}
        }
      };
      await Promise.all(Array.from({length:concurrency},worker));
      refresh();
    } catch(error) {
      for (const item of prepared) patch(item.item.key,{state:'Failed: '+(error as Error).message});
    } finally {setRunning(false);}
  }
  function drop(event:DragEvent) {event.preventDefault();setDrag(false);add(event.dataTransfer.files);}
  const total=items.reduce((a,b)=>a+b.file.size,0);
  const done=items.reduce((a,b)=>a+b.file.size*b.progress,0);
  const rate=items.reduce((a,b)=>a+(b.rate??0),0);
  return <section>
    <div className={'drop '+(drag?'drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={drop}>
      <CloudUpload size={42}/><h2>Drop audio files here</h2><p>MP3, M4A, AAC, FLAC, Opus, Ogg and WAV</p>
      <div className="actions"><button className="primary" onClick={()=>files.current?.click()}>Choose files</button>
        <button onClick={()=>folder.current?.click()}><FolderOpen size={16}/> Choose folder</button></div>
      <input hidden ref={files} type="file" accept="audio/*,.flac,.opus,.ogg,.m4a,.aac" multiple onChange={e=>{if(e.target.files)add(e.target.files);e.target.value='';}}/>
      <input hidden ref={folder} type="file" {...{webkitdirectory:''}} multiple onChange={e=>{if(e.target.files)add(e.target.files);e.target.value='';}}/>
    </div>
    <div className="section-head"><h2>Upload queue</h2><div className="actions">
      <label>Parallel uploads <select value={concurrency} disabled={running} onChange={e=>setConcurrency(Number(e.target.value))}>{[1,2,3,4].map(n=><option key={n}>{n}</option>)}</select></label>
      <button disabled={running} onClick={()=>void recover()}>Recover uploads</button>
      <button disabled={running||!items.some(i=>i.state==='Ready'||i.state.startsWith('Failed'))} className="primary" onClick={()=>void start()}>Upload / retry</button></div></div>
    {message&&<p role="status">{message}</p>}
    {items.length>0&&<><progress value={done} max={total||1}/><p className="muted">{bytes(done)} of {bytes(total)}{rate>0?' · '+bytes(rate)+'/s · '+Math.ceil((total-done)/rate)+'s remaining':''}</p></>}
    {items.map(i=><div className="file-row" key={i.key}><Music size={20}/><div className="fill"><strong>{i.title||i.file.name}</strong><small>{bytes(i.file.size)} · {i.state}</small>
      {i.progress>0&&i.progress<1&&<progress value={i.progress} max={1}/>}</div>
      {!['Complete','Duplicate','Verifying'].includes(i.state)&&<button aria-label={'Cancel '+i.file.name} onClick={()=>{const controller=controllers.current.get(i.key); if(running&&controller){controller.abort();patch(i.key,{state:'Cancelled'});}else setItems(rows=>rows.filter(row=>row.key!==i.key));}}><X size={16}/></button>}</div>)}
  </section>;
}
