/** Shared shader surface evaluator. Bindings 0..3 match surface-gpu ABI 1. */
import { DEFAULT_SURFACE_GRAPHS } from "./material-graphs.ts";
export const SURFACE_SHADER = /* wgsl */ String.raw`
override surfacePhysicalEnabled:bool=true;
struct SurfaceTriangle {
 a:vec4f,b:vec4f,c:vec4f,na:vec4f,nb:vec4f,nc:vec4f,
 ua:vec4f,ub:vec4f,uc:vec4f,ca:vec4f,cb:vec4f,cc:vec4f,
 ta:vec4f,tb:vec4f,tc:vec4f,nma:vec4f,nmb:vec4f,nmc:vec4f,
}
struct SurfaceMaterial {base:vec4f,factors:vec4f,emission:vec4f,maps0:vec4f,maps1:vec4f,normal:vec4f,physical:vec4f,attenuation:vec4f,}
struct SurfaceTexture {info:vec4u,modes:vec4u,m0:vec4f,m1:vec4f,m2:vec4f,options:vec4f,}
struct SurfaceValue {base:vec3f,alpha:f32,normal:vec3f,roughness:f32,emissive:vec3f,metalness:f32,ao:f32,discarded:u32,medium:vec4f,specular:vec4f,}
fn surfaceCoverageRandom(random:f32,index:u32)->f32{var value=bitcast<u32>(random)^(index*0x9e3779b9u+0x85ebca6bu);value=(value^(value>>16u))*0x7feb352du;value=(value^(value>>15u))*0x846ca68bu;value=value^(value>>16u);return min(f32(value)/4294967296.0,0.99999994);}
fn surfaceOriginalFront(triangle:SurfaceTriangle,geometricFront:bool)->bool{return geometricFront==(triangle.nma.w>0.0);}
fn surfaceNormalSign(material:SurfaceMaterial,front:bool)->f32{return select(1.0,-1.0,select(material.maps1.w==1.0||(material.maps1.w==2.0&&!front),!front,surfacePhysicalEnabled&&material.physical.x>0.0));}
fn surfaceGraphNormal(value:vec3f,fallback:vec3f)->vec3f{let scale=max(max(abs(value.x),abs(value.y)),abs(value.z));if(scale==0.0){return fallback;}return normalize(value/scale);}
@group(0) @binding(0) var<storage,read> surfaceGeometry:array<vec4f>;
fn surfaceTriangle(index:u32)->SurfaceTriangle{
 let p=index*18u;return SurfaceTriangle(surfaceGeometry[p],surfaceGeometry[p+1u],surfaceGeometry[p+2u],surfaceGeometry[p+3u],surfaceGeometry[p+4u],surfaceGeometry[p+5u],surfaceGeometry[p+6u],surfaceGeometry[p+7u],surfaceGeometry[p+8u],surfaceGeometry[p+9u],surfaceGeometry[p+10u],surfaceGeometry[p+11u],surfaceGeometry[p+12u],surfaceGeometry[p+13u],surfaceGeometry[p+14u],surfaceGeometry[p+15u],surfaceGeometry[p+16u],surfaceGeometry[p+17u]);
}
@group(0) @binding(1) var<storage,read> surfaceMaterials:array<SurfaceMaterial>;
@group(0) @binding(2) var<storage,read> surfaceTextures:array<SurfaceTexture>;
@group(0) @binding(3) var<storage,read> surfaceTexels:array<u32>;
fn surfaceSrgb(value:vec3f)->vec3f {return select(pow((value+vec3f(0.055))/1.055,vec3f(2.4)),value/12.92,value<=vec3f(0.04045));}
fn surfaceIndex(value:i32,size:i32,mode:u32)->i32{
 if(mode==0u){return clamp(value,0,size-1);}
 if(mode==1u){return ((value%size)+size)%size;}
 let period=size*2;let index=((value%period)+period)%period;return select(period-1-index,index,index<size);
}
fn surfaceRead(texture:SurfaceTexture,x:i32,y:i32)->vec4f{
 let index=u32(surfaceIndex(y,i32(texture.info.z),texture.modes.y))*texture.info.y+u32(surfaceIndex(x,i32(texture.info.y),texture.modes.x));
 var value:vec4f;
 if((texture.modes.w&1u)!=0u){let offset=texture.info.x+index*4u;value=vec4f(bitcast<f32>(surfaceTexels[offset]),bitcast<f32>(surfaceTexels[offset+1u]),bitcast<f32>(surfaceTexels[offset+2u]),bitcast<f32>(surfaceTexels[offset+3u]));}
 else{value=unpack4x8unorm(surfaceTexels[texture.info.x+index]);}
 if((texture.modes.w&2u)!=0u){value=vec4f(surfaceSrgb(value.rgb),value.a);}return value;
}
fn surfaceUV(texture:SurfaceTexture,uvs:vec4f)->vec2f{
 let uv=select(uvs.xy,uvs.zw,texture.info.w==1u);return (mat3x3f(texture.m0.xyz,texture.m1.xyz,texture.m2.xyz)*vec3f(uv,1)).xy;
}
fn surfaceWrap(value:f32,mode:u32)->f32{
 if(mode==0u){return clamp(value,0.0,1.0);}if(mode==1u){return fract(value);}let p=value-floor(value/2.0)*2.0;return select(2.0-p,p,p<=1.0);
}
fn surfaceCoverage(index:u32,bary:vec3f,front:bool)->vec2f{
 let material=surfaceMaterials[u32(surfaceTriangle(index).a.w)];
 if((!surfacePhysicalEnabled||material.physical.x==0.0)&&((material.maps1.w==0.0&&!front)||(material.maps1.w==1.0&&front))){return vec2f(0,1);}
 if(material.normal.w==0.0&&material.factors.z==0.0){return vec2f(1,0);}
 let triangle=surfaceTriangle(index);
 let uv=triangle.ua*bary.x+triangle.ub*bary.y+triangle.uc*bary.z;var alpha=material.base.a;
 if(triangle.nb.w>0.5){alpha*=triangle.ca.a*bary.x+triangle.cb.a*bary.y+triangle.cc.a*bary.z;}
 alpha*=surfaceMap(material.maps0.x,uv).a*surfaceMap(material.maps0.y,uv).g;
 let custom=surfaceGraphOpacity(index,bary,front);if(custom.y>0.5){alpha*=custom.x;}
 return vec2f(alpha,select(0.0,1.0,material.factors.z>0.0&&alpha<=material.factors.z));
}
fn surfaceMap(id:f32,uvs:vec4f)->vec4f{
 if(id<0.0){return vec4f(1);}let texture=surfaceTextures[u32(id)];let uv=surfaceUV(texture,uvs);let coordinate=vec2f(surfaceWrap(uv.x,texture.modes.x),surfaceWrap(uv.y,texture.modes.y))*vec2f(texture.info.yz);
 if(texture.modes.z==0u){let pixel=vec2i(floor(coordinate));return surfaceRead(texture,pixel.x,pixel.y);}
 let at=coordinate-vec2f(0.5);let pixel=vec2i(floor(at));let blend=fract(at);return mix(mix(surfaceRead(texture,pixel.x,pixel.y),surfaceRead(texture,pixel.x+1,pixel.y),blend.x),mix(surfaceRead(texture,pixel.x,pixel.y+1),surfaceRead(texture,pixel.x+1,pixel.y+1),blend.x),blend.y);
}
fn evaluateSurface(index:u32,bary:vec3f,front:bool)->SurfaceValue{
 return evaluateSurfaceView(index,bary,front,vec3f(0));
}
fn evaluateSurfaceView(index:u32,bary:vec3f,front:bool,view:vec3f)->SurfaceValue{
 let triangle=surfaceTriangle(index);let material=surfaceMaterials[u32(triangle.a.w)];let uv=triangle.ua*bary.x+triangle.ub*bary.y+triangle.uc*bary.z;
 let reverse=select(material.maps1.w==1.0||(material.maps1.w==2.0&&!front),!front,(surfacePhysicalEnabled&&material.physical.x>0.0));let sign=select(1.0,-1.0,reverse);
 var normal=normalize(triangle.na.xyz*bary.x+triangle.nb.xyz*bary.y+triangle.nc.xyz*bary.z)*sign;
 var color=material.base;if(triangle.nb.w>0.5){color*=triangle.ca*bary.x+triangle.cb*bary.y+triangle.cc*bary.z;}
 color*=vec4f(triangle.b.w,triangle.c.w,triangle.na.w,1);color*=surfaceMap(material.maps0.x,uv);color.a*=surfaceMap(material.maps0.y,uv).g;
 let roughness=material.factors.x*surfaceMap(material.maps0.w,uv).g;let metalness=material.factors.y*surfaceMap(material.maps1.x,uv).b;
 let ao=1.0+(surfaceMap(material.maps1.y,uv).r-1.0)*material.factors.w;let emissive=material.emission.rgb*material.emission.w*surfaceMap(material.maps1.z,uv).rgb;
 if(material.maps0.z>=0.0){
  let texture=surfaceTextures[u32(material.maps0.z)];var sampled=surfaceMap(material.maps0.z,uv).xyz*2.0-vec3f(1);sampled=vec3f(sampled.xy*material.normal.xy,sampled.z);
  if(material.normal.z>0.5){normal=normalize(mat3x3f(triangle.nma.xyz,triangle.nmb.xyz,triangle.nmc.xyz)*sampled*sign);}
  else{
   var tangent:vec3f;var handedness:f32;
   if(triangle.nc.w>0.5){let t=triangle.ta*bary.x+triangle.tb*bary.y+triangle.tc*bary.z;tangent=normalize(t.xyz)*sign;handedness=select(-1.0,1.0,t.w>=0.0);}
   else{let a=surfaceUV(texture,triangle.ua);let b=surfaceUV(texture,triangle.ub);let c=surfaceUV(texture,triangle.uc);let du1=b-a;let du2=c-a;let det=du1.x*du2.y-du2.x*du1.y;let edge1=triangle.b.xyz-triangle.a.xyz;let edge2=triangle.c.xyz-triangle.a.xyz;
    let derivativeT=(edge1*du2.y-edge2*du1.y)/det;let derivativeB=(edge2*du1.x-edge1*du2.x)/det;tangent=normalize(derivativeT-normal*dot(derivativeT,normal))*sign;handedness=select(-1.0,1.0,dot(cross(normal,tangent),derivativeB)>=0.0);
   }
   let bitangent=normalize(cross(normal,tangent))*handedness*sign;normal=normalize(tangent*sampled.x+bitangent*sampled.y+normal*sampled.z);
  }
 }
 var medium=material.physical;var specular=vec4f(select(material.attenuation.rgb,vec3f(1),medium.x>0.0),1.0-medium.w);
 if(medium.x==0.0){specular*=vec4f(surfaceMap(material.attenuation.w-1.0,uv).rgb,surfaceMap(medium.z-1.0,uv).a);medium.z=0.0;}
 var result=surfaceGraphApply(index,bary,front,view,SurfaceValue(color.rgb,color.a,normal,roughness,emissive,metalness,ao,0u,medium,specular));
 let discarded=((!surfacePhysicalEnabled||material.physical.x==0.0)&&((material.maps1.w==0.0&&!front)||(material.maps1.w==1.0&&front)))||(material.factors.z>0.0&&result.alpha<=material.factors.z);
 result.discarded=select(0u,1u,discarded);return result;
}
` + DEFAULT_SURFACE_GRAPHS;
