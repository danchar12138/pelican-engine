/** Opaque, isotropic, single-scattering GGX + Fresnel-gated diffuse. See BSDF.md. */
export type BsdfVec3 = readonly [number, number, number];
export interface BsdfSample {
  direction: BsdfVec3;
  weight: BsdfVec3;
  pdf: number;
}

export const BSDF_MIN_ROUGHNESS = 0.045;
const PI = Math.PI;
const ZERO: BsdfVec3 = [0, 0, 0];
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const dot = (a: BsdfVec3, b: BsdfVec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (v: BsdfVec3, s: number): BsdfVec3 => [
  v[0] * s,
  v[1] * s,
  v[2] * s,
];
const add = (a: BsdfVec3, b: BsdfVec3): BsdfVec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const cross = (a: BsdfVec3, b: BsdfVec3): BsdfVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v: BsdfVec3): BsdfVec3 {
  const largest = Math.max(...v.map(Math.abs));
  if (largest === 0) return ZERO;
  const scaled: BsdfVec3 = [v[0] / largest, v[1] / largest, v[2] / largest];
  return scale(scaled, 1 / Math.sqrt(dot(scaled, scaled)));
}
function halfVector(v: BsdfVec3, l: BsdfVec3): BsdfVec3 {
  if (dot(v, l) < -0.5) {
    // For unit V,L this equals (1-dot(V,L))*(V+L), with less cancellation.
    const h = cross(cross(v, l), add(v, scale(l, -1)));
    if (Math.max(...h.map(Math.abs)) > 0) return unit(h);
  }
  return unit(add(v, l));
}
function finite(value: number, label: string): void {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(Math.fround(value)) ||
    (value !== 0 && Math.fround(value) === 0)
  )
    throw new RangeError(
      `TC_BSDF_INPUT: ${label} must be finite and f32-representable`,
    );
}
function vector(value: BsdfVec3, label: string): void {
  if (value.length !== 3)
    throw new RangeError(`TC_BSDF_INPUT: ${label} must have 3 components`);
  for (let i = 0; i < 3; i++) finite(value[i], label);
}
function validate(
  normal: BsdfVec3,
  view: BsdfVec3,
  base: BsdfVec3,
  roughness: number,
  metalness: number,
): void {
  vector(normal, "normal");
  vector(view, "view");
  vector(base, "base");
  if (base.some((v) => v < 0 || v > 1))
    throw new RangeError(
      "TC_BSDF_INPUT: linear base albedo must be in [0,1]; HDR radiance is not albedo",
    );
  finite(roughness, "roughness");
  finite(metalness, "metalness");
}
const alphaOf = (r: number) => clamp(r, BSDF_MIN_ROUGHNESS) ** 2;
const f0Of = (base: BsdfVec3, m: number, ior: number, intensity = 1, color: BsdfVec3 = [1, 1, 1]): BsdfVec3 => {
  const ratio = (ior - 1) / (ior + 1), dielectric = ior === 1.5 ? 0.04 : ratio * ratio;
  return base.map((c, i) => Math.min(dielectric * color[i], 1) * intensity * (1 - m) + c * m) as unknown as BsdfVec3;
};
function validateIor(ior: number): void {
  finite(ior, "ior");
  if (ior <= 0) throw new RangeError("TC_BSDF_INPUT: ior must be positive");
}
function validateSpecular(intensity: number, color: BsdfVec3): void {
  finite(intensity, 'specularIntensity');
  vector(color, 'specularColor');
  if (intensity < 0 || intensity > 1 || color.some((c) => c < 0 || c > 1))
    throw new RangeError('TC_BSDF_INPUT: specular intensity and color must be in [0,1]');
}
function fresnel(f0: BsdfVec3, cosine: number, f90 = 1): BsdfVec3 {
  const f = (1 - clamp(cosine)) ** 5;
  return f0.map((c) => c + (f90 - c) * f) as unknown as BsdfVec3;
}
function smithRoot(alpha: number, cosine: number): number {
  return Math.sqrt(alpha * alpha + (1 - alpha * alpha) * cosine * cosine);
}
function distribution(n: BsdfVec3, h: BsdfVec3, alpha: number): number {
  const nh = clamp(dot(n, h)),
    perpendicular = cross(n, h);
  // Algebraically Three's 1 + (alpha^2 - 1) NoH^2, without peak cancellation.
  const denominator =
    dot(perpendicular, perpendicular) + alpha * alpha * nh * nh;
  return (alpha * alpha) / (PI * denominator * denominator);
}
function probability(
  base: BsdfVec3,
  f0: BsdfVec3,
  m: number,
  nv: number,
  f90 = 1,
): number {
  const fv = fresnel(f0, nv, f90);
  const specular = (fv[0] + fv[1] + fv[2]) / 3;
  const diffuse = ((1 - m) * (base[0] + base[1] + base[2])) / 3;
  if (diffuse === 0) return 1;
  // Neither nonzero lobe may disappear from the proposal, including at grazing.
  return clamp(specular / (specular + diffuse), 0.05, 0.95);
}
function evaluate(
  n: BsdfVec3,
  v: BsdfVec3,
  l: BsdfVec3,
  base: BsdfVec3,
  r: number,
  m: number,
  ior: number,
  intensity: number,
  color: BsdfVec3,
): BsdfVec3 {
  const nv = clamp(dot(n, v)),
    nl = clamp(dot(n, l));
  if (nv <= 0 || nl <= 0) return [0, 0, 0];
  const h = halfVector(v, l),
    alpha = alphaOf(r),
    f0 = f0Of(base, m, ior, intensity, color), f90 = intensity * (1 - m) + m;
  const f = fresnel(f0, dot(v, h), f90),
    fv = fresnel(f0, nv, f90),
    fl = fresnel(f0, nl, f90);
  const visibility =
    0.5 /
    Math.max(nl * smithRoot(alpha, nv) + nv * smithRoot(alpha, nl), 1e-30);
  const dv = distribution(n, h, alpha) * visibility;
  return base.map(
    (c, i) => f[i] * dv + (c * (1 - m) * (1 - fv[i]) * (1 - fl[i])) / PI,
  ) as unknown as BsdfVec3;
}
function pdf(
  n: BsdfVec3,
  v: BsdfVec3,
  l: BsdfVec3,
  base: BsdfVec3,
  r: number,
  m: number,
  ior: number,
  intensity: number,
  color: BsdfVec3,
): number {
  const nv = clamp(dot(n, v)),
    nl = clamp(dot(n, l));
  if (nv <= 0 || nl <= 0) return 0;
  const h = halfVector(v, l),
    alpha = alphaOf(r);
  const p = probability(base, f0Of(base, m, ior, intensity, color), m, nv, intensity * (1 - m) + m);
  // Visible-normal PDF D*G1(v)*VoH/NoV and reflection Jacobian 1/(4*VoH).
  const specular =
    distribution(n, h, alpha) / (2 * (nv + smithRoot(alpha, nv)));
  return p * specular + ((1 - p) * nl) / PI;
}

