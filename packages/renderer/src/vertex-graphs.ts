import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import type { GraphIR } from "../../compiler/src/types.ts";
import type { GraphValue, Vec3 } from "../../sdk/src/index.ts";
import { sampleManagedTexture } from "./managed-texture-sampling.ts";
import { evaluateTypedGraph } from "./graph-expressions.ts";
import { typedGraphToTSL } from "./graph-tsl.ts";
import type {
  MaterialGraphBinding,
  MaterialGraphBindings,
} from "./material-graphs.ts";
import type {
  SurfaceVertexDeformer,
  VertexEvaluationInput,
  VertexEvaluationResult,
  VertexTextureSampler,
} from "./vertex-contract.ts";

const fail = (message: string): never => {
  throw new Error(
    "TC_VERTEX_GRAPH: " +
      message +
      " Repair: Use finite vec3 vertex graphs, available attributes and declared texture/parameter bindings.",
  );
};
const vec = (value: GraphValue, label: string): Vec3 => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => !Number.isFinite(Math.fround(component)))
  )
    return fail(label + " must produce a finite f32 vec3.");
  return value.map(Math.fround) as unknown as Vec3;
};
const normalized = (value: Vec3, fallback: Vec3): Vec3 => {
  const scale = Math.max(...value.map(Math.abs));
  if (!scale) return [...fallback] as Vec3;
  const scaled = value.map((component) => component / scale),
    length = Math.hypot(...scaled);
  return scaled.map((component) =>
    Math.fround(component / length),
  ) as unknown as Vec3;
};

export function evaluateVertexGraphs(
  binding: MaterialGraphBinding,
  input: VertexEvaluationInput,
  sampleTexture: VertexTextureSampler,
): VertexEvaluationResult {
  if (!binding.vertex) return { position: input.positionLocal };
  const position = vec(input.positionLocal, "positionLocal");
  const normal = normalized(vec(input.normalLocal, "normalLocal"), [0, 0, 0]);
  const evaluate = (graph: GraphIR, channel: string): Vec3 => {
    try {
      return vec(
        evaluateTypedGraph(graph, {
          precision: "f32",
          time: binding.time,
          parameters: binding.parameters,
          inputs: {
            positionLocal: position,
            normalLocal: normal,
            vertexIndex: input.vertexIndex,
            instanceIndex: input.instanceIndex,
            ...(input.uv ? { uv: input.uv } : {}),
            ...(input.uv1 ? { uv1: input.uv1 } : {}),
          },
          sampleTexture: (name, uv) => {
            const sampler =
              graph.textureSlots && Object.hasOwn(graph.textureSlots, name)
                ? graph.textureSlots[name]
                : undefined;
            if (!sampler) return sampleTexture(name, uv);
            const resource =
              binding.managedTextures &&
              Object.hasOwn(binding.managedTextures, name)
                ? binding.managedTextures[name]
                : undefined;
            if (!resource)
              throw new Error(
                "TC_RENDER_TEXTURE_UNBOUND: " + binding.id + ":" + name,
              );
            return sampleManagedTexture(resource, uv, sampler);
          },
          readBuffer: (name, index) => {
            const resource = binding.buffers?.[name];
            if (!resource)
              throw new Error(
                "TC_RENDER_BUFFER_UNBOUND: " + binding.id + ":" + name,
              );
            if (
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= resource.values.length
            )
              throw new Error(
                "TC_RENDER_BUFFER_BOUNDS: " +
                  binding.id +
                  ":" +
                  name +
                  ":" +
                  index,
              );
            return resource.values[index];
          },
        }),
        channel,
      );
    } catch (error) {
      return fail(
        binding.id +
          ":" +
          channel +
          ":vertex=" +
          input.vertexIndex +
          ":instance=" +
          input.instanceIndex +
          ": " +
          String(error),
      );
    }
  };
  const result = binding.vertex.position
    ? evaluate(binding.vertex.position, "position")
    : position;
  return {
    position: result,
    ...(binding.vertex.normal
      ? {
          normal: normalized(evaluate(binding.vertex.normal, "normal"), normal),
        }
      : {}),
  };
}

