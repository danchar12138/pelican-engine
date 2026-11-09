import {defineAsset,defineComponent,defineGame,defineScene,defineSystem} from "pelican-engine";
const tone=defineAsset({id:"tone",type:"audio",path:"assets/tone.wav",license:"CC0-1.0",source:"Pelican procedural PCM"});
const State=defineComponent({id:"SoundState",schema:{voice:{type:"string",default:""}}});
const control=defineSystem({id:"sound",run(ctx){for(const event of ctx.events("ui.activate")){
 const id=(event.payload as {id:string}).id,current=ctx.getComponent("state",State);
 if(id==="play"){if(current.voice)ctx.audio.stop(current.voice);ctx.setComponent("state",State,{voice:ctx.audio.play("tone",{loop:true})});}
 if(id==="stop"){ctx.audio.stop(current.voice);ctx.setComponent("state",State,{voice:""});}
}ctx.ui.setText("status",ctx.getComponent("state",State).voice?"Playing (requires browser audio unlock)":"Stopped");}});
// Use a real DOM click/tap to unlock browser audio. Synthetic input is not unlock evidence.
export default defineGame({id:"audio-interaction",assets:[tone],sounds:[{id:"tone",asset:tone,volume:.25}],components:[State],systems:[control],services:{physics3d:"disabled"},
 ui:[{id:"play",kind:"button",text:"Play tone",x:16,y:16,width:140},{id:"stop",kind:"button",text:"Stop",x:16,y:64,width:140},{id:"status",kind:"text",text:"Stopped",x:16,y:112,width:280}],
 scene:defineScene({id:"main",camera:{position:[0,0,4],target:[0,0,0]},entities:[{id:"state",components:[{component:State}]}]})});
