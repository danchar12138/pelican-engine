/** Isolated, single-scattering dielectric reference. See ../DIELECTRIC.md. */
export type DielectricVec3 = readonly [number, number, number];
export type DielectricTransport = "radiance" | "importance";
export type DielectricEvent = "null" | "reflection" | "transmission";

export interface DielectricMaterial {
  /** normal points from etaInside toward etaOutside. Both IORs are positive. */
  readonly etaOutside: number;
  readonly etaInside: number;
  /** [0,1]. Zero is delta; positive values use alpha=max(0.0025,roughness^2). */
  readonly roughness: number;
  /** Linear RGB transmission multiplier in [0,1]; reflection remains untinted. */
  readonly tint?: DielectricVec3;
  /** PBRT convention, default radiance. Transmission radiance = importance/eta^2. */
  readonly transport?: DielectricTransport;
}
export interface DielectricSample {
  readonly direction: DielectricVec3;
  /** f*abs(N.L)/pdf, or the corresponding delta throughput. */
  readonly weight: DielectricVec3;
  /** sr^-1 for rough events; discrete Fresnel branch mass for delta events. */
  readonly pdf: number;
  /** eta on the direction side / eta on the view side, transmission only; else 1. */
  readonly eta: number;
  readonly event: DielectricEvent;
  readonly delta: boolean;
}

