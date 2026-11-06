import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createEnvironmentCapture } from "../packages/renderer/src/environment.ts";

function fixture() {
  const input = new THREE.DataTexture(
    new Float32Array([4, 2, 0.5, 1, 0.25, 1, 3, 1]),
    1,
    2,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  input.mapping = THREE.EquirectangularReflectionMapping;
  input.colorSpace = THREE.LinearSRGBColorSpace;
  input.needsUpdate = true;
  return input;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fake() {
  let target: THREE.RenderTarget | null = new THREE.RenderTarget(16, 8),
    face = 3,
    mip = 2;
  let viewport = Object.assign(new THREE.Vector4(1, 2, 3, 4), {
    minDepth: 0.2,
    maxDepth: 0.8,
  });
  let scissor = new THREE.Vector4(2, 3, 4, 5),
    scissorTest = true;
  let mrt: unknown = { borrowed: true },
    renderObject: unknown = () => {};
  let targetDisposals = 0,
    materialDisposals = 0,
    renders = 0,
    readCalls = 0;
  let read: () => Promise<Float32Array> = async () =>
    new Float32Array([4, 2, 0.5, 1, 0.25, 1, 3, 1]);
  let renderFailure = false;
  const renderer = {
    backend: { isWebGPUBackend: true },
    hasInitialized: () => true,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 2.5,
    outputColorSpace: THREE.SRGBColorSpace,
    autoClear: true,
    autoClearColor: false,
    autoClearDepth: true,
    autoClearStencil: false,
    opaque: false,
    transparent: false,
    getRenderTarget: () => target,
    setRenderTarget: (value: THREE.RenderTarget | null, f = 0, m = 0) => {
      target = value;
      face = f;
      mip = m;
    },
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    getViewport: (value: THREE.Vector4) =>
      Object.assign(value.copy(viewport), {
        minDepth: viewport.minDepth,
        maxDepth: viewport.maxDepth,
      }),
    setViewport: (
      x: number,
      y: number,
      w: number,
      h: number,
      minDepth = 0,
      maxDepth = 1,
    ) => {
      viewport = Object.assign(new THREE.Vector4(x, y, w, h), {
        minDepth,
        maxDepth,
      });
    },
    getScissor: (value: THREE.Vector4) => value.copy(scissor),
    setScissor: (value: THREE.Vector4) => {
      scissor = value.clone();
    },
    getScissorTest: () => scissorTest,
    setScissorTest: (value: boolean) => {
      scissorTest = value;
    },
    getMRT: () => mrt,
    setMRT: (value: unknown) => {
      mrt = value;
    },
    getRenderObjectFunction: () => renderObject,
    setRenderObjectFunction: (value: unknown) => {
      renderObject = value;
    },
    render: (mesh: THREE.QuadMesh) => {
      renders++;
      assert.equal(renderer.toneMapping, THREE.NoToneMapping);
      assert.equal(renderer.toneMappingExposure, 1);
      assert.equal(renderer.outputColorSpace, THREE.LinearSRGBColorSpace);
      assert.equal(renderer.autoClear, false);
      assert.equal(renderer.opaque, true);
      assert.equal(mrt, null);
      assert.equal(renderObject, null);
      const material = mesh.material as THREE.NodeMaterial;
      assert.equal(material.toneMapped, false);
      assert.ok(material.fragmentNode);
      material.addEventListener("dispose", () => materialDisposals++);
      target!.addEventListener("dispose", () => targetDisposals++);
      if (renderFailure) throw Error("injected render failure");
    },
    readRenderTargetPixelsAsync: (value: THREE.RenderTarget) => {
      assert.equal(value, target);
      assert.equal(value.texture.type, THREE.FloatType);
      readCalls++;
      return read();
    },
  };
  const state = () => ({
    target,
    face,
    mip,
    viewport: [...viewport, viewport.minDepth, viewport.maxDepth],
    scissor: [...scissor],
    scissorTest,
    mrt,
    renderObject,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    colorSpace: renderer.outputColorSpace,
    flags: [
      renderer.autoClear,
      renderer.autoClearColor,
      renderer.autoClearDepth,
      renderer.autoClearStencil,
      renderer.opaque,
      renderer.transparent,
    ],
  });
  return {
    renderer: renderer as unknown as THREE.Renderer,
    raw: renderer,
    state,
    setRead: (value: typeof read) => {
      read = value;
    },
    failRender: () => {
      renderFailure = true;
    },
    counts: () => ({ targetDisposals, materialDisposals, renders, readCalls }),
  };
}
function listeners(input: THREE.Texture) {
  return (
    (input as unknown as { _listeners?: { dispose?: unknown[] } })._listeners
      ?.dispose ?? []
  ).length;
}

test("environment module imports without DOM/GPU; null and unsupported diagnostics are explicit", async () => {
  const f = fake(),
    capture = createEnvironmentCapture(f.renderer);
  assert.equal(await capture.capture(null), null);
  await assert.rejects(capture.capture(new THREE.Texture()), {
    code: "TC_ENVIRONMENT_UNSUPPORTED",
  });
  const legacy = fixture();
  legacy.mapping = 306 as THREE.Mapping;
  await assert.rejects(capture.capture(legacy), {
    code: "TC_ENVIRONMENT_UNSUPPORTED",
  });
  assert.equal(f.counts().renders, 0);
  assert.doesNotThrow(() => JSON.stringify(capture.inspect()));
  capture.dispose();
  assert.equal(await capture.capture(null), null);
  await assert.rejects(capture.capture(fixture()), {
    code: "TC_ENVIRONMENT_DISPOSED",
  });
});

test("environment capture restores complete state synchronously, caches GPU work and owns each result", async () => {
  const f = fake(),
    input = fixture(),
    capture = createEnvironmentCapture(f.renderer),
    before = f.state();
  const pending = capture.capture(input);
  assert.deepEqual(
    f.state(),
    before,
    "state restored before readback resolves",
  );
  const a = (await pending)!;
  assert.equal(a.sourceVersion, input.version);
  assert.equal(a.uuid, input.uuid);
  assert.deepEqual([a.width, a.height], [1, 2]);
  assert.equal(a.data[0], 4);
  a.data[0] = -99;
  const b = (await capture.capture(input))!;
  assert.equal(b.data[0], 4);
  assert.notEqual(a.data.buffer, b.data.buffer);
  assert.equal(f.counts().readCalls, 1);
  assert.equal(capture.inspect().resources.live, 0);
  assert.equal(listeners(input), 1);
  capture.clear();
  assert.equal(listeners(input), 0);
  assert.equal(capture.inspect().retainedBytes, 0);
  assert.deepEqual(f.counts(), {
    renders: 1,
    readCalls: 1,
    targetDisposals: 1,
    materialDisposals: 1,
  });
});

test("same-key concurrent requests share one GPU read but not returned arrays", async () => {
  const f = fake(),
    input = fixture(),
    capture = createEnvironmentCapture(f.renderer),
    d = deferred<Float32Array>();
  f.setRead(() => d.promise);
  const a = capture.capture(input),
    b = capture.capture(input);
  assert.equal(f.counts().readCalls, 1);
  assert.equal(capture.inspect().sharedPending, 1);
  const pixels = new Float32Array([4, 2, 1, 1, 3, 1, 2, 1]);
  d.resolve(pixels);
  const [first, second] = await Promise.all([a, b]);
  pixels.fill(0);
  first!.data.fill(100);
  assert.equal(second!.data[0], 4);
  assert.equal((await capture.capture(input))!.data[0], 4);
  capture.dispose();
});

test("texture, source and PMREM revisions invalidate cached data without mutating old results", async () => {
  const f = fake(),
    input = fixture(),
    capture = createEnvironmentCapture(f.renderer);
  const old = (await capture.capture(input))!;
  input.needsUpdate = true;
  f.setRead(async () => new Float32Array([8, 4, 1, 1, 0.5, 2, 6, 1]));
  const next = (await capture.capture(input))!;
  assert.equal(next.sourceVersion, input.version);
  assert.equal(next.data[0], 8);
  assert.equal(old.data[0], 4);
  input.source.needsUpdate = true;
  await capture.capture(input);
  input.pmremVersion++;
  await capture.capture(input);
  assert.equal(f.counts().readCalls, 4);
  capture.dispose();
});

test("clear cancels a whole batch, releases listeners/resources and ignores late success/failure", async () => {
  const f = fake(),
    capture = createEnvironmentCapture(f.renderer),
    a = fixture(),
    b = fixture();
  const first = deferred<Float32Array>(),
    second = deferred<Float32Array>();
  f.setRead(() => first.promise);
  const pa = assert.rejects(capture.capture(a), {
    code: "TC_ENVIRONMENT_CANCELLED",
  });
  f.setRead(() => second.promise);
  const pb = assert.rejects(capture.capture(b), {
    code: "TC_ENVIRONMENT_CANCELLED",
  });
  capture.clear();
  await Promise.all([pa, pb]);
  assert.equal(capture.inspect().resources.live, 0);
  assert.equal(listeners(a) + listeners(b), 0);
  f.setRead(async () => new Float32Array([9, 2, 1, 1, 3, 1, 2, 1]));
  await capture.capture(a);
  first.resolve(new Float32Array(8));
  second.reject(Error("late GPU failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.inspect().entries, 1);
  assert.equal((await capture.capture(a))!.data[0], 9);
  capture.dispose();
});

test("mutated in-flight texture rejects stale requests and permits a new revision", async () => {
  const f = fake(),
    input = fixture(),
    capture = createEnvironmentCapture(f.renderer),
    d = deferred<Float32Array>();
  f.setRead(() => d.promise);
  const stale = assert.rejects(capture.capture(input), {
    code: "TC_ENVIRONMENT_STALE",
  });
  input.needsUpdate = true;
  f.setRead(async () => new Float32Array([8, 2, 1, 1, 3, 1, 2, 1]));
  const next = (await capture.capture(input))!;
  await stale;
  d.reject(Error("old revision failed late"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.data[0], 8);
  assert.equal(capture.inspect().entries, 1);
  capture.dispose();
});

test("mutation during readback without a second request still rejects stale pixels", async () => {
  const f = fake(),
    input = fixture(),
    capture = createEnvironmentCapture(f.renderer),
    d = deferred<Float32Array>();
  f.setRead(() => d.promise);
  const pending = assert.rejects(capture.capture(input), {
    code: "TC_ENVIRONMENT_STALE",
  });
  input.needsUpdate = true;
  d.resolve(new Float32Array(8));
  await pending;
  assert.equal(capture.inspect().entries, 0);
  assert.equal(capture.inspect().resources.live, 0);
  capture.dispose();
});

test("dispose/source dispose cancel promptly, never dispose borrowed renderer/texture", async () => {
  for (const sourceDispose of [false, true]) {
    const f = fake(),
      input = fixture(),
      capture = createEnvironmentCapture(f.renderer),
      d = deferred<Float32Array>();
    let borrowedDisposals = 0;
    input.addEventListener("dispose", () => borrowedDisposals++);
    f.setRead(() => d.promise);
    const pending = assert.rejects(capture.capture(input), {
      code: sourceDispose
        ? "TC_ENVIRONMENT_SOURCE_DISPOSED"
        : "TC_ENVIRONMENT_CANCELLED",
    });
    if (sourceDispose) input.dispose();
    else capture.dispose();
    await pending;
    assert.equal(borrowedDisposals, sourceDispose ? 1 : 0);
    assert.equal(listeners(input), 1);
    assert.equal(capture.inspect().resources.live, 0);
    d.reject(Error("late device loss"));
    await new Promise((resolve) => setImmediate(resolve));
    capture.dispose();
  }
});

test("render/read failures restore state and free all resources without a fallback", async () => {
  for (const renderFailure of [false, true]) {
    const f = fake(),
      input = fixture(),
      capture = createEnvironmentCapture(f.renderer),
      before = f.state();
    if (renderFailure) f.failRender();
    else
      f.setRead(async () => {
        throw Error("injected read failure");
      });
    await assert.rejects(capture.capture(input), {
      code: "TC_ENVIRONMENT_READ_FAILED",
    });
    assert.deepEqual(f.state(), before);
    assert.equal(capture.inspect().resources.live, 0);
    assert.equal(capture.inspect().entries, 0);
    assert.equal(listeners(input), 0);
    capture.dispose();
  }
});

test("invalid readback, nonfinite HDR, dimensions and uninitialized backend are explicit failures", async () => {
  for (const [pixels, code] of [
    [new Float32Array(4), "TC_ENVIRONMENT_READ_LAYOUT"],
    [new Float32Array([NaN, 1, 1, 1, 1, 1, 1, 1]), "TC_ENVIRONMENT_NONFINITE"],
  ] as const) {
    const f = fake(),
      capture = createEnvironmentCapture(f.renderer);
    f.setRead(async () => pixels);
    await assert.rejects(capture.capture(fixture()), { code });
    assert.equal(capture.inspect().resources.live, 0);
    capture.dispose();
  }
  const f = fake(),
    capture = createEnvironmentCapture(f.renderer),
    invalid = fixture();
  invalid.image = { data: new Float32Array(), width: 0, height: 2 };
  await assert.rejects(capture.capture(invalid), {
    code: "TC_ENVIRONMENT_DIMENSIONS",
  });
  f.raw.hasInitialized = () => false;
  await assert.rejects(capture.capture(fixture()), {
    code: "TC_ENVIRONMENT_RENDERER",
  });
  capture.dispose();
});

// This module is served from memory. It exercises the real locked Three nodes,
// renderer, readback and RoomEnvironment; CPU fake tests are not image proof.
const browserModule = String.raw`
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from '/node_modules/three/examples/jsm/environments/RoomEnvironment.js';
import { createEnvironmentCapture } from '/packages/renderer/src/environment.ts';
globalThis.environmentProbe = async () => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const adapter = await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
  check(adapter && !adapter.info.isFallbackAdapter, 'TC_ENVIRONMENT_HARDWARE_REQUIRED');
  check(!/swiftshader|llvmpipe|software|warp/i.test(adapter.info.description), 'Software adapters are not evidence');
  const device = await adapter.requestDevice({requiredFeatures:[...adapter.features]});
  let renderer, capture, generator, room, pmrem, sentinel, input, cube, half, srgb;
  const gpuErrors = [];
  const uncaptured = event => gpuErrors.push(event.error.message);
  device.addEventListener('uncapturederror', uncaptured);
  device.pushErrorScope('validation');
  let scopeOpen = true;
  try {
    renderer = new THREE.WebGPURenderer({device, antialias:false});
    renderer.onError = error => gpuErrors.push(error.message);
    await renderer.init();
    renderer.setSize(64,64);
    check(renderer.backend.isWebGPUBackend, 'WebGL fallback forbidden');
    generator = new THREE.PMREMGenerator(renderer);
    room = new RoomEnvironment();
    pmrem = generator.fromScene(room,0.04);
    check(pmrem.texture.isCubeTexture, 'Locked r187 PMREM must be a CubeTexture');
    capture = createEnvironmentCapture(renderer);
    const rawRead = renderer.readRenderTargetPixelsAsync.bind(renderer);
    let reads = 0, targetDisposals = 0, materialDisposals = 0, borrowedDisposals = 0;
    renderer.readRenderTargetPixelsAsync = (...args) => {
      reads++;
      args[0].addEventListener('dispose', () => targetDisposals++);
      return rawRead(...args);
    };
    const rawRender = renderer.render.bind(renderer);
    renderer.render = (object, camera) => {
      if(object.isQuadMesh) object.material.addEventListener('dispose', () => materialDisposals++);
      return rawRender(object,camera);
    };
    sentinel = new THREE.RenderTarget(16,16);
    renderer.setRenderTarget(sentinel);
    renderer.setViewport(1,2,7,8,0.2,0.8);
    renderer.setScissor(2,3,5,6);
    renderer.setScissorTest(true);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 7;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = false;
    renderer.opaque = false;
    renderer.transparent = false;
    const hook = () => {};
    renderer.setRenderObjectFunction(hook);
    const state = () => {
      const viewport = renderer.getViewport(new THREE.Vector4());
      return JSON.stringify({target:renderer.getRenderTarget()?.uuid, sentinel:renderer.getRenderTarget() === sentinel, face:renderer.getActiveCubeFace(), mip:renderer.getActiveMipmapLevel(), viewport:[...viewport,viewport.minDepth,viewport.maxDepth], scissor:[...renderer.getScissor(new THREE.Vector4())], scissorTest:renderer.getScissorTest(), toneMapping:renderer.toneMapping, exposure:renderer.toneMappingExposure, colorSpace:renderer.outputColorSpace, flags:[renderer.autoClear,renderer.autoClearColor,renderer.autoClearDepth,renderer.autoClearStencil,renderer.opaque,renderer.transparent], hook:renderer.getRenderObjectFunction() === hook});
    };
    const before = state();
    const pending = capture.capture(pmrem.texture);
    check(state() === before, 'Renderer state changed while awaiting GPU');
    const environment = await pending;
    check(state() === before, 'Renderer state changed after readback');
    let min = Infinity, max = -Infinity, sum = 0;
    for(let i=0;i<environment.data.length;i+=4) {
      for(let c=0;c<3;c++) { const v = environment.data[i+c]; check(Number.isFinite(v),'Nonfinite RoomEnvironment'); min = Math.min(min,v); max = Math.max(max,v); sum += v; }
      check(environment.data[i+3] === 1,'Radiance alpha');
    }
    check(max > 1 && max-min > 1, 'RoomEnvironment must be nonconstant HDR');
    const pmremStats = {width:environment.width,height:environment.height,min,max,mean:sum/(environment.width*environment.height*3)};
    const repeat = await capture.capture(pmrem.texture);
    check(reads === 1 && repeat.data !== environment.data, 'PMREM cache must reuse readback and copy output');
    const values = new Float32Array([
      0.125,0.25,3,1, 0.25,0.5,6,1, 0.375,0.75,9,1, 0.5,1,12,1,
      4,0.5,0.25,1, 8,1,0.5,1, 12,1.5,0.75,1, 16,2,1,1,
    ]);
    input = new THREE.DataTexture(values,4,2,THREE.RGBAFormat,THREE.FloatType);
    input.mapping = THREE.EquirectangularReflectionMapping;
    input.colorSpace = THREE.LinearSRGBColorSpace;
    input.magFilter = input.minFilter = THREE.NearestFilter;
    input.offset.set(0.2,0.4); input.repeat.set(3,2); input.rotation = 0.7;
    input.needsUpdate = true;
    input.addEventListener('dispose', () => borrowedDisposals++);
    pmrem.texture.addEventListener('dispose', () => borrowedDisposals++);
    const [known, shared] = await Promise.all([capture.capture(input),capture.capture(input)]);
    check(reads === 2 && known.data !== shared.data, 'Concurrent capture must share one GPU read');
    let coordinateMaxError = 0, scaleMaxError = 0;
    for(let y=0;y<2;y++) for(let x=0;x<4;x++) for(let c=0;c<4;c++) {
      const actual = known.data[(y*4+x)*4+c], expected = values[((1-y)*4+x)*4+c];
      coordinateMaxError = Math.max(coordinateMaxError,Math.abs(actual-expected));
    }
    check(coordinateMaxError < 0.0001,'North/south or longitude coordinates wrong: '+coordinateMaxError+' '+Array.from(known.data));
    for(let i=0;i<values.length;i++) if(i%4 !== 3) values[i]*=2;
    input.needsUpdate = true;
    const doubled = await capture.capture(input);
    for(let i=0;i<doubled.data.length;i++) scaleMaxError = Math.max(scaleMaxError,Math.abs(doubled.data[i]-known.data[i]*(i%4===3?1:2)));
    check(scaleMaxError < 0.0001 && known.data[0] === 4,'HDR 2x/immutable old result failed');
    const saved = doubled.data.slice();
    doubled.data.fill(-1);
    const owned = await capture.capture(input);
    check(owned.data.every((v,i) => v===saved[i]) && reads === 3,'Cache was mutated by caller');
    input.flipY = true; input.needsUpdate = true;
    const flipped = await capture.capture(input);
    check(flipped.data[0] === 0.25 && flipped.data[2] === 6,'DataTexture flipY not sampled as raster');
    const colors = [[2,0,0,1],[0,3,0,1],[0,0,4,1],[5,5,0,1],[6,0,6,1],[0,7,7,1]];
    cube = new THREE.CubeTexture(colors.map(color => new THREE.DataTexture(new Float32Array(Array.from({length:16},()=>color).flat()),4,4,THREE.RGBAFormat,THREE.FloatType)));
    cube.type = THREE.FloatType; cube.colorSpace = THREE.LinearSRGBColorSpace; cube.needsUpdate = true;
    const cubeResult = await capture.capture(cube);
    check(cubeResult.data.every(Number.isFinite),'Cube nonfinite');
    // Six unique constant faces must survive real cube sampling (not an average).
    for(const color of colors) check(Array.from({length:cubeResult.width*cubeResult.height},(_,i)=>i).some(i=>color.slice(0,3).every((v,c)=>Math.abs(cubeResult.data[i*4+c]-v)<0.001)),'Cube face missing '+color);
    const cubeNorth = Array.from(cubeResult.data.slice(0,4));
    const cubeSouth = Array.from(cubeResult.data.slice((cubeResult.height-1)*cubeResult.width*4,(cubeResult.height-1)*cubeResult.width*4+4));
    check(cubeNorth.every((v,i)=>v===colors[2][i]) && cubeSouth.every((v,i)=>v===colors[3][i]),'Cube north/south orientation');
    half = new THREE.DataTexture(new Uint16Array([8,0.5,0.25,1].map(THREE.DataUtils.toHalfFloat)),1,1,THREE.RGBAFormat,THREE.HalfFloatType);
    half.mapping = THREE.EquirectangularReflectionMapping; half.needsUpdate = true;
    const halfResult = await capture.capture(half);
    check(halfResult.data.every((v,i)=>v===[8,0.5,0.25,1][i]),'Half float HDR was not preserved');
    srgb = new THREE.DataTexture(new Uint8Array([128,64,255,255]),1,1);
    srgb.mapping = THREE.EquirectangularReflectionMapping; srgb.colorSpace = THREE.SRGBColorSpace; srgb.needsUpdate = true;
    const srgbResult = await capture.capture(srgb);
    const expectedLinear = [128,64,255].map(v => v/255 <= 0.04045 ? v/255/12.92 : ((v/255+0.055)/1.055)**2.4);
    const srgbMaxError = Math.max(...expectedLinear.map((v,i)=>Math.abs(v-srgbResult.data[i])));
    check(srgbMaxError<0.001,'sRGB must decode to linear exactly once');
    check(state() === before, 'Renderer state changed during data/cube capture');
    const inspectBeforeDispose = capture.inspect();
    const north = Array.from(known.data.slice(0,4)), south = Array.from(known.data.slice(16,20));
    const listenerCount = texture => texture._listeners?.dispose?.length ?? 0;
    const sourceListeners = [input,pmrem.texture,cube,half,srgb].map(listenerCount);
    capture.dispose();
    const final = capture.inspect();
    check(final.entries===0 && final.listeners===0 && final.resources.live===0,'Capture leaked owned resources/listeners');
    check(targetDisposals===reads && materialDisposals===reads && borrowedDisposals===0,'Incorrect resource ownership');
    check([input,pmrem.texture,cube,half,srgb].every((texture,i)=>listenerCount(texture)===sourceListeners[i]-1),'Provider dispose listeners retained on borrowed sources');
    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope(); scopeOpen = false;
    check(!validation,validation?.message);
    check(gpuErrors.length===0,JSON.stringify(gpuErrors));
    return {adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},revision:THREE.REVISION,pmrem:pmremStats,north,south,cubeNorth,cubeSouth,half:Array.from(halfResult.data),coordinateMaxError,scaleMaxError,srgbMaxError,gpuReads:reads,targetDisposals,materialDisposals,borrowedDisposals,inspectBeforeDispose,final,validation:null,gpuErrors};
  } finally {
    if(scopeOpen) await device.popErrorScope().catch(()=>{});
    capture?.dispose(); renderer?.setRenderTarget(null); renderer?.setRenderObjectFunction(null);
    input?.dispose(); cube?.dispose(); half?.dispose(); srgb?.dispose(); pmrem?.dispose(); generator?.dispose(); room?.dispose(); sentinel?.dispose();
    renderer?.dispose(); device.removeEventListener('uncapturederror',uncaptured); device.destroy();
  }
};
`;

test(
  "environment real hardware WebGPU RoomEnvironment/HDR/UV/cache/state/ownership",
  { skip: process.env.PELICAN_ENVIRONMENT_GPU !== "1", timeout: 120_000 },
  async (context) => {
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright");
    const { automationLaunchOptions, withAutomationDeadline } = await import(
      "../tools/browser-session.ts"
    );
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "environment-in-memory-probe",
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== "/") return next();
              response.setHeader("content-type", "text/html; charset=utf-8");
              response.end(
                '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Environment GPU numeric probe</title><script type="module" src="/environment-probe.js"></script>',
              );
            });
          },
          resolveId(id) {
            if (id === "/environment-probe.js") return "\0environment-probe.js";
          },
          load(id) {
            if (id === "\0environment-probe.js") return browserModule;
          },
        },
      ],
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch(automationLaunchOptions());
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await withAutomationDeadline(
        async () => {
          await page.goto("http://127.0.0.1:" + address.port);
          await page.waitForFunction(
            () =>
              typeof (globalThis as unknown as { environmentProbe?: unknown })
                .environmentProbe === "function",
            undefined,
            { timeout: 30_000, polling: 100 },
          );
          const report = await page.evaluate(() =>
            (
              globalThis as unknown as {
                environmentProbe: () => Promise<unknown>;
              }
            ).environmentProbe(),
          );
          assert.deepEqual(errors, []);
          context.diagnostic(JSON.stringify(report));
        },
        90_000,
        "Environment hardware capture",
      );
    } finally {
      try {
        await browser?.close();
      } finally {
        await server.close();
      }
    }
  },
);
