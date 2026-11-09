/** Shared path and raster-visibility hybrid integrator. Core surface/BVH/BSDF are concatenated before this module. */
export const TRACE_PARAMETER_FLOATS = 96;
export const TRACE_PARAMETER_BYTES = TRACE_PARAMETER_FLOATS * 4;
export const TRACE_PARAMETERS_SHADER = /* wgsl */ String.raw`
struct TraceParameters{
 origin:vec4f,forward:vec4f,right:vec4f,up:vec4f,background:vec4f,
 screen:vec4f,counts:vec4f,settings:vec4f,flags:vec4f,
 view0:vec4f,view1:vec4f,view2:vec4f,view3:vec4f,
 environment:vec4f,environment0:vec4f,environment1:vec4f,environment2:vec4f,
 medium:vec4f,
 previousView0:vec4f,previousView1:vec4f,previousView2:vec4f,previousView3:vec4f,previousOrigin:vec4f,backgroundSettings:vec4f,
}
fn traceCameraOrigin(origin:vec3f,right:vec3f,up:vec3f,pixel:vec2f,orthographic:bool)->vec3f{
 if(orthographic){return origin+right*pixel.x-up*pixel.y;}return origin;
}
fn traceCameraDirection(forward:vec3f,right:vec3f,up:vec3f,pixel:vec2f,orthographic:bool)->vec3f{
 if(orthographic){return normalize(forward);}return normalize(forward+right*pixel.x-up*pixel.y);
}
`;
export const TRACE_RANDOM_SHADER = /* wgsl */ String.raw`
fn traceRandom(seed:ptr<function,u32>)->f32{*seed=(*seed)*747796405u+2891336453u;let shift=((*seed)>>28u)+4u;let word=(((*seed)>>shift)^(*seed))*277803737u;return min(f32((word>>22u)^word)/4294967296.0,0.99999994);}
`;
export const PATH_SHADER =
  TRACE_PARAMETERS_SHADER +
  TRACE_RANDOM_SHADER +
  /* wgsl */ String.raw`
struct TraceLight{position:vec4f,color:vec4f,extra:vec4f,}
@group(0) @binding(5) var<storage,read> traceLights:array<TraceLight>;
struct TraceOutput{faults:atomic<u32>,faultMask:atomic<u32>,faultDetail:atomic<u32>,faultPixel:atomic<u32>,pixels:array<vec4f>,}
@group(0) @binding(6) var<storage,read_write> traceOutput:TraceOutput;
@group(0) @binding(7) var<uniform> traceParams:TraceParameters;
@group(0) @binding(8) var primaryHits:texture_2d<f32>;
@group(0) @binding(9) var<storage,read> environmentImportance:array<vec4f>;
override traceVolumeEnabled:bool=false;
override traceCaptureFault:bool=false;
fn traceMediumIor(id:u32)->f32{if(id==0u){return 1.0;}return traceLights[u32(traceParams.medium.x)+id-1u].position.x;}
fn traceMediumSigma(id:u32)->vec3f{if(id==0u){return vec3f(0);}return traceLights[u32(traceParams.medium.x)+id-1u].position.yzw;}
// Distance to a closed triangle, for rejecting a primary origin on a medium boundary.
fn tracePointTriangleDistance2(point:vec3f,a:vec3f,b:vec3f,c:vec3f)->f32{
 let ab=b-a;let ac=c-a;let ap=point-a;let d1=dot(ab,ap);let d2=dot(ac,ap);
 if(d1<=0.0&&d2<=0.0){return dot(ap,ap);}
 let bp=point-b;let d3=dot(ab,bp);let d4=dot(ac,bp);
 if(d3>=0.0&&d4<=d3){return dot(bp,bp);}
 let vc=d1*d4-d3*d2;
 if(vc<=0.0&&d1>=0.0&&d3<=0.0){let v=d1/(d1-d3);let delta=point-(a+v*ab);return dot(delta,delta);}
 let cp=point-c;let d5=dot(ab,cp);let d6=dot(ac,cp);
 if(d6>=0.0&&d5<=d6){return dot(cp,cp);}
 let vb=d5*d2-d1*d6;
 if(vb<=0.0&&d2>=0.0&&d6<=0.0){let w=d2/(d2-d6);let delta=point-(a+w*ac);return dot(delta,delta);}
 let va=d3*d6-d5*d4;
 if(va<=0.0&&(d4-d3)>=0.0&&(d5-d6)>=0.0){let w=(d4-d3)/((d4-d3)+(d5-d6));let delta=point-(b+w*(c-b));return dot(delta,delta);}
 let total=va+vb+vc;if(total<=0.0){return 0.0;}
 let delta=point-(a+ab*(vb/total)+ac*(vc/total));return dot(delta,delta);
}
struct TraceInitialBoundary{volume:u32,front:bool,ambiguous:bool,near:bool,invalid:bool,}
// Find the first physical shell, ignoring opaque surfaces. Valid nested closed shells
// identify the starting medium: front means its parent, back means the shell itself.
fn traceInitialBoundary(point:vec3f,direction:vec3f)->TraceInitialBoundary{
 let nodeCount=u32(traceParams.counts.x);let triangleCount=u32(traceParams.counts.y);
 var result=TraceInitialBoundary(0u,true,false,false,false);
 if(nodeCount==0u||triangleCount==0u){return result;}
 let inverse=1.0/select(vec3f(1e-30),direction,abs(direction)>vec3f(1e-20));
 let roundoff=2.3841858e-7*max(1.0,max(max(abs(point.x),abs(point.y)),abs(point.z)));
 let margin=traceParams.environment2.w+roundoff;
 var nearest=1e30;var current=0u;
 loop{
  if(current>=nodeCount){break;}
  let node=surfaceLoadNode(current);
  let onRay=surfaceEntry(point,direction,inverse,node,nearest)<1e30;
  let nearPoint=all(point>=node.lo.xyz-vec3f(margin))&&all(point<=node.hi.xyz+vec3f(margin));
  if(!onRay&&!nearPoint){current=select(u32(node.lo.w),current+1u,node.hi.w>0.0);continue;}
  if(node.hi.w>0.0){let start=u32(node.lo.w);let count=u32(node.hi.w);
   for(var slot=0u;slot<count;slot++){
    let index=start+slot;if(index>=triangleCount){continue;}
    let offset=nodeCount*2u+index*3u;let a=surfaceAccelerationData[offset];let packedB=surfaceAccelerationData[offset+1u];let b=packedB.xyz;let c=surfaceAccelerationData[offset+2u].xyz;
    if(surfaceMaterials[u32(a.w)].physical.x<=0.0){continue;}
    let id=u32(surfaceTriangle(index).nmb.w);
    if(id==0u||id>u32(traceParams.medium.w)){result.invalid=true;continue;}
    if(nearPoint){let tolerance=traceLights[u32(traceParams.medium.x)+id-1u].color.y+roundoff;
     if(tracePointTriangleDistance2(point,a.xyz,b,c)<=tolerance*tolerance){result.near=true;}}
    if(!onRay){continue;}
    let edge1=b-a.xyz;let edge2=c-a.xyz;let determinant=dot(edge1,cross(direction,edge2));
    if(determinant==0.0){continue;}
    let boundary=surfaceBoundary(point,direction,a.xyz,b,c,nearest);if(boundary.w<0.0){continue;}
    let front=(determinant>0.0)==(packedB.w>0.0);
    let uncertain=min(min(boundary.x,boundary.y),boundary.z)<=1e-6||abs(determinant)<=1e-7*length(edge1)*length(edge2);
    if(boundary.w<nearest){nearest=boundary.w;result.volume=id;result.front=front;result.ambiguous=uncertain;}
    else if(boundary.w==nearest&&(result.volume!=id||result.front!=front)){result.ambiguous=true;}
   }
  }
  current++;
 }
 return result;
}
fn traceMediumParent(id:u32)->u32{return u32(traceLights[u32(traceParams.medium.x)+id-1u].color.x);}
// Each primary sample gets its own stack, independent of all opaque geometry.
fn traceInitializePrimaryMedia(point:vec3f,media:ptr<function,array<u32,65>>,depth:ptr<function,u32>)->u32{
 var found=false;var selected=0u;
 for(var choice=0u;choice<3u;choice++){
  var direction=normalize(vec3f(1.0,0.37139,0.69421));
  if(choice==1u){direction=normalize(vec3f(-0.52973,1.0,0.21761));}
  if(choice==2u){direction=normalize(vec3f(0.19317,-0.61843,1.0));}
  let boundary=traceInitialBoundary(point,direction);
  if(boundary.invalid){return 1u;}if(boundary.near){return 16u;}if(boundary.ambiguous){continue;}
  var candidate=0u;
  if(boundary.volume!=0u){candidate=select(boundary.volume,traceMediumParent(boundary.volume),boundary.front);}
  if(found&&candidate!=selected){return 32u;}selected=candidate;found=true;
 }
 if(!found){return 32u;}
 var chain:array<u32,64>;var count=0u;var id=selected;
 loop{
  if(id==0u){break;}
  if(id>u32(traceParams.medium.w)){return 1u;}if(count>=64u){return 8u;}
  for(var previous=0u;previous<count;previous++){if(chain[previous]==id){return 32u;}}
  chain[count]=id;count++;id=traceMediumParent(id);
 }
 for(var i=0u;i<count;i++){(*media)[i+1u]=chain[count-i-1u];}
 (*depth)=count+1u;return 0u;
}
fn traceBackground(direction:vec3f)->vec3f{
 if(traceParams.background.w<0.5){return traceParams.background.rgb;}
 let c=traceParams.backgroundSettings.y;let s=traceParams.backgroundSettings.z;
 let local=vec3f(c*direction.x-s*direction.z,direction.y,s*direction.x+c*direction.z);
 let uv=vec2f((atan2(local.z,local.x)+3.141592653589793)/6.283185307179586,asin(clamp(local.y,-1.0,1.0))/3.141592653589793+0.5);
 return surfaceMap(traceParams.background.w-1.0,vec4f(uv,0,0)).rgb*traceParams.backgroundSettings.x;
}
fn traceShadowBeer(media:TraceShadowMedia,geometric:vec3f,direction:vec3f,distance:f32)->vec3f{
 if(!traceVolumeEnabled){return vec3f(1);}return exp(-select(media.incident,media.transmitted,dot(geometric,direction)<0.0)*distance);
}
fn traceEnvironmentBase(direction:vec3f)->vec3f{
 var result=traceParams.background.rgb;
 if(traceParams.environment.x>=0.0){let local=normalize(mat3x3f(traceParams.environment0.xyz,traceParams.environment1.xyz,traceParams.environment2.xyz)*direction);let uv=vec2f((atan2(local.z,local.x)+3.141592653589793)/6.283185307179586,acos(clamp(local.y,-1.0,1.0))/3.141592653589793);result=surfaceMap(traceParams.environment.x,vec4f(uv,0,0)).rgb*traceParams.environment.y;}
 return result;
}
fn traceEnvironmentAmbient(direction:vec3f)->vec3f{
 var result=vec3f(0);for(var index=0u;index<u32(traceParams.counts.z);index++){let light=traceLights[index];
  if(light.position.w==2.0){let weight=dot(direction,normalize(light.position.xyz))*0.5+0.5;result+=mix(light.extra.rgb,light.color.rgb,weight)/3.141592653589793;}
  else if(light.position.w==3.0){result+=light.color.rgb/3.141592653589793;}
 }return result;
}
fn tracePower(a:f32,b:f32)->f32{return a*a/max(a*a+b*b,1e-30);}
fn traceEnvironmentPdf(direction:vec3f,techniques:f32)->f32{
 if(traceParams.environment.x<0.0){return 0.0;}let local=normalize(mat3x3f(traceParams.environment0.xyz,traceParams.environment1.xyz,traceParams.environment2.xyz)*direction);let uv=vec2f((atan2(local.z,local.x)+3.141592653589793)/6.283185307179586,acos(clamp(local.y,-1.0,1.0))/3.141592653589793);let column=min(u32(uv.x*traceParams.environment.z),u32(traceParams.environment.z)-1u);let row=min(u32(uv.y*traceParams.environment.w),u32(traceParams.environment.w)-1u);let cell=environmentImportance[row*u32(traceParams.environment.z)+column];return cell.x/(cell.w*max(techniques,1.0));
}
fn traceEnvironmentDirect(point:TracePoint,geometric:vec3f,surface:SurfaceValue,view:vec3f,shadowMedia:TraceShadowMedia,continuation:bool,seed:ptr<function,u32>,techniques:f32)->vec3f{
 let position=point.position;
 if(traceParams.environment.x<0.0){return vec3f(0);}let count=u32(traceParams.environment.z*traceParams.environment.w);let selection=traceRandom(seed)*f32(count);var selected=u32(selection);let proposal=environmentImportance[selected];if(fract(selection)>=proposal.z){selected=u32(proposal.y);}let cell=environmentImportance[selected];let row=selected/u32(traceParams.environment.z);let column=selected%u32(traceParams.environment.z);let phi=((f32(column)+traceRandom(seed))/traceParams.environment.z)*6.283185307179586-3.141592653589793;let cosine=mix(cos(f32(row)*3.141592653589793/traceParams.environment.w),cos(f32(row+1u)*3.141592653589793/traceParams.environment.w),traceRandom(seed));let sine=sqrt(max(0.0,1.0-cosine*cosine));let local=vec3f(sine*cos(phi),cosine,sine*sin(phi));let direction=transpose(mat3x3f(traceParams.environment0.xyz,traceParams.environment1.xyz,traceParams.environment2.xyz))*local;let noL=traceCosine(surface,direction);if(noL<=0.0||!traceValidDirection(geometric,surface,direction)){return vec3f(0);}let hit=point.receiveShadow&&occludedSurface(traceOffset(point,geometric,direction),direction,1e20,u32(traceParams.counts.x),u32(traceParams.counts.y),traceRandom(seed));if(hit){return vec3f(0);}let pdf=cell.x/(cell.w*max(techniques,1.0));if(pdf<=0.0){return vec3f(0);}let bsdf=traceEvaluate(surface,view,direction);let brdfPdf=tracePdf(surface,view,direction);return traceShadowBeer(shadowMedia,geometric,direction,1e20)*bsdf*traceEnvironmentBase(direction)*(noL*select(1.0,tracePower(pdf,brdfPdf),continuation)/pdf);
}
fn traceEmitterFrame(triangle:SurfaceTriangle)->vec4f{
 let face=cross(triangle.b.xyz-triangle.a.xyz,triangle.c.xyz-triangle.a.xyz);let scale=max(abs(face.x),max(abs(face.y),abs(face.z)));
 if(!(scale>0.0&&scale<=3.402823e38)){return vec4f(0);}
 let scaled=face/scale;let size=length(scaled);return vec4f(scaled/size,scale*(0.5*size));
}
fn traceEmitterPdf(index:u32,origin:vec3f,position:vec3f,techniques:f32)->f32{
 if(traceParams.up.w<0.5){return 0.0;}
 let probability=surfaceAccelerationData[u32(traceParams.counts.x)*2u+index*3u+2u].w;
 if(probability<=0.0){return 0.0;}
 let frame=traceEmitterFrame(surfaceTriangle(index));if(frame.w<=0.0){return 0.0;}
 let delta=position-origin;let distance2=dot(delta,delta);let cosine=abs(dot(frame.xyz,-normalize(delta)));return probability*distance2/max(frame.w*cosine*max(techniques,1.0),1e-20);
}
fn traceEmitterDirect(point:TracePoint,geometric:vec3f,surface:SurfaceValue,view:vec3f,shadowMedia:TraceShadowMedia,continuation:bool,seed:ptr<function,u32>,techniques:f32)->vec3f{
 let position=point.position;
 let count=u32(traceParams.up.w);if(count==0u){return vec3f(0);}
 let selection=traceRandom(seed)*f32(count);let slot=min(u32(selection),count-1u);let base=u32(traceParams.counts.z);let proposal=traceLights[base+slot];let selected=select(u32(proposal.extra.z),slot,fract(selection)<proposal.extra.y);
 let light=traceLights[base+selected];let index=u32(light.position.x);let triangle=surfaceTriangle(index);let root=sqrt(traceRandom(seed));let bary=vec3f(1.0-root,root*(1.0-traceRandom(seed)),0);let weights=vec3f(bary.xy,1.0-bary.x-bary.y);let emitterPoint=triangle.a.xyz*weights.x+triangle.b.xyz*weights.y+triangle.c.xyz*weights.z;
 let delta=emitterPoint-position;let distance=length(delta);if(distance<=0.002){return vec3f(0);}let direction=delta/distance;let geometricCosine=dot(geometric,direction);let cosine=traceCosine(surface,direction);if(cosine<=0.0||!traceValidDirection(geometric,surface,direction)){return vec3f(0);}
 let emitFrame=traceEmitterFrame(triangle);if(emitFrame.w<=0.0){return vec3f(0);}let emitNormal=emitFrame.xyz;let emitCosine=abs(dot(emitNormal,-direction));if(emitCosine<1e-6){return vec3f(0);}let front=surfaceOriginalFront(triangle,dot(emitNormal,-direction)>0.0);let emission=evaluateSurfaceView(index,weights,front,-direction);if(emission.discarded!=0u){return vec3f(0);}
 let visibility=point.receiveShadow&&occludedSurface(traceOffset(point,geometric,direction),direction,distance-.002,u32(traceParams.counts.x),u32(traceParams.counts.y),traceRandom(seed));if(visibility){return vec3f(0);}
 let pdf=light.position.z*distance*distance/max(emitFrame.w*emitCosine*max(techniques,1.0),1e-20);let brdfPdf=tracePdf(surface,view,direction);let weight=select(1.0,tracePower(pdf,brdfPdf),continuation);
 return traceShadowBeer(shadowMedia,geometric,direction,distance)*traceEvaluate(surface,view,direction)*emission.emissive*(cosine*weight*select(1.0,emission.alpha,surfaceMaterials[u32(triangle.a.w)].normal.w==2.0)/pdf);
}
fn traceExplicit(index:u32,point:TracePoint,geometric:vec3f,surface:SurfaceValue,view:vec3f,shadowMedia:TraceShadowMedia,seed:ptr<function,u32>)->vec3f{
 let position=point.position;let light=traceLights[index];
 var delta=light.position.xyz;var distance=1e20;var attenuation=1.0;var castsShadow=light.extra.x>0.5;
 if(light.position.w==0.0||light.position.w==5.0){delta-=position;distance=length(delta);if(distance<=0.0001){return vec3f(0);}var limit=light.color.w;var decay=light.extra.w;var edge=1.0;if(light.position.w==5.0){let params=traceLights[index+1u];limit=params.position.x;decay=params.position.y;castsShadow=params.position.z>0.5;let cone=dot(light.extra.xyz,-delta/distance);if(cone<light.color.w){return vec3f(0);}if(light.extra.w>light.color.w){edge=smoothstep(light.color.w,light.extra.w,cone);}}attenuation=edge/max(pow(distance,decay),0.01);if(limit>0.0){let cutoff=clamp(1.0-pow(distance/limit,4.0),0.0,1.0);attenuation*=cutoff*cutoff;}}
 let direction=normalize(delta);let cosine=traceCosine(surface,direction);if(cosine==0.0||!traceValidDirection(geometric,surface,direction)){return vec3f(0);}
 if(castsShadow&&point.receiveShadow&&occludedSurface(traceOffset(point,geometric,direction),direction,distance-.002,u32(traceParams.counts.x),u32(traceParams.counts.y),traceRandom(seed))){return vec3f(0);}
 return traceShadowBeer(shadowMedia,geometric,direction,distance)*traceEvaluate(surface,view,direction)*light.color.rgb*(cosine*attenuation);
}
fn traceDirect(point:TracePoint,geometric:vec3f,surface:SurfaceValue,view:vec3f,shadowMedia:TraceShadowMedia,continuation:bool,seed:ptr<function,u32>,allTechniques:bool)->vec3f{
 let count=u32(traceParams.origin.w);if(count==0u){return vec3f(0);}
 let selected=min(u32(traceRandom(seed)*f32(count)),count-1u);var current=0u;var result=vec3f(0);
 let techniques=select(f32(count),1.0,allTechniques);
 for(var index=0u;index<u32(traceParams.counts.z);index++){
  let light=traceLights[index];if(light.position.w>=2.0&&light.position.w!=5.0){continue;}
  if(allTechniques){result+=traceExplicit(index,point,geometric,surface,view,shadowMedia,seed);}
  else if(current==selected){return traceExplicit(index,point,geometric,surface,view,shadowMedia,seed)*f32(count);}
  current++;
 }
 if(traceParams.up.w>0.5){if(allTechniques||selected==current){result+=traceEmitterDirect(point,geometric,surface,view,shadowMedia,continuation,seed,techniques);}current++;}
 if(traceParams.environment.x>=0.0&&(allTechniques||selected==current)){result+=traceEnvironmentDirect(point,geometric,surface,view,shadowMedia,continuation,seed,techniques);}
 return result;
}
@compute @workgroup_size(8,8)
fn pathMain(@builtin(global_invocation_id) invocation:vec3u){
 let width=u32(traceParams.screen.x);let height=u32(traceParams.screen.y);if(invocation.x>=width||invocation.y>=height){return;}
 let index=invocation.y*width+invocation.x;let pixelCount=width*height;
 var seed=index*1973u+u32(traceParams.screen.z)*9277u+89173u;
 var radianceSum=vec3f(0);var firstNormal=vec4f(0,0,0,-1);var firstAlbedo=vec4f(0);
 for(var sample=0u;sample<u32(traceParams.settings.y);sample++){
  let targeted=traceCaptureFault&&traceVolumeEnabled&&traceParams.environment0.w>=0.0&&index==u32(traceParams.environment0.w)&&f32(sample)==traceParams.environment1.w;
  if(targeted){traceOutput.pixels[pixelCount*4u+5u]=vec4f(0);traceOutput.pixels[pixelCount*4u+12u]=vec4f(f32(index),traceParams.screen.z,0,f32(sample));}
  let hybrid=traceParams.flags.x>0.5;
  var jitter=vec2f(traceRandom(&seed),traceRandom(&seed));if(hybrid){jitter=vec2f(0.5+traceParams.forward.w,0.5+traceParams.right.w);}
  let pixel=((vec2f(invocation.xy)+jitter)/vec2f(f32(width),f32(height)))*2.0-vec2f(1);
  let orthographic=traceParams.backgroundSettings.w==1.0;let perRayMedia=traceParams.backgroundSettings.w>0.5;
  let cameraOrigin=traceCameraOrigin(traceParams.origin.xyz,traceParams.right.xyz,traceParams.up.xyz,pixel,orthographic);
  var direction=traceCameraDirection(traceParams.forward.xyz,traceParams.right.xyz,traceParams.up.xyz,pixel,orthographic);
  var origin=cameraOrigin+direction*(traceParams.screen.w/max(dot(direction,traceParams.forward.xyz),1e-5));
  var throughput=vec3f(1);var radiance=vec3f(0);var previousPdf=0.0;var previousTechniques=traceParams.origin.w;var previousDelta=false;var etaScale=1.0;var previousPosition=select(cameraOrigin,origin,perRayMedia);var media:array<u32,65>;var mediumDepth=1u;media[0]=0u;
  var previousHit=-1;var previousGeometric=vec3f(0);var previousBary=vec3f(0);var previousEvent=0u;var previousFront=false;
  if(traceVolumeEnabled){
   var initialFault=0u;
   if(perRayMedia){initialFault=traceInitializePrimaryMedia(origin,&media,&mediumDepth);}
   else{let initialCount=u32(traceParams.medium.y);if(initialCount>64u){initialFault=8u;}else{for(var layer=0u;layer<initialCount;layer++){media[layer+1u]=u32(traceLights[u32(traceParams.medium.z)+layer].position.x);}mediumDepth+=initialCount;}}
   if(initialFault!=0u){atomicAdd(&traceOutput.faults,1u);atomicOr(&traceOutput.faultMask,initialFault);atomicStore(&traceOutput.faultPixel,index);continue;}
  }
  for(var bounce=0u;bounce<u32(traceParams.settings.z);bounce++){
   var hit:SurfaceHit;
   if(hybrid&&bounce==0u){let primary=textureLoad(primaryHits,vec2i(invocation.xy),0);if(primary.y< -1.5){var coverageSeed=seed;let cosine=max(dot(direction,traceParams.forward.xyz),1e-5);let exact=traceSurface(origin,direction,(traceParams.settings.w-traceParams.screen.w)/cosine,u32(traceParams.counts.x),u32(traceParams.counts.y),traceRandom(&coverageSeed));hit=SurfaceHit(exact.distance+traceParams.screen.w/cosine,exact.index,exact.bary,exact.front);}else{hit=SurfaceHit(abs(primary.x),i32(primary.y),vec3f(1.0-primary.z-primary.w,primary.z,primary.w),primary.x>=0.0);}origin=cameraOrigin;}
   else{var rayLimit=traceParams.settings.w;if(bounce==0u){rayLimit=(traceParams.settings.w-traceParams.screen.w)/max(dot(direction,traceParams.forward.xyz),1e-5);}hit=traceSurface(origin,direction,rayLimit,u32(traceParams.counts.x),u32(traceParams.counts.y),traceRandom(&seed));}
   let debugSlot=pixelCount*4u+13u+bounce*8u;
   if(targeted&&bounce<8u){for(var debugRow=0u;debugRow<8u;debugRow++){traceOutput.pixels[debugSlot+debugRow]=vec4f(0);}traceOutput.pixels[pixelCount*4u+12u].z=f32(bounce+1u);traceOutput.pixels[debugSlot]=vec4f(origin,f32(hit.index));traceOutput.pixels[debugSlot+1u]=vec4f(direction,hit.distance);traceOutput.pixels[debugSlot+2u]=vec4f(f32(mediumDepth),f32(media[mediumDepth-1u]),select(0.0,1.0,hit.front),0);}
   if(hit.index<0){if(traceVolumeEnabled&&media[mediumDepth-1u]!=0u){let fault=atomicAdd(&traceOutput.faults,1u);if(traceCaptureFault&&((traceParams.environment0.w<0.0&&fault==0u)||targeted)){let tail=pixelCount*4u;traceOutput.pixels[tail]=vec4f(origin,f32(bounce));traceOutput.pixels[tail+1u]=vec4f(direction,f32(media[mediumDepth-1u]));traceOutput.pixels[tail+2u]=vec4f(previousPosition,f32(previousHit));traceOutput.pixels[tail+3u]=vec4f(previousGeometric,f32(previousEvent));traceOutput.pixels[tail+4u]=vec4f(previousBary,f32(index));traceOutput.pixels[tail+5u]=vec4f(select(0.0,1.0,previousFront),traceParams.screen.z,f32(sample),1);if(previousHit>=0){let oldTriangle=surfaceTriangle(u32(previousHit));traceOutput.pixels[tail+6u]=oldTriangle.a;traceOutput.pixels[tail+7u]=oldTriangle.b;traceOutput.pixels[tail+8u]=oldTriangle.c;traceOutput.pixels[tail+9u]=surfaceMaterials[u32(oldTriangle.a.w)].physical;traceOutput.pixels[tail+10u]=oldTriangle.nma;traceOutput.pixels[tail+11u]=oldTriangle.nmb;}}atomicOr(&traceOutput.faultMask,4u);atomicStore(&traceOutput.faultDetail,(mediumDepth<<24u)|media[mediumDepth-1u]);atomicStore(&traceOutput.faultPixel,index);break;}if(bounce==0u){radiance+=throughput*traceBackground(direction);}else{let weight=select(1.0,tracePower(previousPdf,traceEnvironmentPdf(direction,previousTechniques)),traceParams.flags.z>0.5&&traceParams.environment.x>=0.0&&!previousDelta);radiance+=throughput*(traceEnvironmentBase(direction)*weight+traceEnvironmentAmbient(direction));}break;}
   let triangle=surfaceTriangle(u32(hit.index));var surface=evaluateSurfaceView(u32(hit.index),hit.bary,hit.front,-direction);let point=tracePoint(triangle,hit.bary);let position=point.position;var shadowMedia=TraceShadowMedia(vec3f(0),vec3f(0));
   if(traceVolumeEnabled){shadowMedia.incident=traceMediumSigma(media[mediumDepth-1u]);shadowMedia.transmitted=shadowMedia.incident;throughput*=exp(-traceMediumSigma(media[mediumDepth-1u])*length(position-previousPosition));if(surface.medium.x>0.0){let id=u32(triangle.nmb.w);if(id==0u||id>u32(traceParams.medium.w)){atomicAdd(&traceOutput.faults,1u);atomicOr(&traceOutput.faultMask,1u);break;}
     if(hit.front){var duplicate=false;for(var layer=1u;layer<mediumDepth;layer++){if(media[layer]==id){duplicate=true;}}if(duplicate){atomicAdd(&traceOutput.faults,1u);atomicOr(&traceOutput.faultMask,2u);atomicStore(&traceOutput.faultDetail,(mediumDepth<<24u)|(id<<12u)|media[mediumDepth-1u]);atomicStore(&traceOutput.faultPixel,index);break;}shadowMedia.transmitted=traceMediumSigma(id);surface.medium=vec4f(surface.medium.x,traceMediumIor(media[mediumDepth-1u]),traceMediumIor(id),1.0);}
     else{if(mediumDepth<2u||media[mediumDepth-1u]!=id){atomicAdd(&traceOutput.faults,1u);atomicOr(&traceOutput.faultMask,2u);atomicStore(&traceOutput.faultDetail,(mediumDepth<<24u)|(id<<12u)|media[mediumDepth-1u]);atomicStore(&traceOutput.faultPixel,index);break;}shadowMedia.transmitted=traceMediumSigma(media[mediumDepth-2u]);surface.medium=vec4f(surface.medium.x,traceMediumIor(media[mediumDepth-2u]),traceMediumIor(id),-1.0);}
   }}
   var geometric=normalize(cross(triangle.b.xyz-triangle.a.xyz,triangle.c.xyz-triangle.a.xyz));if(dot(geometric,direction)>0.0){geometric=-geometric;}
   if(targeted&&bounce<8u){traceOutput.pixels[debugSlot+2u].w=triangle.nmb.w;traceOutput.pixels[debugSlot+3u]=vec4f(position,surface.roughness);traceOutput.pixels[debugSlot+6u]=vec4f(hit.bary,surface.medium.z);traceOutput.pixels[debugSlot+7u]=vec4f(surface.normal,surface.medium.y);}
   if(sample==0u&&bounce==0u){firstNormal=vec4f(surface.normal,length(position-traceParams.origin.xyz));firstAlbedo=vec4f(surface.base,surface.roughness);}
   if(bounce==0u&&traceParams.flags.y>0.0){
    if(traceParams.flags.y==1.0){radiance=surface.base;}
    else if(traceParams.flags.y==2.0){radiance=surface.normal*0.5+vec3f(0.5);}
    else if(traceParams.flags.y==3.0){radiance=vec3f(clamp(hit.distance/traceParams.settings.w,0.0,1.0));}
    break;
   }
   if(surface.medium.x<0.0){radiance+=throughput*surface.base;break;}
   var emissionWeight=1.0;if(bounce>0u&&traceParams.flags.z>0.5&&!previousDelta){emissionWeight=tracePower(previousPdf,traceEmitterPdf(u32(hit.index),previousPosition,position,previousTechniques));}
   radiance+=throughput*surface.emissive*emissionWeight;
   if(traceParams.flags.z>0.5){radiance+=throughput*traceDirect(point,geometric,surface,-direction,shadowMedia,traceParams.flags.w>0.5&&bounce+1u<u32(traceParams.settings.z),&seed,bounce==0u);}
   if(traceParams.flags.w<0.5){break;}
   let branch=traceRandom(&seed);let random=vec3f(traceRandom(&seed),traceRandom(&seed),traceRandom(&seed));let next=traceScatter(surface,-direction,branch,random);
   if(targeted&&bounce<8u){traceOutput.pixels[debugSlot+4u]=vec4f(next.direction,f32(next.event));traceOutput.pixels[debugSlot+5u]=vec4f(geometric,next.pdf);}
   if(next.pdf<=0.0||!traceValidDirection(geometric,surface,next.direction)||(next.event==2u)!=(dot(geometric,next.direction)<0.0)){break;}
   if(traceVolumeEnabled&&next.event==2u){let id=u32(triangle.nmb.w);if(hit.front){if(mediumDepth>=65u){atomicAdd(&traceOutput.faults,1u);atomicOr(&traceOutput.faultMask,8u);break;}media[mediumDepth]=id;mediumDepth++;}else{mediumDepth--;}etaScale*=next.eta*next.eta;}
   throughput*=next.weight;previousTechniques=select(traceParams.origin.w,1.0,bounce==0u);previousPdf=next.pdf;previousDelta=next.delta!=0u;
   if(bounce>=2u&&!previousDelta){let survival=clamp(max(throughput.r,max(throughput.g,throughput.b))*etaScale,0.05,0.95);if(traceRandom(&seed)>survival){break;}throughput/=survival;}
   if(traceCaptureFault&&traceVolumeEnabled){previousHit=hit.index;previousGeometric=geometric;previousBary=hit.bary;previousEvent=next.event;previousFront=hit.front;}
   previousPosition=position;origin=traceOffset(point,geometric,next.direction);direction=next.direction;
  }
  radianceSum+=radiance;
 }
 var old=vec4f(0);if(traceParams.counts.w<0.5){old=traceOutput.pixels[index];}
 let accumulated=vec4f(old.rgb+radianceSum,old.a+traceParams.settings.y);traceOutput.pixels[index]=accumulated;
 var average=vec4f(accumulated.rgb/accumulated.a,accumulated.a);if(traceParams.flags.y==4.0){average=vec4f(vec3f(log2(1.0+accumulated.a)/8.0),accumulated.a);}
 traceOutput.pixels[index+pixelCount]=average;traceOutput.pixels[index+pixelCount*2u]=firstNormal;traceOutput.pixels[index+pixelCount*3u]=firstAlbedo;
}
`;

