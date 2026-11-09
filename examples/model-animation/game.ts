import {defineAsset,defineGame,defineScene,defineMaterial} from "pelican-engine";
// Change the local model and exact material-slot / animation-clip names together.
const model=defineAsset({id:"panel",type:"model",path:"assets/panel.glb",license:"CC0-1.0",source:"Pelican procedural recipe"});
const paint=defineMaterial({id:"paint",color:"#4aaaba",roughness:.25,metalness:.25});
export default defineGame({id:"model-animation",assets:[model],services:{physics3d:"disabled"},scene:defineScene({id:"main",camera:{position:[0,1,5],target:[0,1,0]},entities:[
 {id:"panel",model:{asset:model,materialSlots:{Paint:paint},animation:{clip:"sway",loop:true},castShadow:true}},
 {id:"sun",transform:{position:[3,5,4]},light:{kind:"directional",intensity:3,castShadow:true}}
]})});
