import { StyleSheet } from 'react-native';
export const C={bg:'#121212',panel:'#1b1d1b',raised:'#282c28',white:'#f2f6f2',muted:'#acb6ad',accent:'#48d278',line:'#323932'};
export const S=StyleSheet.create({
  root:{flex:1,backgroundColor:C.bg}, body:{flex:1,overflow:'hidden',paddingHorizontal:16}, text:{color:C.white,fontSize:15}, muted:{color:C.muted,fontSize:13},
  heading:{fontSize:33,fontWeight:'800',letterSpacing:-1.2,color:C.white,marginBottom:8}, section:{fontSize:20,fontWeight:'700',color:C.white,marginTop:18,marginBottom:8},
  brand:{fontSize:16,fontWeight:'800',color:C.accent,letterSpacing:1.2}, row:{flexDirection:'row',alignItems:'center',gap:8},
  spread:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}, wrap:{flexDirection:'row',flexWrap:'wrap',gap:8},
  button:{minHeight:44,minWidth:44,justifyContent:'center',alignItems:'center',backgroundColor:C.raised,borderRadius:9,paddingHorizontal:12},
  green:{backgroundColor:C.accent}, greenText:{color:'#0d1d10',fontWeight:'800'}, checked:{color:C.accent},
  field:{paddingVertical:12,paddingHorizontal:14,color:C.white,backgroundColor:C.raised,borderRadius:9,minHeight:46,fontSize:16,marginVertical:6},
  tile:{backgroundColor:C.panel,borderRadius:10,padding:10,marginRight:9,width:135,gap:5}, image:{backgroundColor:'#29352c',alignItems:'center',justifyContent:'center',borderRadius:6},
  track:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:6,minHeight:58,borderBottomColor:'#202320',borderBottomWidth:StyleSheet.hairlineWidth},
  nav:{zIndex:2,flexDirection:'row',justifyContent:'space-around',backgroundColor:'#121612',borderTopColor:C.line,borderTopWidth:StyleSheet.hairlineWidth},
  navItem:{flex:1,minHeight:55,alignItems:'center',justifyContent:'center',gap:2}, mini:{zIndex:1,margin:7,marginBottom:5,backgroundColor:'#25422d',borderRadius:8,padding:7},
  modal:{flex:1,backgroundColor:'#171e18',paddingHorizontal:20,paddingTop:6}, error:{padding:9,backgroundColor:'#44291e',color:'#ffe0cd'},
  action:{paddingVertical:11,paddingHorizontal:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:C.line,minHeight:44},
  line:{color:C.muted,fontSize:23,lineHeight:33,paddingVertical:8,fontWeight:'600'}, activeLine:{color:C.white},
});
