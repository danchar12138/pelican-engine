/** Surface storage bindings 0..3, dynamic acceleration nodes at 4. Caller normalizes ray direction. */
export const SURFACE_RAY_SHADER = /* wgsl */ String.raw`
override surfaceOrderedTraversal:bool=false;
struct SurfaceNode{lo:vec4f,hi:vec4f,}
struct SurfaceHit{distance:f32,index:i32,bary:vec3f,front:bool,}
struct SurfaceCursor{current:u32,previous:u32,}
@group(0) @binding(4) var<storage,read> surfaceAccelerationData:array<vec4f>;
fn surfaceLoadNode(index:u32)->SurfaceNode{return SurfaceNode(surfaceAccelerationData[index*2u],surfaceAccelerationData[index*2u+1u]);}
fn surfaceBox(origin:vec3f,direction:vec3f,node:SurfaceNode,maxDistance:f32)->bool{
 var near=0.0;var far=maxDistance;
 for(var axis=0u;axis<3u;axis++){
  if(abs(direction[axis])<1e-20){if(origin[axis]<node.lo[axis]||origin[axis]>node.hi[axis]){return false;}}
  else{let a=(node.lo[axis]-origin[axis])/direction[axis];let b=(node.hi[axis]-origin[axis])/direction[axis];near=max(near,min(a,b));far=min(far,max(a,b));if(near>far){return false;}}
 }return far>=near;
}
fn surfaceEntry(origin:vec3f,direction:vec3f,inverse:vec3f,node:SurfaceNode,maxDistance:f32)->f32{
 let parallel=abs(direction)<vec3f(1e-20);if(any(parallel&((origin<node.lo.xyz)|(origin>node.hi.xyz)))){return 1e30;}
 let a=(node.lo.xyz-origin)*inverse;let b=(node.hi.xyz-origin)*inverse;let low=min(a,b);let high=max(a,b);let near=max(max(low.x,low.y),max(low.z,0.0));let far=min(min(high.x,high.y),min(high.z,maxDistance));return select(1e30,near,near<=far);
}
// Shared-edge predicates use the same sheared endpoint products in either winding.
fn surfaceBoundary(origin:vec3f,direction:vec3f,a:vec3f,b:vec3f,c:vec3f,maxDistance:f32)->vec4f{
 var kz=0u;if(abs(direction.y)>abs(direction.x)){kz=1u;}if(abs(direction.z)>abs(direction[kz])){kz=2u;}
 var kx=(kz+1u)%3u;var ky=(kx+1u)%3u;if(direction[kz]<0.0){let swap=kx;kx=ky;ky=swap;}
 let relativeA=a-origin;let relativeB=b-origin;let relativeC=c-origin;
 let sx=direction[kx]/direction[kz];let sy=direction[ky]/direction[kz];
 let pa=vec2f(relativeA[kx]-sx*relativeA[kz],relativeA[ky]-sy*relativeA[kz]);
 let pb=vec2f(relativeB[kx]-sx*relativeB[kz],relativeB[ky]-sy*relativeB[kz]);
 let pc=vec2f(relativeC[kx]-sx*relativeC[kz],relativeC[ky]-sy*relativeC[kz]);
 let edges=vec3f(pb.x*pc.y-pb.y*pc.x,pc.x*pa.y-pc.y*pa.x,pa.x*pb.y-pa.y*pb.x);
 if(any(edges<vec3f(0))&&any(edges>vec3f(0))){return vec4f(0,0,0,-1);}
 let determinant=edges.x+edges.y+edges.z;if(determinant==0.0){return vec4f(0,0,0,-1);}
 let distance=dot(edges,vec3f(relativeA[kz],relativeB[kz],relativeC[kz]))/(determinant*direction[kz]);
 if(distance<=0.0||distance>maxDistance){return vec4f(0,0,0,-1);}
 return vec4f(edges/determinant,distance);
}
// Parent links permit near-first descent without a fixed per-ray traversal stack.
fn surfaceNextLeaf(origin:vec3f,direction:vec3f,inverse:vec3f,limit:f32,nodeCount:u32,triangleCount:u32,cursor:ptr<function,SurfaceCursor>)->u32{
 loop{
  let current=(*cursor).current;if(current>=nodeCount){return nodeCount;}
  let node=surfaceLoadNode(current);
  let links=surfaceAccelerationData[nodeCount*2u+triangleCount*3u+current];let parent=u32(links.x);
  if(current==0u&&(*cursor).previous==nodeCount&&surfaceEntry(origin,direction,inverse,node,limit)==1e30){(*cursor).current=nodeCount;return nodeCount;}
  if(node.hi.w>0.0){(*cursor).previous=current;(*cursor).current=parent;return current;}
  let left=u32(links.y);let right=u32(links.z);
  let leftEntry=surfaceEntry(origin,direction,inverse,surfaceLoadNode(left),1e30);
  let rightEntry=surfaceEntry(origin,direction,inverse,surfaceLoadNode(right),1e30);
  let first=select(left,right,rightEntry<leftEntry);let second=select(right,left,rightEntry<leftEntry);
  let near= min(leftEntry,rightEntry);let far=max(leftEntry,rightEntry);
  var next=parent;
  if((*cursor).previous==parent&&near<1e30&&near<=limit){next=first;}
  else if(((*cursor).previous==parent||(*cursor).previous==first)&&far<1e30&&far<=limit){next=second;}
  (*cursor).previous=current;(*cursor).current=next;
 }
}
fn traceSurface(origin:vec3f,direction:vec3f,maxDistance:f32,nodeCount:u32,triangleCount:u32,coverageRandom:f32)->SurfaceHit{
 var hit=SurfaceHit(maxDistance,-1,vec3f(0),true);if(nodeCount==0u||triangleCount==0u){return hit;}
 let inverse=1.0/select(vec3f(1e-30),direction,abs(direction)>vec3f(1e-20));var current=0u;var cursor=SurfaceCursor(0u,nodeCount);
 loop{if(surfaceOrderedTraversal){current=surfaceNextLeaf(origin,direction,inverse,hit.distance,nodeCount,triangleCount,&cursor);}if(current>=nodeCount){break;}let node=surfaceLoadNode(current);if(!surfaceOrderedTraversal&&surfaceEntry(origin,direction,inverse,node,hit.distance)==1e30){current=select(u32(node.lo.w),current+1u,node.hi.w>0.0);continue;}
  if(node.hi.w>0.0){let start=u32(node.lo.w);let count=u32(node.hi.w);
   for(var slot=0u;slot<count;slot++){
    let index=start+slot;if(index>=triangleCount){continue;}let offset=nodeCount*2u+index*3u;let a=surfaceAccelerationData[offset];let packedB=surfaceAccelerationData[offset+1u];let b=packedB.xyz;let c=surfaceAccelerationData[offset+2u].xyz;let edge1=b-a.xyz;let edge2=c-a.xyz;let p=cross(direction,edge2);let determinant=dot(edge1,p);let material=surfaceMaterials[u32(a.w)];let epsilon=1e-7*length(edge1)*length(edge2);if(determinant==0.0||((!surfacePhysicalEnabled||material.physical.x<=0.0)&&abs(determinant)<=epsilon)){continue;}
    let front=(determinant>0.0)==(packedB.w>0.0);if((!surfacePhysicalEnabled||material.physical.x<=0.0)&&((material.maps1.w==0.0&&!front)||(material.maps1.w==1.0&&front))){continue;}
    var distance:f32;var bary:vec3f;if((surfacePhysicalEnabled&&material.physical.x>0.0)){let boundary=surfaceBoundary(origin,direction,a.xyz,b,c,hit.distance);if(boundary.w<0.0){continue;}distance=boundary.w;bary=boundary.xyz;}else{let inverse=1.0/determinant;let relative=origin-a.xyz;let u=dot(relative,p)*inverse;if(u<0.0||u>1.0){continue;}let q=cross(relative,edge1);let v=dot(direction,q)*inverse;if(v<0.0||u+v>1.0){continue;}distance=dot(edge2,q)*inverse;if(distance<=1e-5||distance>hit.distance){continue;}bary=vec3f(1.0-u-v,u,v);}
    let coverage=surfaceCoverage(index,bary,front);
    if(coverage.y>0.5||(material.normal.w==2.0&&surfaceCoverageRandom(coverageRandom,index)>coverage.x)){continue;}
    if(distance==hit.distance&&hit.index>=0&&index>=u32(hit.index)){continue;}
    hit=SurfaceHit(distance,i32(index),bary,front);
   }
  }
 current++;
 }return hit;
}
fn occludedSurface(origin:vec3f,direction:vec3f,maxDistance:f32,nodeCount:u32,triangleCount:u32,coverageRandom:f32)->bool{
 var hit=SurfaceHit(maxDistance,-1,vec3f(0),true);if(nodeCount==0u||triangleCount==0u){return false;}
 let inverse=1.0/select(vec3f(1e-30),direction,abs(direction)>vec3f(1e-20));var current=0u;
 loop{if(current>=nodeCount){break;}let node=surfaceLoadNode(current);if(surfaceEntry(origin,direction,inverse,node,hit.distance)==1e30){current=select(u32(node.lo.w),current+1u,node.hi.w>0.0);continue;}
  if(node.hi.w>0.0){let start=u32(node.lo.w);let count=u32(node.hi.w);
   for(var slot=0u;slot<count;slot++){
    let index=start+slot;if(index>=triangleCount){continue;}let offset=nodeCount*2u+index*3u;let a=surfaceAccelerationData[offset];let packedB=surfaceAccelerationData[offset+1u];let b=packedB.xyz;let c=surfaceAccelerationData[offset+2u].xyz;let edge1=b-a.xyz;let edge2=c-a.xyz;let p=cross(direction,edge2);let determinant=dot(edge1,p);let material=surfaceMaterials[u32(a.w)];let epsilon=1e-7*length(edge1)*length(edge2);if(determinant==0.0||((!surfacePhysicalEnabled||material.physical.x<=0.0)&&abs(determinant)<=epsilon)){continue;}
    let front=(determinant>0.0)==(packedB.w>0.0);if((!surfacePhysicalEnabled||material.physical.x<=0.0)&&((material.maps1.w==0.0&&!front)||(material.maps1.w==1.0&&front))){continue;}
    var distance:f32;var bary:vec3f;if((surfacePhysicalEnabled&&material.physical.x>0.0)){let boundary=surfaceBoundary(origin,direction,a.xyz,b,c,hit.distance);if(boundary.w<0.0){continue;}distance=boundary.w;bary=boundary.xyz;}else{let inverse=1.0/determinant;let relative=origin-a.xyz;let u=dot(relative,p)*inverse;if(u<0.0||u>1.0){continue;}let q=cross(relative,edge1);let v=dot(direction,q)*inverse;if(v<0.0||u+v>1.0){continue;}distance=dot(edge2,q)*inverse;if(distance<=1e-5||distance>hit.distance){continue;}bary=vec3f(1.0-u-v,u,v);}
    let coverage=surfaceCoverage(index,bary,front);
    if(coverage.y>0.5||(material.normal.w==2.0&&surfaceCoverageRandom(coverageRandom,index)>coverage.x)){continue;}
    if(distance==hit.distance&&hit.index>=0&&index>=u32(hit.index)){continue;}
    return true;
   }
  }
 current++;
 }return false;
}
`;