/** Engine-private bridge shared by surface capture and object bounds. */
export function createVertexDeformer(
  bindings: MaterialGraphBindings,
  sampler: (
    binding: MaterialGraphBinding,
    asset: string,
    uv: readonly [number, number],
  ) => readonly [number, number, number, number],
): SurfaceVertexDeformer {
  const byUuid = new Map(
    [...bindings].map(([material, binding]) => [material.uuid, binding]),
  );
  return {
    evaluate(mesh, materialUuid, input) {
      const binding = byUuid.get(materialUuid);
      if (!binding?.vertex) return undefined;
      if (
        !mesh.geometry.hasAttribute("normal") &&
        Object.values(binding.vertex).some((graph) =>
          graph.requiredInputs?.includes("normalLocal"),
        )
      )
        throw new Error(
          "TC_VERTEX_NORMAL_ATTRIBUTE: The normalLocal vertex input requires a normal attribute.",
        );
      return evaluateVertexGraphs(binding, input, (asset, uv) =>
        sampler(binding, asset, uv),
      );
    },
    signature(mesh) {
      const values: unknown[] = [];
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        const binding = byUuid.get(material.uuid);
        if (!binding?.vertex) continue;
        const graphs = Object.values(binding.vertex);
        values.push(material.uuid, JSON.stringify(binding.vertex));
        for (const name of [
          ...new Set(
            graphs.flatMap((graph) => Object.keys(graph.bufferTypes ?? {})),
          ),
        ].sort()) {
          const resource =
            binding.buffers?.[name] ??
            fail(binding.id + ": missing buffer " + name);
          values.push(
            name,
            resource.key,
            resource.type,
            resource.revision,
            resource.values.length,
          );
        }
        if (
          graphs.some((graph) => graph.nodes.some((node) => node.op === "time"))
        )
          values.push(Math.fround(binding.time));
        const names = [
          ...new Set(
            graphs.flatMap((graph) =>
              (graph.parameters ?? []).map((parameter) => parameter.name),
            ),
          ),
        ].sort();
        for (const name of names)
          values.push(name, JSON.stringify(binding.parameters[name]));
        const managedNames = new Set(
          graphs.flatMap((graph) => Object.keys(graph.textureSlots ?? {})),
        );
        for (const name of [...managedNames].sort()) {
          const resource =
            binding.managedTextures &&
            Object.hasOwn(binding.managedTextures, name)
              ? binding.managedTextures[name]
              : undefined;
          if (!resource?.texture || resource.type !== "vec4")
            return fail(binding.id + ": missing managed texture " + name);
          values.push(
            name,
            resource.key,
            resource.revision,
            resource.texture.width,
            resource.texture.height,
            resource.values.length,
          );
          for (const graph of graphs) {
            const sampler = graph.textureSlots?.[name];
            if (sampler)
              values.push(
                sampler.filter ?? "linear",
                sampler.wrapU ?? "clamp",
                sampler.wrapV ?? "clamp",
              );
          }
        }
        const textures = [
          ...new Set(
            graphs.flatMap((graph) =>
              (graph.textureIds ?? []).filter(
                (name) => !Object.hasOwn(graph.textureSlots ?? {}, name),
              ),
            ),
          ),
        ].sort();
        for (const asset of textures) {
          const texture =
            binding.textures.get(asset) ??
            fail(binding.id + ": missing texture " + asset);
          if (texture.matrixAutoUpdate) texture.updateMatrix();
          values.push(
            asset,
            texture.uuid,
            texture.version,
            texture.source.uuid,
            texture.source.version,
            texture.image,
            texture.flipY,
            texture.colorSpace,
            texture.wrapS,
            texture.wrapT,
            texture.magFilter,
            texture.minFilter,
            ...texture.matrix.elements,
          );
        }
      }
      return values;
    },
  };
}

/** Position node runs after Three's built-in morph/skin/instance stages. */
export function vertexGraphsToTSL(
  binding: MaterialGraphBinding,
  time: any,
  parameters: ReadonlyMap<string, any>,
  textures: ReadonlyMap<string, THREE.Texture>,
  readBuffer?: (
    name: string,
    index: any,
    type: import("../../sdk/src/index.ts").GraphType,
  ) => any,
  sampleTextureSlot?: (name: string, uv: any) => any,
) {
  if (!binding.vertex) return null;
  const safeNormal = (value: any, fallback: any) => {
    const scale = TSL.max(
      TSL.max(TSL.abs(value.x), TSL.abs(value.y)),
      TSL.abs(value.z),
    );
    const scaled = value.div(TSL.select(scale.equal(0), 1, scale));
    const length = scaled.length();
    return TSL.select(
      length.equal(0),
      fallback,
      scaled.div(TSL.select(length.equal(0), 1, length)),
    );
  };
  return TSL.Fn(() => {
    const position = TSL.positionLocal.toVar();
    const normal = safeNormal(TSL.normalLocal, TSL.vec3(0)).toVar();
    const context = {
      inputs: {
        positionLocal: position,
        normalLocal: normal,
        vertexIndex: TSL.float(TSL.vertexIndex),
        instanceIndex: TSL.float(TSL.instanceIndex),
      },
      readBuffer,
      sampleTextureSlot,
    };
    const output = (
      binding.vertex!.position
        ? typedGraphToTSL(
            binding.vertex!.position,
            time,
            parameters,
            textures,
            context,
          )
        : position
    ).toVar();
    if (binding.vertex!.normal) {
      const changed = typedGraphToTSL(
        binding.vertex!.normal,
        time,
        parameters,
        textures,
        context,
      );
      TSL.normalLocal.assign(safeNormal(changed, normal));
    }
    return output;
  })();
}