/** Returns BRDF f only, in inverse steradians, with no cosine or incident radiance. */
export function evaluateBsdf(
  normal: BsdfVec3,
  view: BsdfVec3,
  light: BsdfVec3,
  base: BsdfVec3,
  roughness: number,
  metalness: number,
  ior = 1.5,
  intensity = 1,
  color: BsdfVec3 = [1, 1, 1],
): BsdfVec3 {
  validate(normal, view, base, roughness, metalness);
  validateIor(ior);
  validateSpecular(intensity, color);
  vector(light, "light");
  return evaluate(
    unit(normal),
    unit(view),
    unit(light),
    base,
    roughness,
    clamp(metalness),
    ior,
    intensity, color,
  );
}

/** Solid-angle mixture density. Its upper-hemisphere integral may be less than 1. */
export function bsdfPdf(
  normal: BsdfVec3,
  view: BsdfVec3,
  light: BsdfVec3,
  base: BsdfVec3,
  roughness: number,
  metalness: number,
  ior = 1.5,
  intensity = 1,
  color: BsdfVec3 = [1, 1, 1],
): number {
  validate(normal, view, base, roughness, metalness);
  validateIor(ior);
  validateSpecular(intensity, color);
  vector(light, "light");
  return pdf(
    unit(normal),
    unit(view),
    unit(light),
    base,
    roughness,
    clamp(metalness),
    ior,
    intensity, color,
  );
}

