import { AppState, DeviceEventEmitter, NativeModules } from 'react-native';
import { useEffect,useState,useSyncExternalStore } from 'react';
import { createClient } from '@resonant/api-client';
import type { Change, Playlist, Track } from '@resonant/types';
export interface Song extends Track { local?:boolean;nativeArtwork?:string }
export interface Download {id:string;state:string;bytes:number;size:number;error?:string}
export interface Library {tracks:Song[];playlists:Playlist[];downloads:Download[]}
export interface Credential {base:string;token:string;id:string}
interface NativeBridge {
  debugBuild:boolean;
  getCredentials():Promise<string|null>;saveCredentials(value:string):Promise<void>;resetCredentials():Promise<void>;
  getLibrary(term:string,limit:number,offset:number):Promise<string>; getState(key:string):Promise<string|null>;setState(key:string,value:string):Promise<void>;
  pending():Promise<string>;enqueue(value:string):Promise<void>;confirm(value:string):Promise<void>;apply(value:string):Promise<void>;
  importLocal():Promise<number>;startDownload(ids:string,wifi:boolean):Promise<void>;removeDownload(id:string):Promise<void>;
  playQueue(tracks:string,index:number):Promise<void>;addQueue(track:string,next:boolean):Promise<void>;
  command(name:string,value:number,second:number):Promise<void>;observePlayback(active:boolean):Promise<void>;
}
export const native=NativeModules.ResonantNative as NativeBridge;
export const readLibrary=async(q='',limit=500,offset=0):Promise<Library>=>JSON.parse(await native.getLibrary(q,limit,offset));
export const command=(name:string,value=0,second=0)=>native.command(name,value,second);
export const createId=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
  const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16);
});

let active:Promise<void>|null=null;
export async function synchronize(credential:Credential,update:()=>void) {
  if(active)return active;
  if(await native.getState('ownerBase')!==credential.base) {
    throw new Error('This library belongs to a different API installation');
  }
  if(active)return active;
  const api=createClient(credential.base,credential.token);
  active=(async()=>{
    for(let batch=0;batch<20;batch++){
      const operations=JSON.parse(await native.pending());
      if(!operations.length)break;
      const {applied}=await api<{applied:string[]}>('/api/sync/changes',{method:'POST',body:{operations}});
      await native.confirm(JSON.stringify(applied));
    }
    let cursor=+(await native.getState('cursor')??0);
    for(let page=0;page<50;page++){
      const result=await api<{items:Change[];cursor:number;more:boolean}>('/api/sync?after='+cursor);
      if(result.items.length){await native.apply(JSON.stringify(result));update();}
      cursor=result.cursor;
      if(!result.more)break;
    }
  })().finally(()=>{active=null;});
  return active;
}

interface QueueTrack {id:string;title:string;artist:string;artwork:string}
export interface Playback {queue:QueueTrack[];index:number;playing:boolean;buffering:boolean;shuffle:boolean;repeat:number;error:string}
const initial:Playback={queue:[],index:0,playing:false,buffering:false,shuffle:false,repeat:0,error:''};
let playback=initial;
let timing={position:0,duration:0,volume:0};
const stateListeners=new Set<()=>void>(),timeListeners=new Set<()=>void>();
const subscribeState=(fn:()=>void)=>{stateListeners.add(fn);return()=>{stateListeners.delete(fn);};};
const subscribeTime=(fn:()=>void)=>{timeListeners.add(fn);return()=>{timeListeners.delete(fn);};};
export const usePlayback=()=>useSyncExternalStore(subscribeState,()=>playback);
export const useTiming=()=>useSyncExternalStore(subscribeTime,()=>timing);
export function usePlaybackUpdates(onError:(error:unknown)=>void) {
  useEffect(()=>{
    const playbackEvents=DeviceEventEmitter.addListener('ResonantPlayback',(raw:string)=>{
      const {position,duration,volume,...state}=JSON.parse(raw);
      if(JSON.stringify(state)!==JSON.stringify(playback)){playback=state;stateListeners.forEach(fn=>fn());}
      if(position!==timing.position||duration!==timing.duration||volume!==timing.volume){
        timing={position,duration,volume};timeListeners.forEach(fn=>fn());
      }
    });
    const lifecycle=AppState.addEventListener('change',state=>void native.observePlayback(state==='active').catch(onError));
    void native.observePlayback(AppState.currentState==='active'||AppState.currentState===null).catch(onError);
    return()=>{playbackEvents.remove();lifecycle.remove();void native.observePlayback(false).catch(()=>{});};
  },[onError]);
}
const covers=new Map<string,Promise<string|undefined>>();
export function useArtwork(track:Song|undefined,credential:Credential|null) {
  const [key,setKey]=useState('');
  const [uri,setUri]=useState('');
  const id=track?.id??'';
  useEffect(()=>{
    let active=true;
    if(!track?.artwork||!credential)return;
    const cacheKey=credential.base+'|'+id;
    if(!covers.has(cacheKey)) {
      if(covers.size>=300)covers.delete(covers.keys().next().value!);
      const p=createClient(credential.base,credential.token)<{artwork?:string}>('/api/tracks/'+id+'/stream-url')
        .then(r=>r.artwork).catch(()=>{covers.delete(cacheKey);return undefined;});
      covers.set(cacheKey,p);
      setTimeout(()=>covers.delete(cacheKey),3*60*60*1000);
    }
    void covers.get(cacheKey)?.then(result=>{if(active){setUri(result??'');setKey(id);}});
    return()=>{active=false;};
  },[id,track?.artwork,credential]);
  return track?.nativeArtwork||(id===key?uri:'');
}
