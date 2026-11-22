import React from 'react';
import { act,create,type ReactTestRenderer } from 'react-test-renderer';
import App from '../App';
import { native } from '../src/native';

jest.mock('@shopify/flash-list',()=>({FlashList:()=>null}));
jest.mock('@react-native-community/slider',()=>({__esModule:true,default:()=>null}));
jest.mock('react-native-safe-area-context',()=>({
  SafeAreaProvider:({children}:React.PropsWithChildren)=>children,
  SafeAreaView:({children}:React.PropsWithChildren)=>children,
}));
jest.mock('../src/native',()=>({
  native:{getCredentials:jest.fn(async()=>null),getState:jest.fn(async()=>null),importLocal:jest.fn(async()=>0)},
  readLibrary:jest.fn(async()=>({tracks:[],playlists:[],downloads:[]})),
  usePlaybackUpdates:()=>undefined,
  usePlayback:()=>({queue:[],index:0}),
  useArtwork:()=>undefined,
}));

test('opens with a local library and allows import before pairing',async()=>{
  let app:ReactTestRenderer;
  await act(async()=>{app=create(<App/>);});
  const control=app!.root.findAllByProps({accessibilityLabel:'Import local files'}).find(node=>typeof node.props.onPress==='function');
  expect(control).toBeDefined();
  await act(async()=>control!.props.onPress());
  expect(native.importLocal).toHaveBeenCalledTimes(1);
  await act(async()=>app!.unmount());
},30000);
