'use client';
import { useEffect,useRef,useState } from 'react';
import { ListMusic, Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { clock } from '@resonant/shared';
import { createClient } from '@resonant/api-client';
import type { Track } from '@resonant/types';
const api=createClient('/gateway');
export type Playback={tracks:Track[];index:number;request:number};
export default function Player({selection,onError}:{selection:Playback|null;onError:(s:string)=>void}) {
  const audio=useRef<HTMLAudioElement>(null);
  const sequence=useRef(0);
  const [queue,setQueue]=useState<Track[]>([]);
  const [index,setIndex]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0), [duration,setDuration]=useState(0), [volume,setVolume]=useState(1);
  const [shuffle,setShuffle]=useState(false),[repeat,setRepeat]=useState(0),[open,setOpen]=useState(false);
  const track=queue[index];
  async function load(items:Track[],next:number,retryAt=0) {
    const current=items[next]; if(!current||!audio.current)return;
    const request=++sequence.current;
    setQueue(items);setIndex(next);setPosition(retryAt);setDuration(0);
    audio.current.pause();
    try {
      const {url}=await api<{url:string}>('/api/tracks/'+current.id+'/stream-url');
      if(request!==sequence.current||!audio.current)return;
      audio.current.src=url;
      if(retryAt) audio.current.currentTime=retryAt;
      await audio.current.play().catch((error:Error)=>{if(error.name!=='NotAllowedError')throw error;});
    } catch(error) {if(request===sequence.current)onError((error as Error).message);}
  }
  useEffect(()=>{if(selection) void load(selection.tracks,selection.index);},[selection]);
  function move(offset:number,ended=false) {
    if(!queue.length)return;
    if(ended&&repeat===1){void load(queue,index);return;}
    let next=index+offset;
    if(shuffle&&offset>0&&queue.length>1) next=(index+1+Math.floor(Math.random()*(queue.length-1)))%queue.length;
    if(next>=0&&next<queue.length)void load(queue,next);
    else if(repeat===2)void load(queue,(next+queue.length)%queue.length);
  }
  const toggle=()=>{if(!audio.current||!track)return;if(audio.current.paused)void audio.current.play().catch(error=>onError(error.message));else audio.current.pause();};
  useEffect(()=>{
    if(!track||!('mediaSession' in navigator))return;
    navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album,
      artwork:track.artwork?[{src:new URL('/gateway'+track.artwork,location.origin).toString()}]:[]});
    const actions:Partial<Record<MediaSessionAction,MediaSessionActionHandler>>={play:toggle,pause:toggle,nexttrack:()=>move(1),previoustrack:()=>move(-1),seekto:e=>{if(audio.current&&e.seekTime!==undefined)audio.current.currentTime=e.seekTime;}};
    for(const action of Object.keys(actions) as MediaSessionAction[])navigator.mediaSession.setActionHandler(action,actions[action]!);
    return ()=>{for(const action of Object.keys(actions) as MediaSessionAction[])navigator.mediaSession.setActionHandler(action,null);};
  },[track,index,queue,repeat,shuffle]);
  return <footer className="player">
    <audio ref={audio} preload="metadata" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}
      onDurationChange={e=>setDuration(Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:0)}
      onTimeUpdate={e=>setPosition(e.currentTarget.currentTime)} onEnded={()=>{setPlaying(false);move(1,true);}}
      onError={()=>{if(track){setPlaying(false);onError('Audio could not be decoded or the stream expired. Select the track to retry.');}}}/>
    <div className="current">{track?.artwork?<img className="thumb" src={'/gateway'+track.artwork} alt=""/>:<span className="thumb"><Music size={20}/></span>}
      <div><strong>{track?.title??'Nothing playing'}</strong><small>{track?.artist??'Select a track to preview'}</small></div></div>
    <div className="transport"><div className="controls">
      <button aria-label="Shuffle" aria-pressed={shuffle} onClick={()=>setShuffle(!shuffle)}><Shuffle size={17}/></button>
      <button aria-label="Previous" onClick={()=>move(-1)}><SkipBack size={18}/></button>
      <button className="play" aria-label={playing?'Pause':'Play'} disabled={!track} onClick={toggle}>{playing?<Pause size={18}/>:<Play size={18}/>}</button>
      <button aria-label="Next" onClick={()=>move(1)}><SkipForward size={18}/></button>
      <button aria-label={'Repeat '+['off','one','all'][repeat]} aria-pressed={repeat!==0} onClick={()=>setRepeat((repeat+1)%3)}>{repeat===1?<Repeat1 size={17}/>:<Repeat size={17}/>}</button>
    </div><div className="seek"><small>{clock(position)}</small><input aria-label="Playback position" type="range" min="0" max={duration||1} step=".1" value={position} disabled={!duration} onChange={e=>{if(audio.current)audio.current.currentTime=+e.target.value;}}/><small>{clock(duration)}</small></div></div>
    <div className="volume"><button aria-label="Show queue" aria-expanded={open} onClick={()=>setOpen(!open)}><ListMusic size={20}/></button><Volume2 size={17}/><input type="range" aria-label="Volume" min="0" max="1" step=".05" value={volume} onChange={e=>{setVolume(+e.target.value);if(audio.current)audio.current.volume=+e.target.value;}}/></div>
    {open&&<div className="queue"><h3>Playback queue</h3>{queue.map((row,i)=><button key={row.id} aria-current={i===index} onClick={()=>void load(queue,i)}>{row.title}<small>{row.artist}</small></button>)}</div>}
  </footer>;
}
