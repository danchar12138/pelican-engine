import * as THREE from "three/webgpu";
import {
  extractSurfaceScene,
  createSurfaceTextureCache,
  createSurfaceMeshCache,
  sampleSurfaceTexture,
  type SurfaceDiagnostic,
  type SurfaceTexture,
} from "./surface.ts";
import { createTexturePixelProvider } from "./texture-pixels.ts";
import type { MaterialGraphBindings } from "./material-graphs.ts";
import { createVertexDeformer } from "./vertex-graphs.ts";

/** One owner per rendered content generation; no mutations to borrowed scene/materials. */
export function createSurfaceCapture() {
  const pixels = createTexturePixelProvider(),
    textureCache = createSurfaceTextureCache(),
    meshCache = createSurfaceMeshCache(),
    adapters = new Map<
      THREE.Material,
      THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial
    >();
  let disposed = false;
  const adapter = (
    material: THREE.Material,
    knownColorGraphs: ReadonlySet<THREE.Material>,
    graphs?: MaterialGraphBindings,
  ) => {
    const candidate = material as THREE.MeshStandardNodeMaterial;
    if (!candidate.isNodeMaterial) return undefined;
    const physical =
      (candidate as THREE.MeshPhysicalNodeMaterial)
        .isMeshPhysicalNodeMaterial === true;
    if (
      (!candidate.isMeshStandardNodeMaterial ||
        candidate.type !== "MeshStandardNodeMaterial") &&
      (!physical || candidate.type !== "MeshPhysicalNodeMaterial")
    )
      throw new Error(
        "TC_TRACE_MATERIAL: Node material requires an explicit engine surface adapter.",
      );
    for (const [key, value] of Object.entries(candidate))
      if (
        key.endsWith("Node") &&
        value &&
        typeof value === "object" &&
        (value as { isNode?: boolean }).isNode
      ) {
        const binding = graphs?.get(material);
        const supported =
          binding &&
          (
            {
              colorNode: "baseColor",
              emissiveNode: "emissive",
              roughnessNode: "roughness",
              metalnessNode: "metalness",
              opacityNode: "opacity",
              normalNode: "normalWorld",
            } as const
          )[key as "colorNode"];
        if (
          !(supported && binding!.graphs[supported]) &&
          !(key === "positionNode" && binding?.vertex) &&
          (key !== "colorNode" || !knownColorGraphs.has(material))
        )
          throw new Error(
            "TC_TRACE_NODE_GRAPH: Unsupported node override " + key,
          );
      }
    let copy = adapters.get(material);
    if (!copy) {
      copy = physical
        ? new THREE.MeshPhysicalMaterial()
        : new THREE.MeshStandardMaterial();
      adapters.set(material, copy);
    }
    if (copy instanceof THREE.MeshPhysicalMaterial)
      copy.copy(candidate as unknown as THREE.MeshPhysicalMaterial);
    else copy.copy(candidate as unknown as THREE.MeshStandardMaterial);
    // colorNode replaces materialColor; opacityNode replaces materialOpacity.
    if (candidate.colorNode) copy.map = null;
    if (graphs?.get(material)?.graphs.opacity) {
      copy.transparent = true;
      copy.opacity = 1;
      copy.alphaMap = null;
    }
    return copy;
  };
  return {
    capture(
      scene: THREE.Scene,
      knownColorGraphs: ReadonlySet<THREE.Material> = new Set(),
      graphs?: MaterialGraphBindings,
      options: { geometryOnly?: boolean } = {},
    ) {
      if (disposed) throw new Error("TC_TRACE_CAPTURE_DISPOSED");
      scene.updateMatrixWorld(true);
      const vertexDiagnostics: SurfaceDiagnostic[] = [];
      const vertexTextures = new Map<THREE.Texture, SurfaceTexture>();
      const hasVertex = graphs && [...graphs.values()].some(binding => binding.vertex);
      const vertexDeformer = hasVertex ? createVertexDeformer(graphs!, (binding, asset, uv) => {
        const texture = binding.textures.get(asset);
        if (!texture) throw new Error("TC_VERTEX_TEXTURE: " + binding.id + ":" + asset);
        let snapshot = vertexTextures.get(texture);
        if (!snapshot) {
          snapshot = textureCache.getSnapshot(texture, pixels.decode, vertexDiagnostics);
          vertexTextures.set(texture, snapshot);
        }
        return sampleSurfaceTexture(snapshot, uv);
      }) : undefined;
      let snapshot = extractSurfaceScene(scene, {
        textureCache,
        meshCache,
        decodedTextureProvider: pixels.decode,
        materialAdapter: (material) =>
          adapter(material, knownColorGraphs, graphs),
        ...(vertexDeformer ? { vertexDeformer } : {}),
        ...(options.geometryOnly ? { meshFilter: (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(material => graphs?.get(material)?.vertex) } : {}),
      });
      if (graphs?.size) {
        const byUuid = new Map(
          [...graphs].map(([material, binding]) => [material.uuid, binding]),
        );
        for (const triangle of snapshot.triangles) {
          const binding = byUuid.get(triangle.materialUuid);
          if (!binding) continue;
          for (const graph of [...Object.values(binding.graphs), ...Object.values(binding.vertex ?? {})])
            for (const input of graph.requiredInputs ?? []) {
              const attribute =
                input === "uv" ? "uv0" : input === "uv1" ? "uv1" : undefined;
              if (
                attribute &&
                triangle.vertices.some((vertex) => !vertex[attribute])
              )
                throw Error(
                  "TC_GRAPH_UV: Material " +
                    binding.id +
                    " requires " +
                    input +
                    " on object " +
                    triangle.objectUuid +
                    " geometry " +
                    triangle.geometryUuid,
                );
            }
        }
        const diagnostics = [...snapshot.diagnostics, ...vertexDiagnostics],
          textures = [...snapshot.textures];
        const present = new Set(textures.map((texture) => texture.uuid));
        for (const binding of graphs.values())
          for (const graph of [...Object.values(binding.graphs), ...Object.values(binding.vertex ?? {})])
            for (const id of graph.textureIds ?? []) {
              if (Object.hasOwn(graph.textureSlots ?? {}, id)) continue;
              const texture = binding.textures.get(id);
              if (!texture)
                throw Error("TC_GRAPH_TEXTURE: " + binding.id + ":" + id);
              if (present.has(texture.uuid)) continue;
              textures.push(
                textureCache.getSnapshot(texture, pixels.decode, diagnostics),
              );
              present.add(texture.uuid);
            }
        snapshot = Object.freeze({
          ...snapshot,
          textures: Object.freeze(textures),
          diagnostics: Object.freeze(diagnostics),
        });
      }
      const lights: number[] = [];
      const identities: string[] = [];
      scene.traverseVisible((object) => {
        if (options.geometryOnly) return;
        if (!(object instanceof THREE.Light)) return;
        const color = object.color.clone().multiplyScalar(object.intensity),
          position = object.getWorldPosition(new THREE.Vector3());
        if (object instanceof THREE.PointLight) {
          lights.push(
            ...position.toArray(),
            0,
            ...color.toArray(),
            object.distance,
            0,
            0,
            0,
            object.decay,
          );
        } else if (object instanceof THREE.DirectionalLight) {
          object.target.updateWorldMatrix(true, false);
          const direction = position
            .sub(object.target.getWorldPosition(new THREE.Vector3()))
            .normalize();
          lights.push(
            ...direction.toArray(),
            1,
            ...color.toArray(),
            0,
            0,
            0,
            0,
            0,
          );
        } else if (object instanceof THREE.HemisphereLight) {
          const direction = position.normalize(),
            ground = object.groundColor
              .clone()
              .multiplyScalar(object.intensity);
          lights.push(
            ...direction.toArray(),
            2,
            ...color.toArray(),
            0,
            ...ground.toArray(),
            0,
          );
        } else if (object instanceof THREE.AmbientLight) {
          lights.push(0, 1, 0, 3, ...color.toArray(), 0, 0, 0, 0, 0);
        } else
          throw new Error(
            "TC_TRACE_LIGHT: Unsupported light type " + object.type,
          );
        identities.push(object.uuid);
      });
      return {
        surface: snapshot,
        lights: new Float32Array(lights),
        lightIds: identities,
        environment:
          scene.background instanceof THREE.Color
            ? scene.background.toArray()
            : [0, 0, 0],
        environmentTexture: scene.environment?.uuid ?? null,
      };
    },
    inspect() {
      return {
        disposed,
        adaptedMaterials: adapters.size,
        pixels: pixels.inspect(),
        textures: textureCache.inspect(),
        meshes: meshCache.inspect(),
      };
    },
    clear() {
      for (const material of adapters.values()) material.dispose();
      adapters.clear();
      pixels.clear();
      textureCache.clear();
      meshCache.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of adapters.values()) material.dispose();
      adapters.clear();
      pixels.dispose();
      textureCache.dispose();
      meshCache.dispose();
    },
  };
}
