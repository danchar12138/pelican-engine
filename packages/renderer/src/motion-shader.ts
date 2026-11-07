import { TRACE_PARAMETERS_SHADER, TRACE_RANDOM_SHADER } from "./path-shader.ts";

/** Same primary visibility/sample sequence as transport; writes a separate bounded plane. */
export const MOTION_SHADER =
  TRACE_PARAMETERS_SHADER +
  TRACE_RANDOM_SHADER +
  /* wgsl */ String.raw`
@group(0) @binding(6) var<storage,read_write> motionOutput:array<vec4f>;
@group(0) @binding(7) var<uniform> motionParams:TraceParameters;
@group(0) @binding(8) var motionPrimary:texture_2d<f32>;
@compute @workgroup_size(8,8)
fn motionMain(@builtin(global_invocation_id) invocation:vec3u){
 let width=u32(motionParams.screen.x);let height=u32(motionParams.screen.y);
 if(invocation.x>=width||invocation.y>=height){return;}
 let index=invocation.y*width+invocation.x;motionOutput[index]=vec4f(0);
 if(motionParams.previousOrigin.w<0.5){return;}
 var seed=index*1973u+u32(motionParams.screen.z)*9277u+89173u;
 var jitter=vec2f(traceRandom(&seed),traceRandom(&seed));
 if(motionParams.flags.x>0.5){jitter=vec2f(0.5+motionParams.forward.w,0.5+motionParams.right.w);}
 let pixel=((vec2f(invocation.xy)+jitter)/vec2f(f32(width),f32(height)))*2.0-vec2f(1);
 let orthographic=motionParams.backgroundSettings.w==1.0;
 let cameraOrigin=traceCameraOrigin(motionParams.origin.xyz,motionParams.right.xyz,motionParams.up.xyz,pixel,orthographic);
 let direction=traceCameraDirection(motionParams.forward.xyz,motionParams.right.xyz,motionParams.up.xyz,pixel,orthographic);
 let cosine=max(dot(direction,motionParams.forward.xyz),1e-5);
 let origin=cameraOrigin+direction*(motionParams.screen.w/cosine);
 var hit:SurfaceHit;
 if(motionParams.flags.x>0.5){
  let primary=textureLoad(motionPrimary,vec2i(invocation.xy),0);
  if(primary.y< -1.5){hit=traceSurface(origin,direction,(motionParams.settings.w-motionParams.screen.w)/cosine,u32(motionParams.counts.x),u32(motionParams.counts.y),traceRandom(&seed));}
  else{hit=SurfaceHit(abs(primary.x),i32(primary.y),vec3f(1.0-primary.z-primary.w,primary.z,primary.w),primary.x>=0.0);}
 }else{
  hit=traceSurface(origin,direction,(motionParams.settings.w-motionParams.screen.w)/cosine,u32(motionParams.counts.x),u32(motionParams.counts.y),traceRandom(&seed));
 }
 if(hit.index<0){return;}
 let offset=u32(motionParams.counts.y)*18u+u32(hit.index)*3u;
 let a=surfaceGeometry[offset];let b=surfaceGeometry[offset+1u];let c=surfaceGeometry[offset+2u];
 if(a.w<0.5){return;}
 let previous=a.xyz*hit.bary.x+b.xyz*hit.bary.y+c.xyz*hit.bary.z;
 let clip=mat4x4f(motionParams.previousView0,motionParams.previousView1,motionParams.previousView2,motionParams.previousView3)*vec4f(previous,1);
 if(clip.w<=0.0){return;}
 let uv=clip.xy/clip.w*vec2f(0.5,-0.5)+vec2f(0.5);
 motionOutput[index]=vec4f(uv,length(previous-motionParams.previousOrigin.xyz),1);
}
`;
