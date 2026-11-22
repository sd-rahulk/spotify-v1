import {memo,useCallback,useEffect,useMemo,useState} from 'react';
import {Alert,AppState,Keyboard,Modal,Pressable,RefreshControl,ScrollView,StatusBar,Text,TextInput,View} from 'react-native';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {FlashList} from '@shopify/flash-list';
import {ApiError,createClient} from '@resonant/api-client';
import type {Playlist} from '@resonant/types';
import {bytes,clock} from '@resonant/shared';
import {createId,native,readLibrary,synchronize,usePlaybackUpdates,type Credential,type Download,type Library,type Song} from './src/native';
import {Art,Button,Mini,Now} from './src/player';
import {C,S} from './src/styles';

type Tab='Home'|'Search'|'Library'|'Settings';
const EMPTY:Library={tracks:[],playlists:[],downloads:[]};
const views=['All songs','Liked songs','Playlists','Albums','Artists','Downloaded','Local files','Cloud songs','Recently added','Recently played'] as const;
type Filter=typeof views[number];
const tracksFor=(p:Playlist,songs:Map<string,Song>)=>p.trackIds.flatMap(id=>songs.has(id)?[songs.get(id)!]:[]);
const stringify=JSON.stringify;
const left=(track:Song)=>track.artist+' · '+track.album;
const TrackRow=memo(function TrackRow({track,credential,download,play,menu}:{track:Song;credential:Credential|null;download?:Download;play:()=>void;menu:()=>void}) {
  return <View style={S.track}><Pressable accessibilityRole="button" accessibilityLabel={'Play '+track.title} onPress={play} style={[S.row,{flex:1}]}>
    <Art track={track} credential={credential}/><View style={{flex:1}}><Text numberOfLines={1} style={S.text}>{track.title}</Text>
      <Text numberOfLines={1} style={S.muted}>{download?.state==='Complete'?'↓ ':''}{left(track)}</Text>
      {!!download&&download.state!=='Complete'&&<Text numberOfLines={1} style={S.muted}>{download.state} · {Math.floor(100*download.bytes/(download.size||1))}% {download.error}</Text>}</View></Pressable>
    <Button label={'Options for '+track.title} onPress={menu}>⋯</Button></View>;
});

