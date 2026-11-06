/** Shared finite-roughness/delta dielectric mixture; medium state is owned by the path integrator. */
export const VOLUME_SHADER = /* wgsl */ String.raw`
struct TraceScatter{direction:vec3f,weight:vec3f,pdf:f32,eta:f32,event:u32,delta:u32,}
struct TraceShadowMedia{incident:vec3f,transmitted:vec3f,}
// Medium orientation comes from geometry, never a shading normal facing away from view.
fn traceDielectric(surface:SurfaceValue)->DielectricMaterial{
 return DielectricMaterial(surface.medium.y,surface.medium.z,surface.roughness,0u,clamp(surface.base,vec3f(0),vec3f(1)));
}
fn traceOpaqueIor(surface:SurfaceValue)->f32{return select(surface.medium.y,1.5,surface.medium.x>0.0);}
fn traceEvaluate(surface:SurfaceValue,view:vec3f,light:vec3f)->vec3f{
 if(dot(surface.normal,view)<=0.0){return vec3f(0);}
 let opaque=bsdfEvaluateSpecular(surface.normal,view,light,clamp(surface.base,vec3f(0),vec3f(1)),surface.roughness,surface.metalness,traceOpaqueIor(surface),surface.specular.w,surface.specular.xyz);
 if(!traceVolumeEnabled||surface.medium.x==0.0){return opaque;}let dielectric=dielectricEvaluate(surface.normal*surface.medium.w,view,light,traceDielectric(surface));return opaque*(1.0-surface.medium.x)+dielectric*surface.medium.x;
}
fn tracePdf(surface:SurfaceValue,view:vec3f,light:vec3f)->f32{
 if(dot(surface.normal,view)<=0.0){return 0.0;}
 let opaque=bsdfPdfSpecular(surface.normal,view,light,clamp(surface.base,vec3f(0),vec3f(1)),surface.roughness,surface.metalness,traceOpaqueIor(surface),surface.specular.w,surface.specular.xyz);
 if(!traceVolumeEnabled||surface.medium.x==0.0){return opaque;}let dielectric=dielectricPdf(surface.normal*surface.medium.w,view,light,traceDielectric(surface));return opaque*(1.0-surface.medium.x)+dielectric*surface.medium.x;
}
fn traceScatter(surface:SurfaceValue,view:vec3f,branch:f32,random:vec3f)->TraceScatter{
 if(dot(surface.normal,view)<=0.0){return TraceScatter(vec3f(0),vec3f(0),0,1,0u,0u);}
 if(!traceVolumeEnabled||surface.medium.x==0.0){let sample=bsdfSampleSpecular(surface.normal,view,clamp(surface.base,vec3f(0),vec3f(1)),surface.roughness,surface.metalness,random,traceOpaqueIor(surface),surface.specular.w,surface.specular.xyz);return TraceScatter(sample.direction,sample.weight,sample.pdf,1,select(0u,1u,sample.pdf>0.0),0u);}
 var direction:vec3f;var eta=1.0;var event=1u;
 if(surface.medium.x>0.0&&branch<surface.medium.x){
  let sample=dielectricSample(surface.normal*surface.medium.w,view,traceDielectric(surface),random);if(sample.event==0u){return TraceScatter(vec3f(0),vec3f(0),0,1,0u,0u);}
  if(sample.delta!=0u){return TraceScatter(sample.direction,sample.weight,sample.pdf*surface.medium.x,sample.eta,sample.event,sample.delta);}
  direction=sample.direction;eta=sample.eta;event=sample.event;
 }else{let sample=bsdfSampleSpecular(surface.normal,view,clamp(surface.base,vec3f(0),vec3f(1)),surface.roughness,surface.metalness,random,traceOpaqueIor(surface),surface.specular.w,surface.specular.xyz);if(sample.pdf<=0.0){return TraceScatter(vec3f(0),vec3f(0),0,1,0u,0u);}direction=sample.direction;}
 let pdf=tracePdf(surface,view,direction);if(pdf<=0.0){return TraceScatter(vec3f(0),vec3f(0),0,1,0u,0u);}let weight=traceEvaluate(surface,view,direction)*abs(dot(surface.normal,direction))/pdf;return TraceScatter(direction,weight,pdf,eta,event,0u);
}
fn traceValidDirection(geometric:vec3f,surface:SurfaceValue,direction:vec3f)->bool{
 let gn=dot(geometric,direction);let sn=dot(surface.normal,direction);return select(gn>0.0&&sn>0.0,gn*sn>0.0,traceVolumeEnabled&&surface.medium.x>0.0);
}
fn traceCosine(surface:SurfaceValue,direction:vec3f)->f32{return select(max(dot(surface.normal,direction),0.0),abs(dot(surface.normal,direction)),traceVolumeEnabled&&surface.medium.x>0.0);}
struct TracePoint{position:vec3f,error:vec3f,}
fn tracePoint(triangle:SurfaceTriangle,bary:vec3f)->TracePoint{
 let a=triangle.a.xyz*bary.x;let b=triangle.b.xyz*bary.y;let c=triangle.c.xyz*bary.z;
 return TracePoint(a+b+c,(abs(a)+abs(b)+abs(c))*4.172327e-7);
}
fn traceOffset(point:TracePoint,geometric:vec3f,direction:vec3f)->vec3f{
 let offset=geometric*(dot(abs(geometric),point.error)*select(-1.0,1.0,dot(geometric,direction)>0.0));
 var result=point.position+offset;
 for(var axis=0u;axis<3u;axis++){
  if(offset[axis]==0.0){continue;}
  if(result[axis]==0.0){result[axis]=select(-1.17549435e-38,1.17549435e-38,offset[axis]>0.0);}
  else{let step=select(-1,1,(result[axis]>0.0)==(offset[axis]>0.0));result[axis]=bitcast<f32>(bitcast<i32>(result[axis])+step);}
 }
 return result;
}
`;