export const PRIMARY_SHADER =
  TRACE_PARAMETERS_SHADER +
  /* wgsl */ String.raw`
@group(0) @binding(7) var<uniform> primaryParams:TraceParameters;
struct PrimaryVertex{@builtin(position) position:vec4f,@location(0) @interpolate(flat) index:u32,}
@vertex fn primaryVertex(@builtin(vertex_index) vertex:u32)->PrimaryVertex{
 let index=vertex/3u;let corner=vertex%3u;let triangle=surfaceTriangle(index);var world=triangle.a.xyz;if(corner==1u){world=triangle.b.xyz;}if(corner==2u){world=triangle.c.xyz;}
 let matrix=mat4x4f(primaryParams.view0,primaryParams.view1,primaryParams.view2,primaryParams.view3);return PrimaryVertex(matrix*vec4f(world,1),index);
}
@fragment fn primaryFragment(input:PrimaryVertex,@builtin(front_facing) rasterFront:bool)->@location(0) vec4f{
 let front=surfaceOriginalFront(surfaceTriangle(input.index),rasterFront);
 let triangle=surfaceTriangle(input.index);
 // Raster subpixel setup is not precise barycentric data for ray-space motion.
 let pixel=(input.position.xy+vec2f(primaryParams.forward.w,primaryParams.right.w))/primaryParams.screen.xy*2.0-vec2f(1);
 let orthographic=primaryParams.backgroundSettings.w==1.0;
 let origin=traceCameraOrigin(primaryParams.origin.xyz,primaryParams.right.xyz,primaryParams.up.xyz,pixel,orthographic);
 let direction=traceCameraDirection(primaryParams.forward.xyz,primaryParams.right.xyz,primaryParams.up.xyz,pixel,orthographic);
 let edge1=triangle.b.xyz-triangle.a.xyz;let edge2=triangle.c.xyz-triangle.a.xyz;
 let p=cross(direction,edge2);let determinant=dot(edge1,p);if(determinant==0.0){return vec4f(0,-2,0,0);}
 let relative=origin-triangle.a.xyz;let q=cross(relative,edge1);
 let u=dot(relative,p)/determinant;let v=dot(direction,q)/determinant;
 let bary=vec3f(1.0-u-v,u,v);let distance=dot(edge2,q)/determinant;
 // Hardware raster coverage can select a neighboring face at subpixel edges.
 // Mark uncertainty for an exact GPU closest-hit query, never clamp into a false boundary.
 if(any(bary<vec3f(0))||any(bary>vec3f(1))||distance<=0.0||any((bitcast<vec4u>(vec4f(bary,distance))&vec4u(0x7f800000u))==vec4u(0x7f800000u))){return vec4f(0,-2,0,0);}
 let surface=evaluateSurfaceView(input.index,bary,front,-direction);if(surface.discarded!=0u){discard;}
 let material=surfaceMaterials[u32(triangle.a.w)];
 if(material.normal.w==2.0){let threshold=fract(sin(dot(input.position.xy,vec2f(12.9898,78.233))+primaryParams.screen.z)*43758.5453);if(surfaceCoverageRandom(threshold,input.index)>surface.alpha){discard;}}
 return vec4f(select(-distance,distance,front),f32(input.index),bary.yz);
}
`;
export const TRACE_PRESENT_SHADER = /* wgsl */ String.raw`
struct Present{size:vec4f,}
@group(0) @binding(0) var<storage,read> radiance:array<vec4f>;
@group(0) @binding(1) var<uniform> parameters:Present;
@vertex fn vertex(@builtin(vertex_index) id:u32)->@builtin(position) vec4f{let points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(points[id],0,1);}
fn displaySrgb(value:vec3f)->vec3f{return select(1.055*pow(max(value,vec3f(0)),vec3f(1.0/2.4))-vec3f(0.055),value*12.92,value<=vec3f(0.0031308));}
@fragment fn fragment(@builtin(position) pixel:vec4f)->@location(0) vec4f{
 let index=u32(pixel.y)*u32(parameters.size.x)+u32(pixel.x);var color=max(radiance[index].rgb*parameters.size.z,vec3f(0));
 if(parameters.size.w<0.5){color=clamp((color*(2.51*color+vec3f(0.03)))/(color*(2.43*color+vec3f(0.59))+vec3f(0.14)),vec3f(0),vec3f(1));}
 return vec4f(displaySrgb(color),1);
}
`;

/** Engine-owned linear HDR handoff. Exposure and display conversion happen in the composer. */
export const TRACE_LINEAR_PRESENT_SHADER = /* wgsl */ String.raw`
struct Present{size:vec4f,}
@group(0) @binding(0) var<storage,read> radiance:array<vec4f>;
@group(0) @binding(1) var<storage,read> guides:array<vec4f>;
@group(0) @binding(2) var<uniform> parameters:Present;
struct Output{@location(0) color:vec4f,@location(1) normal:vec4f,@location(2) depth:vec4f,}
@vertex fn vertex(@builtin(vertex_index) id:u32)->@builtin(position) vec4f{let points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(points[id],0,1);}
@fragment fn fragment(@builtin(position) pixel:vec4f)->Output{
 let index=u32(pixel.y)*u32(parameters.size.x)+u32(pixel.x);
 let guide=guides[index];let hit=select(0.0,1.0,guide.w>=0.0);
 return Output(vec4f(max(radiance[index].rgb,vec3f(0)),1),vec4f(guide.xyz,hit),vec4f(max(guide.w,0.0),0,0,hit));
}
`;
