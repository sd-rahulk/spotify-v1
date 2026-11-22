'use client';
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { AudioLines, CloudUpload, Disc3, Download, HardDrive, House, ListMusic, Music2, Play, Search, Settings, Users } from 'lucide-react';
import { ApiError,createClient } from '@resonant/api-client';
import { bytes,clock } from '@resonant/shared';
import type { Device,Group,Page,Playlist,Track,Usage } from '@resonant/types';
import Upload from './upload';
import Player,{type Playback} from './player';
const api=createClient('/gateway');
const nav=[['Home',House],['All Songs',Music2],['Albums',Disc3],['Artists',Users],['Playlists',ListMusic],['Upload Music',CloudUpload],['Storage',HardDrive],['Settings',Settings]] as const;
type Section=typeof nav[number][0];
type Collection={id:string;name:string;tracks:Track[];trackIds?:string[];artwork?:string;artist?:string;coverTrackId?:string};
type Job={_id:string;filename:string;error?:string;state:string};
const image=(path?:string)=>path?'/gateway'+path:undefined;
function Artwork({path,large=false}:{path?:string;large?:boolean}) {
  return image(path)?<img className={large?'cover':'thumb'} alt="" src={image(path)}/>:<span className={large?'cover':'thumb'}><Music2 size={large?32:18}/></span>;
}
export default function Dashboard() {
  const [signed,setSigned]=useState<boolean|null>(null);
  const [unavailable,setUnavailable]=useState(false);
  const [section,setSection]=useState<Section>('Home');
  const [tracks,setTracks]=useState<Track[]>([]);
  const [groups,setGroups]=useState<Group[]>([]);
  const [playlists,setPlaylists]=useState<Playlist[]>([]);
  const [collection,setCollection]=useState<Collection|null>(null);
  const [usage,setUsage]=useState<Usage|null>(null),[jobs,setJobs]=useState<Job[]>([]);
  const [devices,setDevices]=useState<Device[]>([]),[code,setCode]=useState<{code:string;api:string;expiresIn:number}|null>(null);
  const [q,setQ]=useState(''),[format,setFormat]=useState(''),[sort,setSort]=useState('recent'),[next,setNext]=useState<string|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [editing,setEditing]=useState<Track|null>(null);
  const [name,setName]=useState('');
  const [albumArtist,setAlbumArtist]=useState('');
  const [password,setPassword]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [playing,setPlaying]=useState<Playback|null>(null);
  const [dragging,setDragging]=useState<string|null>(null);
  const [target,setTarget]=useState('');
  const error=useCallback((e:unknown)=>{
    if(e instanceof ApiError&&e.status===401)setSigned(false);
    setMessage(e instanceof Error?e.message:String(e));
  },[]);
  const checkConnection=useCallback(async()=>{
    setSigned(null);setUnavailable(false);setMessage('');
    try {await api('/api/auth/session');setSigned(true);}
    catch(e) {
      setSigned(false);
      if(!(e instanceof ApiError&&e.status===401)){setUnavailable(true);error(e);}
    }
  },[error]);
  useEffect(()=>{void checkConnection();},[checkConnection]);
  function navigate(value:Section) {setSection(value);setCollection(null);setQ('');setSelected(new Set());setMessage('');setName('');setLoaded(false);}
  const refresh=useCallback(async(cursor?:string,signal?:AbortSignal)=>{
    if(!signed)return;
    try {
      if(section==='Storage'||section==='Home'||section==='Settings') {
        const result=await api<Usage>('/api/usage',{signal});
        if(signal?.aborted)return;
        setUsage(result);
      }
      if(['All Songs','Home','Storage'].includes(section)) {
        const params=new URLSearchParams({q,sort:section==='Storage'?'size':sort,limit:section==='All Songs'?'60':'12'});
        if(format&&section==='All Songs')params.set('format',format);
        if(cursor)params.set('cursor',cursor);
        const result=await api<Page<Track>>('/api/tracks?'+params,{signal});
        if(signal?.aborted)return;
        setTracks(old=>cursor?[...old,...result.items]:result.items);setNext(result.next);
      }
      if(section==='Albums'||section==='Artists') {
        const result=await api<{items:Group[]}>('/api/'+section.toLowerCase(),{signal});
        if(!signal?.aborted)setGroups(result.items);
      }
      if(section==='Playlists'||section==='All Songs'||section==='Home') {
        const result=await api<{items:Playlist[]}>('/api/playlists',{signal});
        if(!signal?.aborted)setPlaylists(result.items);
      }
      if(section==='Settings') {
        const result=await api<Device[]>('/api/auth/devices',{signal});
        if(!signal?.aborted)setDevices(result);
      }
      if(section==='Storage') {
        const result=await api<Job[]>('/api/uploads/jobs',{signal});
        if(!signal?.aborted)setJobs(result);
      }
      if(!signal?.aborted)setLoaded(true);
    } catch(e) {if(!signal?.aborted){error(e);setLoaded(true);}}
  },[signed,section,q,sort,format,error]);
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>void refresh(undefined,controller.signal),q?160:0);
    return()=>{clearTimeout(timer);controller.abort();};},[refresh,q]);
  async function login(e:FormEvent) {
    e.preventDefault();setBusy(true);setMessage('');
    try{await api('/api/auth/login',{method:'POST',body:{password}});setPassword('');setSigned(true);}
    catch(e){error(e);}finally{setBusy(false);}
  }
  async function perform(fn:()=>Promise<unknown>,success?:string) {
    setMessage('');setBusy(true);
    try{await fn();if(success)setMessage(success);}
    catch(e){error(e);}finally{setBusy(false);}
  }
  async function open(kind:string,id:string) {
    const row=await api<Collection>('/api/'+kind+'/'+id);
    setCollection(row);setName(row.name);setAlbumArtist(row.artist??"");setSelected(new Set());
  }
  const play=(rows:Track[],index=0)=>setPlaying({tracks:rows,index,request:Date.now()});
  async function remove(ids:string[]) {
    if(!confirm('Permanently delete '+ids.length+' selected track(s) from your library?'))return;
    await perform(async()=>{for(const id of ids)await api('/api/tracks/'+id,{method:'DELETE'});setSelected(new Set());
      if(collection)await open(section.toLowerCase(),collection.id).catch(()=>setCollection(null));await refresh();},'Tracks removed');
  }
  async function order(from:string,to:string) {
    if(!collection?.trackIds||from===to)return;
    const ids=[...collection.trackIds];
    const found=ids.indexOf(from), destination=ids.indexOf(to);
    if(found<0||destination<0)return;
    ids.splice(found,1);ids.splice(destination,0,from);
    await perform(async()=>{await api('/api/playlists/'+collection.id+'/order',{method:'PATCH',body:{trackIds:ids}});await open('playlists',collection.id);});
  }
  function table(rows:Track[],full=false) {
    return rows.length?<div className="table-scroll"><table><thead><tr><th><span className="sr-only">Select or play</span></th><th>Title</th><th>Album</th>
      <th>Time</th>{full&&<><th>Format</th><th>Size</th><th>Added</th></>}<th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{rows.map((track,index)=><tr key={track.id} onDragOver={e=>{if(collection?.trackIds)e.preventDefault();}}
        onDrop={e=>{e.preventDefault();if(dragging)void order(dragging,track.id);setDragging(null);}}>
        <td>{full&&<input type="checkbox" aria-label={'Select '+track.title} checked={selected.has(track.id)} onChange={()=>setSelected(old=>{const result=new Set(old);if(result.has(track.id))result.delete(track.id);else result.add(track.id);return result;})}/>}
          {!full&&<button aria-label={'Play '+track.title} onClick={()=>play(rows,index)}><Play size={15}/></button>}</td>
        <td><button className="track" onClick={()=>play(rows,index)}><Artwork path={track.artwork}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button></td>
        <td>{track.album}</td><td>{clock(track.duration)}</td>
        {full&&<><td>{track.filename.split('.').pop()?.toUpperCase()}<small>{Math.round(track.bitrate/1000)} kbps</small></td><td>{bytes(track.size)}</td><td>{track.createdAt.slice(0,10)}</td></>}
        <td><div className="actions"><button onClick={()=>setEditing(track)}>Edit</button>
          {collection?.trackIds&&<><button draggable onDragStart={()=>setDragging(track.id)} onDragEnd={()=>setDragging(null)}
            onClick={()=>{if(index>0)void order(track.id,rows[index-1].id);}} aria-label={'Move '+track.title+' up'}>↕</button>
            <button onClick={()=>void perform(async()=>{await api('/api/playlists/'+collection.id+'/tracks/'+track.id,{method:'DELETE'});await open('playlists',collection.id);})}>Remove</button></>}</div></td></tr>)}</tbody></table></div>
      :<div className="empty"><Music2 size={28}/><p>No tracks to show.</p></div>;
  }
  if(signed===null)return <main className="login"><AudioLines/><p>Connecting to Resonant…</p></main>;
  if(unavailable)return <main className="login"><form onSubmit={e=>{e.preventDefault();void checkConnection();}}>
    <span className="brand"><AudioLines/> Resonant</span><h1>Connect your library</h1>
    <p className="muted">Start the Fastify API with its environment configured. Set the dashboard API_ORIGIN to that server, then try again.</p>
    {message&&<p role="alert">{message}</p>}<button className="primary">Retry connection</button></form></main>;
  if(!signed)return <main className="login"><form onSubmit={login}><span className="brand"><AudioLines/> Resonant</span><h1>Open your library</h1>
    <label>Owner password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
    {message&&<p role="alert">{message}</p>}<button disabled={busy} className="primary">Sign in</button></form></main>;
  const sectionTitle=collection?.name??section;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><AudioLines size={26}/> Resonant</div><nav aria-label="Library navigation">
      {nav.map(([value,Icon])=><button key={value} aria-current={section===value?'page':undefined} onClick={()=>navigate(value)}><Icon size={19}/><span>{value}</span></button>)}</nav>
      {usage&&<div className="sidebar-storage"><small>Library storage</small><progress value={usage.used} max={usage.quota}/><small>{bytes(usage.used)} of {bytes(usage.quota)}</small></div>}
    </aside>
    <main className="content">
      <header><div><p className="section-label">Personal music library</p><h1>{sectionTitle}</h1></div>
        {collection&&<button onClick={()=>{setCollection(null);setName('');}}>Back to {section.toLowerCase()}</button>}
        {section==='Home'&&<button className="primary" onClick={()=>navigate('Upload Music')}><CloudUpload size={18}/> Upload music</button>}
      </header>
      {message&&<p className="message" role="status">{message}<button aria-label="Dismiss message" onClick={()=>setMessage('')}>×</button></p>}
      {!loaded&&section!=='Upload Music'&&<p role="status" className="muted">Loading library…</p>}
      {section==='Home'&&loaded&&<><div className="summary"><button onClick={()=>navigate('All Songs')}><Music2/><strong>{usage?.tracks??0} songs</strong></button>
        <button onClick={()=>navigate('Albums')}><Disc3/><strong>{usage?.albums??0} albums</strong></button>
        <button onClick={()=>navigate('Playlists')}><ListMusic/><strong>{usage?.playlists??0} playlists</strong></button></div><h2>Recently added</h2>{table(tracks)}</>}
      <div hidden={section!=='Upload Music'}><Upload refresh={()=>void api<Usage>('/api/usage').then(setUsage).catch(error)}/></div>
      {section==='All Songs'&&<><div className="toolbar"><label className="search"><Search size={19}/><input aria-label="Search songs" placeholder="Search songs, artists, albums…" value={q} onChange={e=>setQ(e.target.value)}/></label>
        <select aria-label="Sort tracks" value={sort} onChange={e=>setSort(e.target.value)}><option value="recent">Recently added</option><option value="title">Title</option><option value="size">Largest files</option><option value="played">Most played</option></select>
        <select aria-label="Filter file format" value={format} onChange={e=>setFormat(e.target.value)}><option value="">All formats</option>{Object.entries({mpeg:'MP3',mp4:'M4A',aac:'AAC',flac:'FLAC',ogg:'Ogg / Opus',wav:'WAV'}).map(([key,value])=><option value={key} key={key}>{value}</option>)}</select></div>
        {selected.size>0&&<div className="toolbar"><span>{selected.size} selected</span><button disabled={busy} onClick={()=>void remove([...selected])}>Delete selected</button>
          <select aria-label="Choose playlist" value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose playlist</option>{playlists.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button disabled={busy||!target} onClick={()=>void perform(async()=>{await api('/api/playlists/'+target+'/tracks',{method:'POST',body:{trackIds:[...selected]}});setSelected(new Set());},'Added to playlist')}>Add selected</button></div>}
        {loaded&&table(tracks,true)}{next&&<button onClick={()=>void refresh(next)}>Load more</button>}</>}
      {(section==='Albums'||section==='Artists'||section==='Playlists')&&<>{section==='Playlists'&&<form className="toolbar" onSubmit={e=>{e.preventDefault();void perform(async()=>{
        if(collection){await api('/api/playlists/'+collection.id,{method:'PATCH',body:{name}});await open('playlists',collection.id);}
        else{await api('/api/playlists',{method:'POST',body:{name}});setName('');}await refresh();});}}>
        <input aria-label="Playlist name" required maxLength={240} placeholder="Playlist name" value={name} onChange={e=>setName(e.target.value)}/><button className="primary" disabled={busy}>{collection?'Rename':'Create playlist'}</button>
        {collection&&<button type="button" onClick={()=>{if(confirm('Delete this playlist?'))void perform(async()=>{await api('/api/playlists/'+collection.id,{method:'DELETE'});setCollection(null);setName('');await refresh();});}}>Delete playlist</button>}</form>}
        {collection?<>{section!=="Playlists"&&<form className="toolbar" onSubmit={event=>{event.preventDefault();void perform(async()=>{
            const kind=section.toLowerCase();
            const {id}=await api<{id:string}>("/api/"+kind+"/"+collection.id,{method:"PATCH",body:{name,...(section==="Albums"&&albumArtist.trim()?{albumArtist}: {})}});
            await open(kind,id);await refresh();
          },"Collection tags saved");}}>
            <input aria-label="Collection name" value={name} onChange={event=>setName(event.target.value)} required maxLength={240}/>
            {section==="Albums"&&<input aria-label="Album artist" value={albumArtist} onChange={event=>setAlbumArtist(event.target.value)} maxLength={240}/>}
            <button className="primary">Save collection tags</button>
            {section==="Albums"&&collection.tracks[0]&&<button type="button" onClick={()=>setEditing(collection.tracks.find(t=>t.artwork===collection.artwork)??collection.tracks[0])}>Edit representative track artwork</button>}
          </form>}
          {section==="Playlists"&&collection.tracks.some(t=>t.artwork)&&<label className="toolbar">Playlist artwork
            <select value={collection.coverTrackId??""} onChange={event=>{const coverTrackId=event.target.value||null;void perform(async()=>{
              await api("/api/playlists/"+collection.id,{method:"PATCH",body:{coverTrackId}});await open("playlists",collection.id);await refresh();
            });}}><option value="">Default artwork</option>{collection.tracks.filter(t=>t.artwork).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
          <div className="toolbar"><button className="primary" disabled={!collection.tracks.length} onClick={()=>play(collection.tracks)}><Play size={16}/> Play collection</button><span>{collection.tracks.length} tracks · {clock(collection.tracks.reduce((sum,t)=>sum+t.duration,0))}</span></div>{table(collection.tracks)}</>
          :loaded&&<div className="grid">{(section==='Playlists'?playlists:groups).map(g=><button className="tile" key={g.id} onClick={()=>void perform(()=>open(section.toLowerCase(),g.id))}>
            <Artwork path={g.artwork} large/><strong>{g.name}</strong><small>{'count' in g?g.count:g.trackIds.length} tracks</small></button>)}</div>}</>}
      {section==='Storage'&&usage&&<><section className="panel"><h2>Application quota</h2>
        <strong>{bytes(usage.used)} stored · {bytes(usage.reserved)} reserved</strong><progress value={usage.used+usage.reserved} max={usage.quota}/>
        <p>{bytes(Math.max(0,usage.quota-usage.used-usage.reserved))} available of {bytes(usage.quota)}{(usage.used+usage.reserved)/usage.quota>=0.85?' · Near quota':''}</p>
        <small>Application measurements. Cloudflare bills independently for storage and operations. Check the provider dashboard for current usage and allowances.</small>
        <p>{usage.tracks} tracks · {usage.albums} albums · {usage.artists} artists · {usage.playlists} playlists</p>
        <p>{Object.entries(usage.formats).map(([name,count])=>name.toUpperCase()+' '+count).join(' · ')}</p></section>
        <h2>Largest files</h2>{table(tracks,true)}<h2>Upload jobs</h2>{jobs.length?jobs.map(j=><p key={j._id}>{j.filename} · {j.state}{j.error?' · '+j.error:''}</p>):<p className="muted">No outstanding upload jobs.</p>}</>}
      {section==='Settings'&&<><section className="panel"><h2>Paired Android devices</h2><button className="primary" onClick={()=>void perform(async()=>setCode(await api('/api/auth/pairing-code',{method:'POST'})))}>Create pairing code</button>
        {code&&<div className="pair"><code>{code.code}</code><small>Expires 5 minutes after creation. Android API URL: {code.api}</small></div>}
        {devices.map(d=><div className="file-row" key={d.id}><div className="fill"><strong>{d.name}</strong><small>Valid until {d.expiresAt.slice(0,10)}</small></div>
          <button onClick={()=>{if(confirm('Revoke access for '+d.name+'?'))void perform(async()=>{await api('/api/auth/devices/'+d.id,{method:'DELETE'});await refresh();});}}>Revoke</button></div>)}</section>
        <section className="panel"><h2>Maintenance and backup</h2><p>{usage?'API and database connected':'Waiting for server diagnostics'}</p><div className="actions">
          <button onClick={()=>void perform(async()=>{const data=await api('/api/backup');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='resonant-library.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})}>Export library metadata</button>
          <label className="restore">Restore manifest <input aria-label="Restore manifest" type="file" accept=".json,application/json" onChange={event=>{const file=event.target.files?.[0];event.target.value="";if(file&&confirm("Restore this metadata into an empty database? The bucket must already contain the original objects."))void perform(async()=>{const body=JSON.parse(await file.text());const result=await api<{tracks:number;playlists:number}>("/api/backup/restore",{method:"POST",body});await refresh();setMessage(result.tracks+" tracks and "+result.playlists+" playlists restored");});}}/></label>
          <button onClick={()=>void perform(async()=>{const result=await api<{missing:string[];mismatched:string[]}>('/api/backup/check',{method:'POST'});setMessage(result.missing.length||result.mismatched.length?result.missing.length+' missing and '+result.mismatched.length+' mismatched objects':'All library objects passed the check');})}>Check cloud objects</button>
          <button onClick={()=>void perform(()=>api('/api/maintenance/cleanup',{method:'POST'}),'Cleanup requested')}>Clean expired transfers</button>
        </div></section><section className="panel"><h2>Owner session</h2><button onClick={()=>void perform(async()=>{await api('/api/auth/logout',{method:'POST'});setSigned(false);setPlaying(null);})}>Sign out</button></section></>}
    </main>
    <Player selection={playing} onError={setMessage}/>
    {editing&&<dialog open className="editor" aria-label="Edit song"><form onSubmit={e=>{e.preventDefault();void perform(async()=>{
      const {title,artist,album,albumArtist,genre,trackNumber,discNumber,lyrics,liked}=editing;
      await api('/api/tracks/'+editing.id,{method:'PATCH',body:{title,artist,album,albumArtist,genre,trackNumber,discNumber,lyrics,liked}});
      setEditing(null);if(collection)await open(section.toLowerCase(),collection.id);await refresh();},'Metadata saved');}}>
      <div className="section-head"><h2>Edit track</h2><button type="button" onClick={()=>setEditing(null)}>Close</button></div>
      <p className="muted">{editing.filename} · {editing.codec} · {bytes(editing.size)}</p>
      <div className="fields">{(['title','artist','album','albumArtist','genre','trackNumber','discNumber'] as const).map(field=><label key={field}>{field.replace(/([A-Z])/g,' $1')}<input required={field==='title'} type={typeof editing[field]==='number'?'number':'text'} min={0} maxLength={240} value={editing[field]}
        onChange={e=>setEditing({...editing,[field]:typeof editing[field]==='number'?+e.target.value:e.target.value})}/></label>)}</div>
      <label>Replace artwork <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>{
        const file=event.target.files?.[0];event.target.value="";if(!file)return;
        if(file.size>1024*1024){setMessage("Artwork must be 1 MiB or smaller");return;}
        void perform(async()=>{const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>resolve(String(reader.result).split(",")[1]);reader.readAsDataURL(file);});
          const result=await api<Track>("/api/tracks/"+editing.id+"/artwork",{method:"PUT",body:{data}});
          setEditing(old=>old&&old.id===result.id?{...old,artwork:result.artwork}:old);await refresh();
        },"Artwork saved");
      }}/></label>
      <label>Lyrics<textarea value={editing.lyrics} maxLength={64000} onChange={e=>setEditing({...editing,lyrics:e.target.value})}/></label>
      <label className="actions">Import LRC or text <input type="file" accept=".lrc,.txt" onChange={e=>{const file=e.target.files?.[0];if(file&&file.size<=256000)void file.text().then(lyrics=>setEditing(old=>old?{...old,lyrics:lyrics.slice(0,64000)}:old));}}/></label>
      <label className="actions"><input type="checkbox" checked={editing.liked} onChange={e=>setEditing({...editing,liked:e.target.checked})}/> Liked</label>
      <div className="actions"><button disabled={busy} className="primary">Save changes</button>
        <button type="button" onClick={()=>play([editing])}><Play size={16}/> Preview</button>
        <button type="button" onClick={()=>void perform(async()=>{const {url}=await api<{url:string}>('/api/tracks/'+editing.id+'/download-url');location.assign(url);})}><Download size={16}/> Original</button>
        <button type="button" onClick={()=>{void remove([editing.id]).then(()=>setEditing(null));}}>Delete</button></div>
    </form></dialog>}
  </div>;
}