/** random.x selects a lobe; random.yz sample it. Null events are NOT resampled. */
export function sampleBsdf(
  normal: BsdfVec3,
  view: BsdfVec3,
  base: BsdfVec3,
  roughness: number,
  metalness: number,
  random: BsdfVec3,
  ior = 1.5,
  intensity = 1,
  color: BsdfVec3 = [1, 1, 1],
): BsdfSample {
  validate(normal, view, base, roughness, metalness);
  validateIor(ior);
  validateSpecular(intensity, color);
  vector(random, "random");
  if (random.some((v) => v < 0 || v >= 1))
    throw new RangeError(
      "TC_BSDF_INPUT: random must have independent uniform components in [0,1)",
    );
  const zero = (): BsdfSample => ({
    direction: [0, 0, 0],
    weight: [0, 0, 0],
    pdf: 0,
  });
  const n = unit(normal),
    v = unit(view),
    nv = clamp(dot(n, v));
  if (nv <= 0) return zero();
  const m = clamp(metalness),
    alpha = alphaOf(roughness);
  const t = unit(cross(Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0], n));
  const b = cross(n, t);
  const world = (local: BsdfVec3) =>
    unit(add(add(scale(t, local[0]), scale(b, local[1])), scale(n, local[2])));
  const radius = Math.sqrt(random[1]),
    phi = 2 * PI * random[2];
  const x = radius * Math.cos(phi);
  const y = radius * Math.sin(phi);
  let direction: BsdfVec3;
  if (random[0] < probability(base, f0Of(base, m, ior, intensity, color), m, nv, intensity * (1 - m) + m)) {
    // Dupuy/Benyoub 2023: exact VNDF via a spherical cap, no view-aligned basis.
    const vh = unit([alpha * dot(v, t), alpha * dot(v, b), nv]);
    const z = 1 - random[1] * (1 + vh[2]);
    const sinTheta = Math.sqrt(Math.max(0, 1 - z * z));
    const nh = add([sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), z], vh);
    const h = world(unit([alpha * nh[0], alpha * nh[1], Math.max(0, nh[2])]));
    direction = unit(add(scale(h, 2 * dot(v, h)), scale(v, -1)));
  } else {
    direction = world([x, y, Math.sqrt(Math.max(0, 1 - random[1]))]);
  }
  const nl = dot(n, direction);
  if (nl <= 0) return zero();
  const density = pdf(n, v, direction, base, roughness, m, ior, intensity, color);
  if (density <= 0) return zero();
  const f = evaluate(n, v, direction, base, roughness, m, ior, intensity, color);
  return { direction, weight: scale(f, nl / density), pdf: density };
}

