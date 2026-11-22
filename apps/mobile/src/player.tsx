import {memo,useMemo,useRef,useState} from 'react';
import {Image,Modal,PanResponder,Pressable,ScrollView,Text,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import {clock} from '@resonant/shared';
import {command,useArtwork,usePlayback,useTiming,type Credential,type Song} from './native';
import {C,S} from './styles';
export function Button({label,children,onPress,primary=false,selected=false}:{label:string;children?:React.ReactNode;onPress:()=>void;primary?:boolean;selected?:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{selected}} onPress={onPress} style={({pressed})=>[S.button,primary&&S.green,pressed&&{opacity:.7}]}>
    <Text style={[S.text,primary&&S.greenText,selected&&!primary&&S.checked]}>{children??label}</Text></Pressable>;
}
export const Art=memo(function Art({track,credential,size=48}:{track?:Song;credential:Credential|null;size?:number}) {
  const uri=useArtwork(track,credential);
  if(uri)return <Image source={{uri,cache:'force-cache'}} style={{width:size,height:size,borderRadius:6,backgroundColor:C.raised}} accessibilityIgnoresInvertColors/>;
  return <View style={[S.image,{width:size,height:size}]}><Text style={{color:'#84ad8c',fontSize:size/2.8}}>♫</Text></View>;
});
type Run=(promise:Promise<unknown>)=>void;
const titles=['Repeat off','Repeat one','Repeat all'];
function Progress({mini=false,run}:{mini?:boolean;run:Run}) {
  const timing=useTiming();
  const [seek,setSeek]=useState<number|null>(null);
  if(mini)return <View style={{height:2,marginTop:5,backgroundColor:'#719579'}}><View style={{height:2,backgroundColor:C.white,
    width:Math.max(0,Math.min(100,timing.duration?timing.position/timing.duration*100:0))+'%'}}/></View>;
  return <View><Slider accessibilityLabel="Playback position" minimumValue={0} maximumValue={timing.duration||1}
    value={seek??timing.position} minimumTrackTintColor={C.accent} maximumTrackTintColor="#67776a" thumbTintColor={C.white}
    onValueChange={value=>{if(seek!==null)setSeek(value);}} onSlidingStart={setSeek} onSlidingComplete={value=>{setSeek(null);run(command('seek',value));}}/>
    <View style={S.spread}><Text style={S.muted}>{clock(seek??timing.position)}</Text><Text style={S.muted}>{clock(timing.duration)}</Text></View></View>;
}
function Volume({run}:{run:Run}) {
  const {volume}=useTiming();
  return <View style={S.row}><Text style={S.muted}>Media volume</Text><Slider style={{flex:1}} accessibilityLabel="System media volume"
    value={volume} minimumTrackTintColor={C.accent} maximumTrackTintColor="#67776a" thumbTintColor={C.white} onSlidingComplete={v=>run(command('volume',v))}/></View>;
}
function Lyrics({text}:{text:string}) {
  const {position}=useTiming();
  const list=useRef<React.ComponentRef<typeof ScrollView>>(null);
  const positions=useRef<Record<number,number>>({});
  const [auto,setAuto]=useState(true);
  const last=useRef(-1);
  const rows=useMemo(()=>{
    const values=text.split(/\r?\n/);
    const timed=values.flatMap(line=>Array.from(line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g),match=>({time:60*+match[1]+ +match[2],text:line.replace(/\[[^\]]+\]/g,'').trim()})));
    return timed.length?timed.sort((a,b)=>a.time-b.time):values.map(text=>({time:-1,text}));
  },[text]);
  const selected=rows.reduce((i,row,n)=>row.time>=0&&row.time<=position?n:i,-1);
  if(auto&&last.current!==selected&&positions.current[selected]!==undefined){
    last.current=selected;
    requestAnimationFrame(()=>list.current?.scrollTo({y:Math.max(0,positions.current[selected]-60),animated:true}));
  }
  if(!text.trim())return <Text style={S.muted}>No lyrics saved for this track. Add lyrics from the dashboard.</Text>;
  return <><Button label={auto?'Follow lyrics on':'Follow lyrics off'} onPress={()=>{last.current=-1;setAuto(!auto);}}/>
    <ScrollView ref={list} onScrollBeginDrag={()=>setAuto(false)}>{rows.map((row,i)=><Text key={i} onLayout={e=>positions.current[i]=e.nativeEvent.layout.y}
      style={[S.line,(selected===i||row.time<0)&&S.activeLine]}>{row.text||' '}</Text>)}</ScrollView></>;
}
export function Mini({songs,credential,onOpen,run}:{songs:Map<string,Song>;credential:Credential|null;onOpen:()=>void;run:Run}) {
  const state=usePlayback(), current=state.queue[state.index];
  if(!current)return null;
  return <View style={S.mini}><View style={S.row}>
    <Pressable style={[S.row,{flex:1}]} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Open Now Playing">
      <Art track={songs.get(current.id)} credential={credential} size={38}/>
      <View style={{flex:1}}><Text numberOfLines={1} style={S.text}>{current.title}</Text><Text numberOfLines={1} style={S.muted}>{current.artist}</Text></View></Pressable>
    <Button label={state.playing?'Pause':'Play'} onPress={()=>run(command('toggle'))}>{state.playing?'Ⅱ':'▶'}</Button></View><Progress mini run={run}/></View>;
}
export function Now({visible,close,songs,credential,run,like,options}:{visible:boolean;close:()=>void;songs:Map<string,Song>;
  credential:Credential|null;run:Run;like:(t:Song)=>void;options:(t:Song)=>void}) {
  const state=usePlayback();
  const current=state.queue[state.index];
  const track=current?songs.get(current.id):undefined;
  const [size,setSize]=useState(280);
  const [view,setView]=useState<'play'|'queue'|'lyrics'>('play');
  const dismiss=()=>{setView('play');close();};
  const pan=PanResponder.create({onMoveShouldSetPanResponder:(_,g)=>g.dy>12&&Math.abs(g.dx)<Math.abs(g.dy),
    onPanResponderRelease:(_,g)=>{if(g.dy>70)dismiss();}});
  if(!visible)return null;
  return <Modal visible animationType="slide" onRequestClose={()=>view==='play'?dismiss():setView('play')} statusBarTranslucent>
    <SafeAreaView style={S.modal} onLayout={e=>{const {width,height}=e.nativeEvent.layout;setSize(Math.max(120,Math.min(width-44,height*.42,400)));}}>
      <View style={S.spread} {...pan.panHandlers}><Button label={view==='play'?'Close Now Playing':'Back to player'} onPress={()=>view==='play'?dismiss():setView('play')}>⌄</Button>
        <Text style={S.brand}>{view==='play'?'NOW PLAYING':view==='queue'?'PLAYBACK QUEUE':'LYRICS'}</Text>
        <Button label="Track options" onPress={()=>{if(track){dismiss();options(track);}}}>⋯</Button></View>
      {view==='play'&&<ScrollView contentContainerStyle={{flexGrow:1,gap:12,paddingVertical:12}}>
        <View style={{alignItems:'center'}} {...pan.panHandlers}><Art track={track} credential={credential} size={size}/></View>
        <View style={S.spread}><View style={{flex:1}}><Text style={[S.heading,{fontSize:26}]} numberOfLines={2}>{current?.title??'Nothing playing'}</Text>
          <Text style={S.muted}>{current?.artist??'Select a track from your library'}</Text></View>
          {track&&<Button label={track.liked?'Unlike song':'Like song'} selected={track.liked} onPress={()=>like(track)}>{track.liked?'♥':'♡'}</Button>}</View>
        {!!state.error&&<Text accessibilityRole="alert" style={S.error}>Playback error · {state.error}. Tap play to retry.</Text>}
        {state.buffering&&<Text style={S.muted}>Buffering…</Text>}
        <Progress run={run}/>
        <View style={S.spread}><Button label="Shuffle" selected={state.shuffle} onPress={()=>run(command('shuffle'))}>⤨</Button>
          <Button label="Previous track" onPress={()=>run(command('previous'))}>⏮</Button>
          <Button label={state.playing?'Pause':'Play'} primary onPress={()=>run(command('toggle'))}>{state.playing?'Ⅱ':'▶'}</Button>
          <Button label="Next track" onPress={()=>run(command('next'))}>⏭</Button>
          <Button label={titles[state.repeat]??'Repeat'} selected={state.repeat!==0} onPress={()=>run(command('repeat'))}>{state.repeat===1?'↻¹':'↻'}</Button></View>
        <View style={S.spread}><Button label="Audio output" onPress={()=>run(command('output'))}/><Button label="Lyrics" onPress={()=>setView('lyrics')}/>
          <Button label="Queue" onPress={()=>setView('queue')}/></View><Volume run={run}/></ScrollView>}
      {view==='queue'&&<><View style={S.spread}><Text style={S.section}>{state.queue.length} tracks</Text><Button label="Clear queue" onPress={()=>run(command('clear'))}/></View>
        <ScrollView>{state.queue.map((row,i)=><View key={row.id+'-'+i} style={S.track}>
          <Pressable style={{flex:1}} onPress={()=>run(command('index',i))}><Text style={[S.text,i===state.index&&S.checked]}>{row.title}</Text><Text style={S.muted}>{row.artist}</Text></Pressable>
          {i>0&&<Button label={'Move '+row.title+' up'} onPress={()=>run(command('move',i,i-1))}>↑</Button>}
          {i<state.queue.length-1&&<Button label={'Move '+row.title+' down'} onPress={()=>run(command('move',i,i+1))}>↓</Button>}
          <Button label={'Remove '+row.title} onPress={()=>run(command('remove',i))}>×</Button></View>)}</ScrollView></>}
      {view==='lyrics'&&<Lyrics key={current?.id} text={track?.lyrics??''}/>}
    </SafeAreaView></Modal>;
}
