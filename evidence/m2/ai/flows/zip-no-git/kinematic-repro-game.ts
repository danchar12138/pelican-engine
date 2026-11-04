import { defineGame, defineScene, defineSystem } from "@threecat/sdk";
const movement = defineSystem({ id: "movement", phase: "prePhysics", reads: ["Transform"], writes: ["Transform"], run(ctx,dt) {
  const z=ctx.input.axis("forward","back");
  ctx.physics.moveCharacter("player",[0,0,z*3.6*dt]);
} });
const scene=defineScene({id:"contact-repro",camera:{position:[12,12,12],target:[0,0,4]},entities:[
 {id:"player",transform:{position:[0,0.75,4]},character:{radius:0.3,height:1.4,speed:3.6}},
 {id:"floor",transform:{position:[0,-0.3,0]},rigidBody:{type:"fixed",collider:{shape:"box",size:[18,0.6,21]}}},
 {id:"gate",transform:{position:[0,1.4,7]},rigidBody:{type:"kinematic",collider:{shape:"box",size:[3.5,2.8,0.4]}}}
]});
export default defineGame({id:"kinematic-contact-repro",scene,systems:[movement],input:{forward:["w"],back:["s"]}});