/** Binding-free WGSL; all helper names are namespaced for surface/path composition. */
export const BSDF_SHADER: string = /* wgsl */ String.raw`
struct BsdfSample { direction:vec3f, weight:vec3f, pdf:f32, }
fn bsdfUnit(v:vec3f)->vec3f {
 let largest=max(max(abs(v.x),abs(v.y)),abs(v.z));
 if(largest==0.0){return vec3f(0);}
 let s=v/largest;return s/sqrt(dot(s,s));
}
fn bsdfHalfVector(v:vec3f,l:vec3f)->vec3f {
 if(dot(v,l)<-0.5){let h=cross(cross(v,l),v-l);if(max(max(abs(h.x),abs(h.y)),abs(h.z))>0.0){return bsdfUnit(h);}}
 return bsdfUnit(v+l);
}
fn bsdfAlpha(r:f32)->f32 {let roughness=clamp(r,0.045,1.0);return roughness*roughness;}
fn bsdfF0Specular(base:vec3f,m:f32,ior:f32,intensity:f32,color:vec3f)->vec3f {let ratio=(ior-1.0)/(ior+1.0);let dielectric=select(ratio*ratio,0.04,ior==1.5);return min(vec3f(dielectric)*color,vec3f(1))*intensity*(1.0-m)+base*m;}
fn bsdfF0Ior(base:vec3f,m:f32,ior:f32)->vec3f {return bsdfF0Specular(base,m,ior,1.0,vec3f(1));}
fn bsdfF0(base:vec3f,m:f32)->vec3f {return bsdfF0Ior(base,m,1.5);}
fn bsdfFresnelSpecular(f0:vec3f,cosine:f32,f90:f32)->vec3f {
 let x=1.0-clamp(cosine,0.0,1.0);let x2=x*x;return f0+(vec3f(f90)-f0)*(x2*x2*x);
}
fn bsdfFresnel(f0:vec3f,cosine:f32)->vec3f {return bsdfFresnelSpecular(f0,cosine,1.0);}
fn bsdfSmithRoot(alpha:f32,cosine:f32)->f32 {
 let a2=alpha*alpha;return sqrt(a2+(1.0-a2)*cosine*cosine);
}
fn bsdfDistribution(n:vec3f,h:vec3f,alpha:f32)->f32 {
 let nh=clamp(dot(n,h),0.0,1.0);let perpendicular=cross(n,h);
 let denominator=dot(perpendicular,perpendicular)+alpha*alpha*nh*nh;
 return alpha*alpha/(3.141592653589793*denominator*denominator);
}
fn bsdfProbabilitySpecular(base:vec3f,f0:vec3f,m:f32,nv:f32,f90:f32)->f32 {
 let fv=bsdfFresnelSpecular(f0,nv,f90);let specular=(fv.x+fv.y+fv.z)/3.0;
 let diffuse=(1.0-m)*(base.x+base.y+base.z)/3.0;
 if(diffuse==0.0){return 1.0;}
 return clamp(specular/(specular+diffuse),0.05,0.95);
}
fn bsdfProbability(base:vec3f,f0:vec3f,m:f32,nv:f32)->f32 {return bsdfProbabilitySpecular(base,f0,m,nv,1.0);}
fn bsdfEvaluateSpecular(normal:vec3f,view:vec3f,light:vec3f,base:vec3f,roughness:f32,metalness:f32,ior:f32,intensity:f32,color:vec3f)->vec3f {
 let n=bsdfUnit(normal);let v=bsdfUnit(view);let l=bsdfUnit(light);
 let nv=clamp(dot(n,v),0.0,1.0);let nl=clamp(dot(n,l),0.0,1.0);
 if(nv<=0.0||nl<=0.0){return vec3f(0);}
 let m=clamp(metalness,0.0,1.0);let h=bsdfHalfVector(v,l);let alpha=bsdfAlpha(roughness);let f0=bsdfF0Specular(base,m,ior,intensity,color);let f90=intensity*(1.0-m)+m;
 let f=bsdfFresnelSpecular(f0,dot(v,h),f90);let fv=bsdfFresnelSpecular(f0,nv,f90);let fl=bsdfFresnelSpecular(f0,nl,f90);
 let visibility=0.5/max(nl*bsdfSmithRoot(alpha,nv)+nv*bsdfSmithRoot(alpha,nl),1e-30);
 return f*(bsdfDistribution(n,h,alpha)*visibility)+base*(1.0-m)*(vec3f(1)-fv)*(vec3f(1)-fl)/3.141592653589793;
}
fn bsdfPdfSpecular(normal:vec3f,view:vec3f,light:vec3f,base:vec3f,roughness:f32,metalness:f32,ior:f32,intensity:f32,color:vec3f)->f32 {
 let n=bsdfUnit(normal);let v=bsdfUnit(view);let l=bsdfUnit(light);
 let nv=clamp(dot(n,v),0.0,1.0);let nl=clamp(dot(n,l),0.0,1.0);
 if(nv<=0.0||nl<=0.0){return 0.0;}
 let m=clamp(metalness,0.0,1.0);let h=bsdfHalfVector(v,l);let alpha=bsdfAlpha(roughness);
 let p=bsdfProbabilitySpecular(base,bsdfF0Specular(base,m,ior,intensity,color),m,nv,intensity*(1.0-m)+m);
 let specular=bsdfDistribution(n,h,alpha)/(2.0*(nv+bsdfSmithRoot(alpha,nv)));
 return p*specular+(1.0-p)*nl/3.141592653589793;
}
fn bsdfWorld(n:vec3f,t:vec3f,b:vec3f,local:vec3f)->vec3f {
 return bsdfUnit(t*local.x+b*local.y+n*local.z);
}
fn bsdfSampleSpecular(normal:vec3f,view:vec3f,base:vec3f,roughness:f32,metalness:f32,random:vec3f,ior:f32,intensity:f32,color:vec3f)->BsdfSample {
 let zero=BsdfSample(vec3f(0),vec3f(0),0.0);
 let n=bsdfUnit(normal);let v=bsdfUnit(view);let nv=clamp(dot(n,v),0.0,1.0);
 if(nv<=0.0){return zero;}
 let m=clamp(metalness,0.0,1.0);let alpha=bsdfAlpha(roughness);
 var up=vec3f(1,0,0);if(abs(n.z)<0.999){up=vec3f(0,0,1);}
 let t=bsdfUnit(cross(up,n));let b=cross(n,t);
 let radius=sqrt(random.y);let phi=6.283185307179586*random.z;
 let x=radius*cos(phi);let y=radius*sin(phi);var direction:vec3f;
 if(random.x<bsdfProbabilitySpecular(base,bsdfF0Specular(base,m,ior,intensity,color),m,nv,intensity*(1.0-m)+m)) {
  let vh=bsdfUnit(vec3f(alpha*dot(v,t),alpha*dot(v,b),nv));
  let z=1.0-random.y*(1.0+vh.z);let sinTheta=sqrt(max(0.0,1.0-z*z));
  let nh=vec3f(sinTheta*cos(phi),sinTheta*sin(phi),z)+vh;
  let h=bsdfWorld(n,t,b,bsdfUnit(vec3f(alpha*nh.x,alpha*nh.y,max(0.0,nh.z))));
  direction=bsdfUnit(2.0*dot(v,h)*h-v);
 } else {direction=bsdfWorld(n,t,b,vec3f(x,y,sqrt(max(0.0,1.0-random.y))));}
 let nl=dot(n,direction);if(nl<=0.0){return zero;}
 let density=bsdfPdfSpecular(n,v,direction,base,roughness,m,ior,intensity,color);if(density<=0.0){return zero;}
 return BsdfSample(direction,bsdfEvaluateSpecular(n,v,direction,base,roughness,m,ior,intensity,color)*(nl/density),density);
}
fn bsdfEvaluateIor(n:vec3f,v:vec3f,l:vec3f,base:vec3f,r:f32,m:f32,ior:f32)->vec3f{return bsdfEvaluateSpecular(n,v,l,base,r,m,ior,1.0,vec3f(1));}
fn bsdfPdfIor(n:vec3f,v:vec3f,l:vec3f,base:vec3f,r:f32,m:f32,ior:f32)->f32{return bsdfPdfSpecular(n,v,l,base,r,m,ior,1.0,vec3f(1));}
fn bsdfSampleIor(n:vec3f,v:vec3f,base:vec3f,r:f32,m:f32,random:vec3f,ior:f32)->BsdfSample{return bsdfSampleSpecular(n,v,base,r,m,random,ior,1.0,vec3f(1));}
fn bsdfEvaluate(n:vec3f,v:vec3f,l:vec3f,base:vec3f,r:f32,m:f32)->vec3f{return bsdfEvaluateIor(n,v,l,base,r,m,1.5);}
fn bsdfPdf(n:vec3f,v:vec3f,l:vec3f,base:vec3f,r:f32,m:f32)->f32{return bsdfPdfIor(n,v,l,base,r,m,1.5);}
fn bsdfSample(n:vec3f,v:vec3f,base:vec3f,r:f32,m:f32,random:vec3f)->BsdfSample{return bsdfSampleIor(n,v,base,r,m,random,1.5);}
`;