export const DIELECTRIC_MIN_ALPHA = 0.0025;
const dielectricWhite: DielectricVec3 = [1, 1, 1];
const dielectricZero: DielectricVec3 = [0, 0, 0];
function dielectricDot(a: DielectricVec3, b: DielectricVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function dielectricScale(a: DielectricVec3, s: number): DielectricVec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dielectricAdd(a: DielectricVec3, b: DielectricVec3): DielectricVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function dielectricCross(a: DielectricVec3, b: DielectricVec3): DielectricVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dielectricUnit(a: DielectricVec3): DielectricVec3 {
  return dielectricScale(a, 1 / Math.hypot(...a));
}
function dielectricVector(a: DielectricVec3, name: string): void {
  if (a.length !== 3 || !a.every(Number.isFinite) || Math.hypot(...a) === 0)
    throw new RangeError(
      `DIELECTRIC_INPUT: ${name} must be a finite nonzero vec3`,
    );
}
function dielectricColor(a: DielectricVec3): void {
  if (a.length !== 3 || !a.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
    throw new RangeError("DIELECTRIC_INPUT: linear color must be in [0,1]");
}
function dielectricIor(x: number): void {
  if (!Number.isFinite(x) || x <= 0)
    throw new RangeError("DIELECTRIC_INPUT: IOR must be finite and positive");
}
function dielectricValidate(
  n: DielectricVec3,
  v: DielectricVec3,
  m: DielectricMaterial,
): void {
  dielectricVector(n, "normal");
  dielectricVector(v, "view");
  dielectricIor(m.etaOutside);
  dielectricIor(m.etaInside);
  const ratio = m.etaInside / m.etaOutside;
  if (!Number.isFinite(ratio * ratio) || ratio * ratio === 0)
    throw new RangeError(
      "DIELECTRIC_INPUT: IOR ratio squared must be representable",
    );
  if (!Number.isFinite(m.roughness) || m.roughness < 0 || m.roughness > 1)
    throw new RangeError("DIELECTRIC_INPUT: roughness must be in [0,1]");
  dielectricColor(m.tint ?? dielectricWhite);
  if (
    m.transport !== undefined &&
    m.transport !== "radiance" &&
    m.transport !== "importance"
  )
    throw new RangeError("DIELECTRIC_INPUT: unsupported transport mode");
}
/** Exact unpolarized Fresnel, cosIncident in [0,1], eta=etaT/etaI. */
export function dielectricFresnelCPU(cosIncident: number, eta: number): number {
  dielectricIor(eta);
  if (!Number.isFinite(cosIncident) || cosIncident < 0 || cosIncident > 1)
    throw new RangeError("DIELECTRIC_INPUT: cosIncident must be in [0,1]");
  return dielectricFresnel(cosIncident, eta);
}
function dielectricFresnel(c: number, e: number): number {
  if (e === 1) return 0;
  const s2 = Math.max(0, 1 - c * c) / (e * e);
  if (s2 >= 1) return 1;
  const t = Math.sqrt(1 - s2);
  const rs = (c - e * t) / (c + e * t),
    rp = (e * c - t) / (e * c + t);
  return (rs * rs + rp * rp) * 0.5;
}
function dielectricOrient(
  n: DielectricVec3,
  v: DielectricVec3,
  m: DielectricMaterial,
) {
  const outside = dielectricDot(n, v) >= 0;
  return {
    n: outside ? n : dielectricScale(n, -1),
    eta: outside ? m.etaInside / m.etaOutside : m.etaOutside / m.etaInside,
  };
}
function dielectricD(n: DielectricVec3, h: DielectricVec3, a: number): number {
  const nh = dielectricDot(n, h),
    s = dielectricCross(n, h);
  const d = dielectricDot(s, s) + a * a * nh * nh;
  return nh > 0 ? (a * a) / (Math.PI * d * d) : 0;
}
function dielectricLambda(c: number, a: number): number {
  return (Math.sqrt(1 + (a * a * Math.max(0, 1 - c * c)) / (c * c)) - 1) * 0.5;
}
function dielectricTerms(
  n: DielectricVec3,
  v: DielectricVec3,
  l: DielectricVec3,
  m: DielectricMaterial,
) {
  const o = dielectricOrient(n, v, m);
  n = o.n;
  const nv = dielectricDot(n, v),
    nl = dielectricDot(n, l),
    e = o.eta;
  if (nv === 0 || nl === 0 || m.roughness === 0 || e === 1) return undefined;
  const reflection = nl > 0;
  let sum = dielectricAdd(v, dielectricScale(l, reflection ? 1 : e));
  if (Math.hypot(...sum) === 0) return undefined;
  // Unit-vector identity: (v x l) x (v-l) = (1-v.l)*(v+l).
  // Avoid amplifying unequal f32 normalization lengths in a grazing bisector.
  if (reflection && dielectricDot(v, l) < 0)
    sum = dielectricCross(
      dielectricCross(v, l),
      dielectricAdd(v, dielectricScale(l, -1)),
    );
  let h = dielectricUnit(sum);
  if (dielectricDot(n, h) < 0) h = dielectricScale(h, -1);
  return dielectricTermsWithHalfVector(n, v, l, h, e, m);
}
// n faces v. Sampling retains its VNDF h instead of inverting a rounded direction.
function dielectricTermsWithHalfVector(
  n: DielectricVec3,
  v: DielectricVec3,
  l: DielectricVec3,
  h: DielectricVec3,
  e: number,
  m: DielectricMaterial,
) {
  const nv = dielectricDot(n, v),
    nl = dielectricDot(n, l);
  const reflection = nl > 0;
  if (nv <= 0 || nl === 0) return undefined;
  const vh = dielectricDot(v, h),
    lh = dielectricDot(l, h);
  if (vh <= 0 || lh * nl <= 0) return undefined;
  const a = Math.max(DIELECTRIC_MIN_ALPHA, m.roughness * m.roughness);
  const d = dielectricD(n, h, a),
    lv = dielectricLambda(nv, a),
    ll = dielectricLambda(Math.abs(nl), a);
  const g = 1 / (1 + lv + ll),
    pm = (d * vh) / (nv * (1 + lv)),
    f = dielectricFresnel(Math.min(1, vh), e);
  if (reflection)
    return { f: (d * g * f) / (4 * nv * nl), pdf: (pm * f) / (4 * vh) };
  const den = vh + e * lh;
  if (den === 0) return undefined;
  // Walter eq.17: |dh/dl| = eta^2*|LoH|/(VoH+eta*LoH)^2.
  const jac = (e * e * Math.abs(lh)) / (den * den);
  const transport = m.transport === "importance" ? 1 : 1 / (e * e);
  return {
    f: (((1 - f) * d * g * vh * jac) / (nv * Math.abs(nl))) * transport,
    pdf: pm * (1 - f) * jac,
  };
}
/** BSDF/BTDF f in sr^-1, no cosine. Delta distributions evaluate to zero. */
export function evaluateDielectric(
  normal: DielectricVec3,
  view: DielectricVec3,
  light: DielectricVec3,
  material: DielectricMaterial,
): DielectricVec3 {
  dielectricValidate(normal, view, material);
  dielectricVector(light, "light");
  const n = dielectricUnit(normal),
    v = dielectricUnit(view),
    l = dielectricUnit(light);
  const t = dielectricTerms(n, v, l, material);
  if (!t) return dielectricZero;
  const tint =
    dielectricDot(n, v) * dielectricDot(n, l) < 0
      ? (material.tint ?? dielectricWhite)
      : dielectricWhite;
  return dielectricScale(tint, t.f);
}
/** Full Fresnel-weighted solid-angle PDF. Includes null-event probability loss. */
export function dielectricPdfCPU(
  normal: DielectricVec3,
  view: DielectricVec3,
  light: DielectricVec3,
  material: DielectricMaterial,
): number {
  dielectricValidate(normal, view, material);
  dielectricVector(light, "light");
  return (
    dielectricTerms(
      dielectricUnit(normal),
      dielectricUnit(view),
      dielectricUnit(light),
      material,
    )?.pdf ?? 0
  );
}
function dielectricNull(): DielectricSample {
  return {
    direction: dielectricZero,
    weight: dielectricZero,
    pdf: 0,
    eta: 1,
    event: "null",
    delta: false,
  };
}
function dielectricVndf(
  n: DielectricVec3,
  v: DielectricVec3,
  a: number,
  u: number,
  w: number,
): DielectricVec3 {
  const t = dielectricUnit(
    dielectricCross(Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0], n),
  );
  const b = dielectricCross(n, t);
  const vh = dielectricUnit([
    a * dielectricDot(v, t),
    a * dielectricDot(v, b),
    dielectricDot(v, n),
  ]);
  const len = vh[0] * vh[0] + vh[1] * vh[1];
  const t1: DielectricVec3 =
    len > 0 ? [-vh[1] / Math.sqrt(len), vh[0] / Math.sqrt(len), 0] : [1, 0, 0];
  const t2 = dielectricCross(vh, t1);
  const r = Math.sqrt(u),
    phi = 2 * Math.PI * w,
    x = r * Math.cos(phi),
    s = (1 + vh[2]) * 0.5;
  const y = (1 - s) * Math.sqrt(Math.max(0, 1 - x * x)) + s * r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const nh = dielectricAdd(
    dielectricAdd(dielectricScale(t1, x), dielectricScale(t2, y)),
    dielectricScale(vh, z),
  );
  const h = dielectricUnit([a * nh[0], a * nh[1], Math.max(0, nh[2])]);
  return dielectricUnit(
    dielectricAdd(
      dielectricAdd(dielectricScale(t, h[0]), dielectricScale(b, h[1])),
      dielectricScale(n, h[2]),
    ),
  );
}
/** random=[Fresnel branch, VNDF disk radius squared, disk azimuth], each in [0,1). */
export function sampleDielectric(
  normal: DielectricVec3,
  view: DielectricVec3,
  material: DielectricMaterial,
  random: DielectricVec3,
): DielectricSample {
  dielectricValidate(normal, view, material);
  if (
    random.length !== 3 ||
    !random.every((x) => Number.isFinite(x) && x >= 0 && x < 1)
  )
    throw new RangeError("DIELECTRIC_INPUT: random must be in [0,1)^3");
  const v = dielectricUnit(view),
    o = dielectricOrient(dielectricUnit(normal), v, material),
    n = o.n,
    e = o.eta;
  const nv = dielectricDot(n, v);
  if (nv === 0) return dielectricNull();
  const delta = material.roughness === 0 || e === 1;
  const h = delta
    ? n
    : dielectricVndf(
        n,
        v,
        Math.max(DIELECTRIC_MIN_ALPHA, material.roughness ** 2),
        random[1],
        random[2],
      );
  const vh = Math.min(1, Math.max(0, dielectricDot(v, h))),
    f = dielectricFresnel(vh, e);
  const reflection = random[0] < f;
  let l: DielectricVec3;
  if (reflection)
    l = dielectricAdd(dielectricScale(v, -1), dielectricScale(h, 2 * vh));
  else {
    const sin2 = Math.max(0, 1 - vh * vh) / (e * e);
    if (sin2 >= 1) return dielectricNull();
    l = dielectricAdd(
      dielectricScale(v, -1 / e),
      dielectricScale(h, vh / e - Math.sqrt(1 - sin2)),
    );
  }
  l = dielectricUnit(l);
  const nl = dielectricDot(n, l);
  if (nl === 0 || (reflection ? nl < 0 : nl > 0)) return dielectricNull();
  const color = reflection
    ? dielectricWhite
    : (material.tint ?? dielectricWhite);
  const transport =
    reflection || material.transport === "importance" ? 1 : 1 / (e * e);
  if (delta)
    return {
      direction: l,
      weight: dielectricScale(color, transport),
      pdf: reflection ? f : 1 - f,
      eta: reflection ? 1 : e,
      event: reflection ? "reflection" : "transmission",
      delta: true,
    };
  const terms = dielectricTermsWithHalfVector(n, v, l, h, e, material);
  if (!terms || terms.pdf <= 0) return dielectricNull();
  return {
    direction: l,
    weight: dielectricScale(color, (terms.f * Math.abs(nl)) / terms.pdf),
    pdf: terms.pdf,
    eta: reflection ? 1 : e,
    event: reflection ? "reflection" : "transmission",
    delta: false,
  };
}
/** Separate homogeneous Beer attenuation: color is transmittance at attenuationDistance. */
export function dielectricBeerAttenuation(
  color: DielectricVec3,
  attenuationDistance: number,
  length: number,
): DielectricVec3 {
  dielectricColor(color);
  if (
    !Number.isFinite(attenuationDistance) ||
    attenuationDistance <= 0 ||
    !Number.isFinite(length) ||
    length < 0
  )
    throw new RangeError(
      "DIELECTRIC_INPUT: attenuationDistance must be positive and length nonnegative, both finite",
    );
  return length === 0
    ? dielectricWhite
    : (color.map((c) =>
        Math.pow(c, length / attenuationDistance),
      ) as unknown as DielectricVec3);
}

/** No bindings, entry points, dependencies, RNG, or integration into the main renderer. */
export const DIELECTRIC_SHADER = /* wgsl */ `
struct DielectricMaterial {
  etaOutside: f32,
  etaInside: f32,
  roughness: f32,
  transport: u32, // 0=radiance, 1=importance
  tint: vec3f,
}
struct DielectricSample {
  direction: vec3f,
  weight: vec3f,
  pdf: f32,
  eta: f32,
  event: u32, // 0=null, 1=reflection, 2=transmission
  delta: u32,
}
struct DielectricTerms { f: f32, pdf: f32 }
fn dielectricFresnel(c: f32, e: f32) -> f32 {
  if(e==1.0){return 0.0;}
  let s2=max(0.0,1.0-c*c)/(e*e);
  if(s2>=1.0){return 1.0;}
  let t=sqrt(1.0-s2);
  let rs=(c-e*t)/(c+e*t); let rp=(e*c-t)/(e*c+t);
  return 0.5*(rs*rs+rp*rp);
}
fn dielectricD(n: vec3f,h: vec3f,a: f32) -> f32 {
  let nh=dot(n,h); let s=cross(n,h); let d=dot(s,s)+a*a*nh*nh;
  if(nh<=0.0){return 0.0;}
  return a*a/(3.141592653589793*d*d);
}
fn dielectricLambda(c: f32,a: f32) -> f32 {
  return 0.5*(sqrt(1.0+a*a*max(0.0,1.0-c*c)/(c*c))-1.0);
}
fn dielectricTerms(normal: vec3f,v: vec3f,l: vec3f,m: DielectricMaterial) -> DielectricTerms {
  let outside=dot(normal,v)>=0.0;
  let n=select(-normal,normal,outside);
  let e=select(m.etaOutside/m.etaInside,m.etaInside/m.etaOutside,outside);
  let nv=dot(n,v); let nl=dot(n,l);
  if(nv==0.0||nl==0.0||m.roughness==0.0||e==1.0){return DielectricTerms(0.0,0.0);}
  let reflection=nl>0.0;
  var sum=v+select(e,1.0,reflection)*l;
  if(dot(sum,sum)==0.0){return DielectricTerms(0.0,0.0);}
  if(reflection && dot(v,l)<0.0){sum=cross(cross(v,l),v-l);}
  var h=normalize(sum); if(dot(n,h)<0.0){h=-h;}
  return dielectricTermsWithHalfVector(n,v,l,h,e,m);
}
fn dielectricTermsWithHalfVector(n: vec3f,v: vec3f,l: vec3f,h: vec3f,e: f32,m: DielectricMaterial) -> DielectricTerms {
  let nv=dot(n,v);let nl=dot(n,l);let reflection=nl>0.0;
  if(nv<=0.0||nl==0.0){return DielectricTerms(0.0,0.0);}
  let vh=dot(v,h); let lh=dot(l,h);
  if(vh<=0.0||lh*nl<=0.0){return DielectricTerms(0.0,0.0);}
  let a=max(0.0025,m.roughness*m.roughness);
  let d=dielectricD(n,h,a); let lv=dielectricLambda(nv,a); let ll=dielectricLambda(abs(nl),a);
  let g=1.0/(1.0+lv+ll); let pm=d*vh/(nv*(1.0+lv));
  let f=dielectricFresnel(min(1.0,vh),e);
  if(reflection){return DielectricTerms(d*g*f/(4.0*nv*nl),pm*f/(4.0*vh));}
  let den=vh+e*lh;
  if(den==0.0){return DielectricTerms(0.0,0.0);}
  let jac=e*e*abs(lh)/(den*den);
  let transport=select(1.0/(e*e),1.0,m.transport==1u);
  return DielectricTerms((1.0-f)*d*g*vh*jac/(nv*abs(nl))*transport,pm*(1.0-f)*jac);
}
// Validated finite, nonzero vectors and material inputs required (same CPU contract).
fn dielectricEvaluate(normal: vec3f,view: vec3f,light: vec3f,m: DielectricMaterial) -> vec3f {
  let n=normalize(normal);let v=normalize(view);let l=normalize(light);
  let color=select(vec3f(1.0),m.tint,dot(n,v)*dot(n,l)<0.0);
  return color*dielectricTerms(n,v,l,m).f;
}
fn dielectricPdf(normal: vec3f,view: vec3f,light: vec3f,m: DielectricMaterial) -> f32 {
  return dielectricTerms(normalize(normal),normalize(view),normalize(light),m).pdf;
}
fn dielectricNull() -> DielectricSample {
  return DielectricSample(vec3f(0.0),vec3f(0.0),0.0,1.0,0u,0u);
}
fn dielectricVndf(n: vec3f,v: vec3f,a: f32,u: f32,w: f32) -> vec3f {
  let axis=select(vec3f(1.0,0.0,0.0),vec3f(0.0,0.0,1.0),abs(n.z)<0.999);
  let t=normalize(cross(axis,n));let b=cross(n,t);
  let vh=normalize(vec3f(a*dot(v,t),a*dot(v,b),dot(v,n)));
  let lensq=vh.x*vh.x+vh.y*vh.y;
  var t1=vec3f(1.0,0.0,0.0);
  if(lensq>0.0){t1=vec3f(-vh.y,vh.x,0.0)/sqrt(lensq);}
  let t2=cross(vh,t1);let r=sqrt(u);let phi=6.283185307179586*w;
  let x=r*cos(phi);let s=0.5*(1.0+vh.z);
  let y=(1.0-s)*sqrt(max(0.0,1.0-x*x))+s*r*sin(phi);
  let z=sqrt(max(0.0,1.0-x*x-y*y));
  let nh=x*t1+y*t2+z*vh;
  let h=normalize(vec3f(a*nh.x,a*nh.y,max(0.0,nh.z)));
  return normalize(t*h.x+b*h.y+n*h.z);
}
fn dielectricSample(normal: vec3f,view: vec3f,m: DielectricMaterial,random: vec3f) -> DielectricSample {
  let v=normalize(view);let nn=normalize(normal);let outside=dot(nn,v)>=0.0;
  let n=select(-nn,nn,outside);
  let e=select(m.etaOutside/m.etaInside,m.etaInside/m.etaOutside,outside);
  let nv=dot(n,v);if(nv==0.0){return dielectricNull();}
  let delta=m.roughness==0.0||e==1.0;
  var h=n;
  if(!delta){h=dielectricVndf(n,v,max(0.0025,m.roughness*m.roughness),random.y,random.z);}
  let vh=clamp(dot(v,h),0.0,1.0);let f=dielectricFresnel(vh,e);
  let reflection=random.x<f;var l: vec3f;
  if(reflection){l=-v+2.0*vh*h;}
  else{
    let sin2=max(0.0,1.0-vh*vh)/(e*e);
    if(sin2>=1.0){return dielectricNull();}
    l=-v/e+(vh/e-sqrt(1.0-sin2))*h;
  }
  l=normalize(l);let nl=dot(n,l);
  if(nl==0.0||(reflection&&nl<0.0)||(!reflection&&nl>0.0)){return dielectricNull();}
  let color=select(m.tint,vec3f(1.0),reflection);
  let transport=select(1.0/(e*e),1.0,reflection||m.transport==1u);
  let event=select(2u,1u,reflection);let eta=select(e,1.0,reflection);
  if(delta){return DielectricSample(l,color*transport,select(1.0-f,f,reflection),eta,event,1u);}
  let terms=dielectricTermsWithHalfVector(n,v,l,h,e,m);
  if(terms.pdf<=0.0){return dielectricNull();}
  return DielectricSample(l,color*(terms.f*abs(nl)/terms.pdf),terms.pdf,eta,event,0u);
}
fn dielectricBeerAttenuation(color: vec3f,attenuationDistance: f32,length: f32) -> vec3f {
  if(length==0.0){return vec3f(1.0);}
  return pow(color,vec3f(length/attenuationDistance));
}
`;