export default function App() {return <SafeAreaProvider><StatusBar barStyle="light-content"/><Resonant/></SafeAreaProvider>;}
function Resonant() {
  const [tab,setTab]=useState<Tab>('Home');
  const [filter,setFilter]=useState<Filter>('All songs');
  const [sort,setSort]=useState(false);
  const [library,setLibrary]=useState(EMPTY);
  const [extra,setExtra]=useState<Song[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [searchRows,setSearchRows]=useState<Song[]>([]);
  const [query,setQuery]=useState('');
  const [history,setHistory]=useState<string[]>([]);
  const [credential,setCredential]=useState<Credential|null>(null);
  const [apiBase,setApiBase]=useState((native.debugBuild ?? __DEV__)?'http://10.0.2.2:4100':'');
  const [code,setCode]=useState('');
  const [deviceName,setDeviceName]=useState('Android');
  const [status,setStatus]=useState('');
  const [syncing,setSyncing]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const [trackMenu,setTrackMenu]=useState<Song|null>(null);
  const [collection,setCollection]=useState<{name:string;ids:string[];playlistId?:string}|null>(null);
  const [editing,setEditing]=useState<{id:string;name:string}|null>(null);
  const [wifi,setWifi]=useState(false);
  const [cache,setCache]=useState('192');
  const [pairing,setPairing]=useState(false);
  const fail=useCallback((error:unknown)=>setStatus(error instanceof Error?error.message:String(error)),[]);
  const run=useCallback((p:Promise<unknown>)=>void p.catch(fail),[fail]);
  usePlaybackUpdates(fail);
  const reload=useCallback(async()=>{
    const result=await readLibrary();
    setLibrary(result);setExtra([]);setHasMore(result.tracks.length===500);
  },[]);
  useEffect(()=>{
    run(reload());
    run(native.getCredentials().then(raw=>{if(raw){const saved=JSON.parse(raw) as Credential;setCredential(saved);setApiBase(saved.base);}}));
    run(native.getState('wifi').then(value=>setWifi(value==='true')));
    run(native.getState('cacheMb').then(value=>{if(value)setCache(value);}));
    run(native.getState('searches').then(value=>{if(value)setHistory(JSON.parse(value));}));
  },[reload,run]);
  const sync=useCallback(async()=>{
    if(!credential){await reload();return;}
    setSyncing(true);
    try {await synchronize(credential,()=>{});await reload();setStatus('');}
    catch(error){
      if(error instanceof ApiError&&error.status===401) {
        setStatus('Device authorization expired or was revoked. Open Settings to pair it again.');
        setCredential(null);await native.resetCredentials();setTab('Settings');
      } else fail(error);
    } finally {setSyncing(false);}
  },[credential,fail,reload]);
  useEffect(()=>{
    if(!credential)return;
    const state=AppState.addEventListener('change',value=>{if(value==='active')void sync();});
    const timer=setInterval(()=>{if(AppState.currentState==='active')void sync();},30000);
    void sync();
    return()=>{state.remove();clearInterval(timer);};
  },[credential,sync]);
  const downloading=library.downloads.some(d=>['Queued','Downloading','Waiting to retry'].includes(d.state));
  useEffect(()=>{
    if(!downloading)return;
    const timer=setInterval(()=>{if(AppState.currentState==='active')run(readLibrary('',1).then(result=>setLibrary(old=>({...old,downloads:result.downloads}))));},1100);
    return()=>clearInterval(timer);
  },[downloading,run]);
  useEffect(()=>{
    let mounted=true;
    const timer=setTimeout(()=>{
      if(!query.trim()){setSearchRows([]);return;}
      run(readLibrary(query,150).then(result=>{if(mounted)setSearchRows(result.tracks);}));
    },45);
    return()=>{mounted=false;clearTimeout(timer);};
  },[query,run,library.tracks]);
  async function saveSearch() {
    const value=query.trim();
    if(!value)return;
    const next=[value,...history.filter(row=>row!==value)].slice(0,10);
    setHistory(next);await native.setState('searches',stringify(next));
  }
  const source=useMemo(()=>[...library.tracks,...extra],[library.tracks,extra]);
  const songs=useMemo(()=>new Map(source.map(t=>[t.id,t])),[source]);
  const downloads=useMemo(()=>new Map(library.downloads.map(d=>[d.id,d])),[library.downloads]);
  const allPlaylists=library.playlists;
  const newest=library.tracks.slice(0,12);
  const recent=useMemo(()=>source.filter(t=>t.lastPlayed).sort((a,b)=>b.lastPlayed!.localeCompare(a.lastPlayed!)),[source]);
  const most=useMemo(()=>source.filter(t=>t.playCount>0).sort((a,b)=>b.playCount-a.playCount),[source]);
  const albums=useMemo(()=>group(source,t=>[t.album,t.albumArtist||t.artist].join(' · ')),[source]);
  const artists=useMemo(()=>group(source,t=>t.artist),[source]);
  const activePlaylist=collection?.playlistId?allPlaylists.find(p=>p.id===collection.playlistId):undefined;
  const rowsFor= (value:Filter) => {
    switch(value){
      case 'Liked songs':return source.filter(t=>t.liked);
      case 'Downloaded':return source.filter(t=>downloads.get(t.id)?.state==='Complete');
      case 'Local files':return source.filter(t=>t.local);
      case 'Cloud songs':return source.filter(t=>!t.local);
      case 'Recently played':return recent;
      default:return source;
    }
  };
  const selectedRows=(collection?(activePlaylist?.trackIds??collection.ids).flatMap(id=>songs.has(id)?[songs.get(id)!]:[]):tab==='Search'?searchRows:rowsFor(filter));
  const visibleRows=sort&&!collection?[...selectedRows].sort((a,b)=>a.title.localeCompare(b.title)):selectedRows;
  async function pair() {
    setPairing(true);
    try {
      const base=apiBase.trim().replace(/\/+$/,'');

      if(!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(base) && !((native.debugBuild ?? __DEV__) && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(?::\d{1,5})?$/.test(base)))throw new Error('Enter the HTTPS API origin');
      const prior=await native.getState('ownerBase');
      if(prior&&prior!==base)throw new Error('This library is bound to '+prior+'. Clear application data before pairing with a different library.');
      const result=await createClient(base)<{token:string;id:string}>('/api/auth/pair',{method:'POST',body:{code,name:deviceName}});
      const saved={base,...result};
      await native.setState('ownerBase',base);await native.saveCredentials(stringify(saved));
      setCredential(saved);setCode('');setStatus('');changeTab('Library');
    } catch(error){fail(error);}finally{setPairing(false);}
  }
  function changeTab(value:Tab) {Keyboard.dismiss();setTab(value);setCollection(null);setSort(false);}
  const downloadTracks=(tracks:Song[])=>run(native.startDownload(stringify(tracks.filter(t=>!t.local).map(t=>t.id)),wifi).then(reload));
  const play=(tracks:Song[],index=0)=>{Keyboard.dismiss();run(native.playQueue(stringify(tracks),index));};
  const playlistPatch=(id:string,patch:object|null)=>run(native.enqueue(stringify({operationId:createId(),kind:'playlist',id,patch})).then(reload).then(sync));
  const editMembership=(p:Playlist,ids:string[])=>playlistPatch(p.id,{name:p.name,trackIds:ids});
  const like=(track:Song)=>run(native.enqueue(stringify({operationId:createId(),kind:'like',id:track.id,liked:!track.liked})).then(reload).then(sync));
  const selectGroup=(name:string,tracks:Song[])=>setCollection({name,ids:tracks.map(t=>t.id)});
  const selectPlaylist=(p:Playlist)=>setCollection({name:p.name,ids:p.trackIds,playlistId:p.id});
  function importFiles(){run(native.importLocal().then(async count=>{setStatus(count?count+' file'+(count===1?'':'s')+' imported':'No audio files imported');await reload();}));}
  function signOut() {
    Alert.alert('Reset pairing?','This device will require a fresh pairing code. Downloaded and local music stay on the device.',[
      {text:'Cancel',style:'cancel'},{text:'Reset',style:'destructive',onPress:()=>run((async()=>{
        if(credential)await createClient(credential.base,credential.token)('/api/auth/device-reset',{method:'POST'}).catch(()=>undefined);
        await native.resetCredentials();setCredential(null);setCode('');
      })())}]);
  }
  function collectionRow(name:string,tracks:Song[],open:()=>void) {
    return <Pressable key={name} style={S.track} onPress={open} accessibilityRole="button"><Art track={tracks[0]} credential={credential}/>
      <View style={{flex:1}}><Text style={S.text}>{name}</Text><Text style={S.muted}>{tracks.length} tracks · {clock(tracks.reduce((n,t)=>n+t.duration,0))}</Text></View>
      <Text style={S.muted}>›</Text></Pressable>;
  }
  function shelf(title:string,tracks:Song[]) {
    if(!tracks.length)return null;
    return <><Text style={S.section}>{title}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {tracks.slice(0,12).map((track,index)=><Pressable key={track.id} onPress={()=>play(tracks,index)} style={S.tile} accessibilityRole="button" accessibilityLabel={'Play '+track.title}>
        <Art track={track} credential={credential} size={115}/><Text style={S.text} numberOfLines={1}>{track.title}</Text><Text style={S.muted} numberOfLines={1}>{track.artist}</Text></Pressable>)}</ScrollView></>;
  }
  const refresh=<RefreshControl refreshing={syncing} onRefresh={()=>void sync()} tintColor={C.accent} colors={[C.accent]}/>;
  const hour=new Date().getHours();
  return <SafeAreaView style={S.root} edges={['top','bottom','left','right']}>
    <View style={{paddingHorizontal:16,paddingVertical:10}}><Text style={S.brand}>♫  RESONANT</Text></View>
    {!!status&&<Pressable accessibilityLabel="Dismiss status" onPress={()=>setStatus('')}><Text style={S.error}>{status} ×</Text></Pressable>}
    <View style={S.body}>
      {tab==='Settings'?<ScrollView keyboardShouldPersistTaps="handled">
        <Text style={S.heading}>Settings</Text><Text style={S.section}>Cloud library</Text>
        {credential?<><Text style={S.muted}>{credential.base}</Text><View style={S.wrap}><Button label="Sync now" onPress={()=>void sync()}/><Button label="Reset pairing" onPress={signOut}/></View></>:
          <><Text style={S.muted}>Create a one-time pairing code in the web dashboard under Settings. Your local library is ready without pairing.</Text>
            <TextInput style={S.field} value={apiBase} onChangeText={setApiBase} placeholder="API URL" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="url" accessibilityLabel="API URL"/>
            <TextInput style={S.field} value={deviceName} onChangeText={setDeviceName} maxLength={80} placeholder="Device name" placeholderTextColor={C.muted} accessibilityLabel="Device name"/>
            <TextInput style={S.field} value={code} onChangeText={setCode} autoCapitalize="characters" maxLength={12} placeholder="Pairing code" placeholderTextColor={C.muted} accessibilityLabel="Pairing code"/>
            <Button label={pairing?'Pairing…':'Pair device'} primary onPress={()=>{if(!pairing)void pair();}}/></>}
        <Text style={S.section}>Offline audio</Text><View style={S.wrap}><Button label="Import local files" onPress={importFiles}/>
          <Button label={wifi?'Wi-Fi only on':'Wi-Fi only off'} selected={wifi} onPress={()=>{setWifi(!wifi);run(native.setState('wifi',String(!wifi)));}}/></View>
        <Text style={S.muted}>Saved offline {bytes(library.downloads.filter(d=>d.state==='Complete').reduce((n,d)=>n+d.size,0))}</Text>
        <Text style={S.section}>Streaming cache</Text><Text style={S.muted}>Cache limit in MiB. Applies the next time the playback service starts.</Text>
        <TextInput value={cache} onChangeText={setCache} style={S.field} keyboardType="number-pad" accessibilityLabel="Cache limit in MiB"/>
        <Button label="Save cache limit" onPress={()=>{const value=Math.min(1024,Math.max(32,Number(cache)||192));setCache(String(value));run(native.setState('cacheMb',String(value)));setStatus('Cache limit saved');}}/>
      </ScrollView>:tab==='Home'&&!collection?<ScrollView refreshControl={refresh}>
        <Text style={S.heading}>{hour<12?'Good morning':hour<18?'Good afternoon':'Good evening'}</Text>
        {!credential&&<View style={S.wrap}><Button label="Pair cloud library" primary onPress={()=>changeTab('Settings')}/><Button label="Import local files" onPress={importFiles}/></View>}
        {!!allPlaylists.length&&<><Text style={S.section}>Your playlists</Text><View style={S.wrap}>{allPlaylists.slice(0,6).map(p=><Button key={p.id} label={p.name} onPress={()=>selectPlaylist(p)}/>)}</View></>}
        {shelf('Continue listening',recent)}
        {shelf('Recently added',newest)}
        {shelf('Most played',most)}
        {!!most.length&&<><Text style={S.section}>From your favourite artists</Text>{[...new Set(most.map(t=>t.artist))].slice(0,4).map(name=>collectionRow(name,artists.get(name)??[],()=>selectGroup(name,artists.get(name)??[])))}
          <Text style={S.section}>Albums for you</Text>{[...albums].filter(([,items])=>items.some(t=>t.playCount>0)).slice(0,4).map(([name,items])=>collectionRow(name,items,()=>selectGroup(name,items)))}</>}
        {allPlaylists.filter(p=>p.trackIds.length&&p.trackIds.every(id=>downloads.get(id)?.state==='Complete')).map(p=>collectionRow(p.name+' ↓',tracksFor(p,songs),()=>selectPlaylist(p)))}
        {!source.length&&<Text style={[S.muted,{marginTop:18}]}>Import audio you own or pair with the dashboard to start your library.</Text>}
      </ScrollView>:<>
        <View style={S.spread}><Text style={[S.heading,{flex:1}]} numberOfLines={2}>{activePlaylist?.name??collection?.name??(tab==='Search'?'Search':'Your library')}</Text>
          {collection&&<Button label="Back" onPress={()=>setCollection(null)}/>}</View>
        {!collection&&tab==='Search'&&<TextInput style={S.field} value={query} onChangeText={setQuery} onSubmitEditing={()=>run(saveSearch())} placeholder="Songs, artists, albums, genres" placeholderTextColor={C.muted} autoCorrect={false} returnKeyType="search" accessibilityLabel="Search library"/>}
        {!collection&&tab==='Library'&&<View style={{height:54}}><ScrollView horizontal contentContainerStyle={[S.row,{alignItems:'flex-start'}]} showsHorizontalScrollIndicator={false}>
          {views.map(item=><Button key={item} label={item} selected={filter===item} primary={filter===item} onPress={()=>setFilter(item)}/>)}</ScrollView></View>}
        {collection&&<View style={S.wrap}><Button label="Play all" primary onPress={()=>play(visibleRows)}/>
          <Button label="Shuffle" onPress={()=>{const randomized=[...visibleRows];for(let i=randomized.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[randomized[i],randomized[j]]=[randomized[j],randomized[i]];}play(randomized);}}/>
          <Button label="Download all" onPress={()=>downloadTracks(visibleRows)}/>
          {activePlaylist&&<><Button label="Rename" onPress={()=>setEditing({id:activePlaylist.id,name:activePlaylist.name})}/>
            <Button label="Delete playlist" onPress={()=>Alert.alert('Delete playlist?',activePlaylist.name,[{text:'Cancel',style:'cancel'},
              {text:'Delete',style:'destructive',onPress:()=>{playlistPatch(activePlaylist.id,null);setCollection(null);}}])}/></>}</View>}
        {!collection&&tab==='Library'&&filter==='Playlists'?<ScrollView refreshControl={refresh}>
          <Button label="Create playlist" primary onPress={()=>setEditing({id:createId(),name:''})}/>{allPlaylists.map(p=>collectionRow(p.name,tracksFor(p,songs),()=>selectPlaylist(p)))}</ScrollView>
          :!collection&&tab==='Library'&&(filter==='Albums'||filter==='Artists')?<ScrollView refreshControl={refresh}>
            {[...(filter==='Albums'?albums:artists)].sort(([a],[b])=>a.localeCompare(b)).map(([name,tracks])=>collectionRow(name,tracks,()=>selectGroup(name,tracks)))}</ScrollView>
          :<FlashList data={visibleRows} keyExtractor={item=>item.id} refreshControl={refresh} keyboardShouldPersistTaps="handled"
            ListHeaderComponent={<>{!collection&&tab==='Library'&&<View style={S.wrap}><Button label={sort?'Sort by date':'Sort by title'} onPress={()=>setSort(!sort)}/>
              {filter==='Liked songs'&&<Button label="Download liked songs" onPress={()=>downloadTracks(visibleRows)}/>}
              {filter==='Local files'&&<Button label="Import local files" onPress={importFiles}/>}</View>}
              {!collection&&tab==='Search'&&!query.trim()&&history.length>0&&<><Text style={S.section}>Recent searches</Text><View style={S.wrap}>
                {history.map(q=><Button key={q} label={q} onPress={()=>setQuery(q)}/>)}</View></>}
              {!collection&&tab==='Search'&&!!query.trim()&&allPlaylists.filter(p=>p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(p=>collectionRow(p.name,tracksFor(p,songs),()=>selectPlaylist(p)))}</>}
            ListEmptyComponent={<Text style={[S.muted,{paddingVertical:14}]}>{tab==='Search'&&!query?'Search your library offline.':'No matching tracks.'}</Text>}
            ListFooterComponent={!collection&&tab==='Library'&&hasMore?<Button label="Load more tracks" onPress={()=>run(readLibrary('',500,source.length).then(result=>{setExtra(old=>[...old,...result.tracks]);setHasMore(result.tracks.length===500);}))}/>:null}
            renderItem={({item,index})=><TrackRow track={item} credential={credential} download={downloads.get(item.id)}
              play={()=>{if(tab==='Search')run(saveSearch());play(visibleRows,index);}} menu={()=>setTrackMenu(item)}/>}/>}
      </>}
    </View>
    <Mini songs={songs} credential={credential} onOpen={()=>setExpanded(true)} run={run}/>
    <View style={S.nav}>{([['Home','⌂'],['Search','⌕'],['Library','▤'],['Settings','⚙']] as const).map(([value,icon])=>
      <Pressable key={value} accessibilityRole="tab" accessibilityState={{selected:tab===value}} accessibilityLabel={value} style={S.navItem} onPress={()=>changeTab(value)}>
        <Text style={[S.text,{fontSize:21},tab===value&&S.checked]}>{icon}</Text><Text style={[S.muted,tab===value&&S.checked]}>{value}</Text></Pressable>)}</View>
    <Now visible={expanded} close={()=>setExpanded(false)} songs={songs} credential={credential} run={run} like={like} options={setTrackMenu}/>
    {trackMenu&&<Modal visible animationType="fade" onRequestClose={()=>setTrackMenu(null)} transparent>
      <View style={{flex:1,justifyContent:'flex-end',backgroundColor:'#0009'}}><SafeAreaView style={{backgroundColor:C.panel,padding:18,maxHeight:'82%'}} edges={['bottom']}>
        <View style={S.spread}><Text style={[S.section,{flex:1}]} numberOfLines={2}>{trackMenu.title}</Text><Button label="Close track options" onPress={()=>setTrackMenu(null)}>×</Button></View>
        <ScrollView>{[
          {label:'Play now',action:()=>play([trackMenu])},
          {label:'Play next',action:()=>run(native.addQueue(stringify(trackMenu),true))},
          {label:'Add to queue',action:()=>run(native.addQueue(stringify(trackMenu),false))},
          {label:trackMenu.liked?'Unlike':'Like',action:()=>like(trackMenu)},
          ...(!trackMenu.local?[downloads.has(trackMenu.id)?{label:downloads.get(trackMenu.id)?.state==='Complete'?'Remove offline copy':downloads.get(trackMenu.id)?.state==='Failed'?'Retry download':'Cancel download',
            action:()=>downloads.get(trackMenu.id)?.state==='Failed'?downloadTracks([trackMenu]):run(native.removeDownload(trackMenu.id).then(reload))}
            :{label:'Download original',action:()=>downloadTracks([trackMenu])}]:[]),
          ...(activePlaylist?[{label:'Remove from '+activePlaylist.name,action:()=>editMembership(activePlaylist,activePlaylist.trackIds.filter(id=>id!==trackMenu.id))},
            ...[-1,1].map(delta=>({label:delta<0?'Move up in playlist':'Move down in playlist',action:()=>{
              const ids=[...activePlaylist.trackIds],i=ids.indexOf(trackMenu.id),j=i+delta;if(i>=0&&j>=0&&j<ids.length){[ids[i],ids[j]]=[ids[j],ids[i]];editMembership(activePlaylist,ids);}
            }}))]:[]),
          ...(!trackMenu.local?allPlaylists.filter(p=>!p.trackIds.includes(trackMenu.id)).map(p=>({label:'Add to '+p.name,action:()=>editMembership(p,[...p.trackIds,trackMenu.id])})):[]),
        ].map(({label,action})=><Pressable key={label} accessibilityRole="button" style={S.action} onPress={()=>{setTrackMenu(null);action();}}><Text style={S.text}>{label}</Text></Pressable>)}</ScrollView>
      </SafeAreaView></View></Modal>}
    {editing&&<Modal visible transparent onRequestClose={()=>setEditing(null)}><View style={{flex:1,justifyContent:'center',padding:20,backgroundColor:'#0009'}}>
      <View style={{backgroundColor:C.panel,padding:18,borderRadius:10}}><Text style={S.section}>Playlist name</Text><TextInput accessibilityLabel="Playlist name" style={S.field} autoFocus
        maxLength={240} value={editing.name} onChangeText={name=>setEditing({...editing,name})}/>
        <View style={S.wrap}><Button label="Cancel" onPress={()=>setEditing(null)}/><Button label="Save playlist" primary onPress={()=>{if(editing.name.trim()){playlistPatch(editing.id,{name:editing.name.trim()});setEditing(null);}}}/></View></View>
    </View></Modal>}
  </SafeAreaView>;
}
function group(rows:Song[],key:(track:Song)=>string) {
  const result=new Map<string,Song[]>();
  for(const row of rows){const name=key(row);const bucket=result.get(name);if(bucket)bucket.push(row);else result.set(name,[row]);}
  return result;
}
