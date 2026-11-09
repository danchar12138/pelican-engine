import * as THREE from "three/webgpu";
import {
  pass,
  mrt,
  normalView,
  builtinAOContext,
  convertToTexture,
  screenUV,
} from "three/tsl";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
/** Full-resolution indirect-light occlusion; direct lights/specular are not multiplied by a dark overlay. */
export function createRasterPresentation(
  renderer: THREE.Renderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const normals = pass(scene, camera);
  normals.setMRT(mrt({ output: normalView }));
  const depth = normals.getTextureNode("depth"),
    normal = normals.getTextureNode();
  const occlusion = ao(depth, normal, camera);
  occlusion.resolutionScale = 1;
  occlusion.samples.value = 32;
  occlusion.radius.value = 0.25;
  // Fixed spatial samples avoid temporal noise/ghosting in paused captures and fast camera motion.
  occlusion.useTemporalFiltering = false;
  const filtered = denoise(occlusion.getTextureNode(), depth, normal, camera);
  filtered.radius.value = 4;
  const filteredTexture = convertToTexture(
    filtered as unknown as THREE.Node<"vec4">,
  );
  const shaded = pass(scene, camera);
  shaded.contextNode = builtinAOContext(filteredTexture.sample(screenUV).r);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = shaded;
  let disposed = false,
    frames = 0;
  return {
    render() {
      if (disposed)
        throw new Error(
          "TC_RASTER_DISPOSED: Recreate presentation after owner teardown.",
        );
      pipeline.render();
      frames++;
    },
    inspect() {
      return {
        kind: "full-resolution-gtao",
        samples: 32,
        radius: 0.25,
        temporal: false,
        denoise: "depth-normal-aware",
        frames,
        resolutionScale: 1,
        scope:
          "Screen-space indirect occlusion only; no offscreen GI or hardware ray tracing",
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pipeline.dispose();
      shaded.dispose();
      filteredTexture.dispose();
      filtered.dispose();
      occlusion.dispose();
      normals.dispose();
    },
  };
}
