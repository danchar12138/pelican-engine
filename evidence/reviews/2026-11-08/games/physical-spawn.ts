import {defineGame,defineScene,defineSystem,definePrefab} from 'pelican-engine';
const box=definePrefab({id:'box',rigidBody:{type:'dynamic',collider:{shape:'box',size:[1,1,1]}}});
const action=defineSystem({id:'action',phase:'input',structural:true,run(ctx){if(ctx.time.tick===1)ctx.entities.spawn({id:'new-body',prefab:'box'});}});
export default defineGame({id:'case',prefabs:[box],systems:[action],scene:defineScene({id:'main',camera:{position:[4,3,6],target:[0,0,0]},entities:[{id:'victim',prefab:box},{id:'survivor',prefab:box,transform:{position:[5,0,0]}}]})});