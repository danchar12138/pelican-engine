import type * as THREE from "three/webgpu";
import type { GraphIR } from "../../compiler/src/types.ts";
import type {
  ComputeTextureBinding,
  ComputeTextureSize,
  GraphType,
  GraphValue,
  MaterialGraphs,
  VertexGraphs,
} from "../../sdk/src/index.ts";
import { lowerGraphWGSL } from "./graph-expressions.ts";
import type { SurfaceScene } from "./surface.ts";
import type { ComputeExecutionInput } from "../../runtime/src/compute-contract.ts";

export interface MaterialGraphBinding {
  id: string;
  graphs: Partial<Record<keyof MaterialGraphs, GraphIR>>;
  vertex?: Partial<Record<keyof VertexGraphs, GraphIR>>;
  buffers?: Readonly<Record<string, ComputeExecutionInput>>;
  managedTextures?: Readonly<Record<string, ComputeExecutionInput>>;
  time: number;
  parameters: Readonly<Record<string, GraphValue>>;
  textures: ReadonlyMap<string, THREE.Texture>;
}
export type MaterialGraphBindings = ReadonlyMap<
  THREE.Material,
  MaterialGraphBinding
>;
export const DEFAULT_SURFACE_GRAPHS = /* wgsl */ String.raw`
fn surfaceGraphOpacity(index:u32,bary:vec3f,front:bool)->vec2f{return vec2f(0);}
fn surfaceGraphApply(index:u32,bary:vec3f,front:bool,view:vec3f,value:SurfaceValue)->SurfaceValue{return value;}
`;

/** Renderer-private copy destination in the existing SurfaceMaterial storage table. */
export interface SurfaceGraphBufferCopy {
  descriptor: ComputeExecutionInput;
  byteOffset: number;
  count: number;
  type: GraphType;
  material: string;
  name: string;
  /** Packed rgba32float mirror; shares the buffer copy path, with separate diagnostics. */
  texture?: Readonly<ComputeTextureSize>;
}

/** Manual filtering over the eight vec4 fields in each existing material row. */
function textureHelpers(
  helper: string,
  row: number,
  width: number,
  height: number,
  sampler: ComputeTextureBinding,
): string {
  const wrap = (axis: string, mode = "clamp") =>
    mode === "repeat"
      ? `(${axis}-floor(${axis}))`
      : mode === "mirror"
        ? `(1.0-abs((${axis}-2.0*floor(${axis}*0.5))-1.0))`
        : `clamp(${axis},0.0,1.0)`;
  const address = (axis: string, size: number, mode = "clamp") => {
    if (mode === "clamp")
      return `let ${axis}=clamp(cell.${axis},0,${size - 1});`;
    const period = mode === "mirror" ? size * 2 : size;
    return `let ${axis}Wrapped=((cell.${axis}%${period})+${period})%${period};let ${axis}=${mode === "mirror" ? `min(${axis}Wrapped,${period - 1}-${axis}Wrapped)` : axis + "Wrapped"};`;
  };
  return /* wgsl */ `
fn ${helper}Load(cell:vec2i)->vec4f{
 ${address("x", width, sampler.wrapU)}${address("y", height, sampler.wrapV)}
 let element=u32(y)*${width}u+u32(x);
 let row=surfaceMaterials[${row}u+element/8u];
 switch(element%8u){
 case 0u:{return row.base;}case 1u:{return row.factors;}
 case 2u:{return row.emission;}case 3u:{return row.maps0;}
 case 4u:{return row.maps1;}case 5u:{return row.normal;}
 case 6u:{return row.physical;}default:{return row.attenuation;}
 }
}
fn ${helper}(uv:vec2f)->vec4f{
 if(any((bitcast<vec2u>(uv)&vec2u(0x7f800000u))==vec2u(0x7f800000u))){return vec4f(0);}
 let coord=vec2f(${wrap("uv.x", sampler.wrapU)},${wrap("uv.y", sampler.wrapV)})*vec2f(${width}.0,${height}.0);
 ${
   sampler.filter === "nearest"
     ? `return ${helper}Load(vec2i(floor(coord)));`
     : `let pixel=coord-vec2f(0.5);let base=vec2i(floor(pixel));let weight=fract(pixel);
 let a=${helper}Load(base);let b=${helper}Load(base+vec2i(1,0));
 let c=${helper}Load(base+vec2i(0,1));let d=${helper}Load(base+vec2i(1,1));
 let top=a*(1.0-weight.x)+b*weight.x;let bottom=c*(1.0-weight.x)+d*weight.x;
 return top*(1.0-weight.y)+bottom*weight.y;`
 }
}`;
}

/** Private compiled switches share texture/material bindings with the surface evaluator. */
export function compileSurfaceGraphs(
  snapshot: SurfaceScene,
  bindings: MaterialGraphBindings,
  maxMaterialBytes = Number.MAX_SAFE_INTEGER,
) {
  const byUuid = new Map(
    [...bindings].map(([material, binding]) => [material.uuid, binding]),
  );
  const rows: number[] = [],
    helpers: string[] = [],
    full: string[] = [],
    opacity: string[] = [];
  const bufferCopies: SurfaceGraphBufferCopy[] = [];
  let bufferFloats = 0;
  const put = (value: GraphValue) => {
    const row = snapshot.materials.length + rows.length / 32,
      values = Array(32).fill(0);
    if (typeof value === "number" || typeof value === "boolean")
      values[0] = Number(value);
    else values.splice(0, value.length, ...value);
    if (values.some((v) => !Number.isFinite(Math.fround(v))))
      throw Error(
        "TC_GRAPH_VALUE: Material parameters/time must fit finite f32.",
      );
    rows.push(...values);
    return row;
  };
  // Allocate every parameter first so GPU ranges never overlap later materials' parameters.
  const contexts = new Map<
    number,
    { time: number; parameterRows: Map<string, number> }
  >();
  for (const [index, material] of snapshot.materials.entries()) {
    const binding = byUuid.get(material.uuid);
    if (!binding || !Object.keys(binding.graphs).length) continue;
    const timed = Object.values(binding.graphs).some((graph) =>
      graph.nodes.some((node) => node.op === "time"),
    );
    const time = put(timed ? binding.time : 0),
      parameterRows = new Map<string, number>();
    for (const graph of Object.values(binding.graphs))
      for (const p of graph.parameters ?? [])
        if (!parameterRows.has(p.name))
          parameterRows.set(
            p.name,
            put(
              Object.hasOwn(binding.parameters, p.name)
                ? binding.parameters[p.name]
                : p.default,
            ),
          );
    contexts.set(index, { time, parameterRows });
  }
  for (const [index, material] of snapshot.materials.entries()) {
    const binding = byUuid.get(material.uuid),
      allocated = contexts.get(index);
    if (!binding || !allocated) continue;
    const { time, parameterRows } = allocated;
    const slots = new Map<string, { helper: string; type: GraphType }>();
    const textureSlots = new Map<
      string,
      { row: number; width: number; height: number }
    >();
    const textureSamplers = new Map<string, string>();
    const context = /* wgsl */ `let triangle=surfaceTriangle(index);let uv=triangle.ua*bary.x+triangle.ub*bary.y+triangle.uc*bary.z;let positionWorld=triangle.a.xyz*bary.x+triangle.b.xyz*bary.y+triangle.c.xyz*bary.z;let normalWorld=normalize(triangle.na.xyz*bary.x+triangle.nb.xyz*bary.y+triangle.nc.xyz*bary.z);let vertexColor=triangle.ca*bary.x+triangle.cb*bary.y+triangle.cc*bary.z;`;
    const lower = (graph: GraphIR, channel: string) =>
      lowerGraphWGSL(graph, {
        prefix: "tcMaterial" + index + "_" + channel,
        input: (name) => {
          if (name === "time") return "surfaceMaterials[" + time + "u].base.x";
          if (name === "uv") return "uv.xy";
          if (name === "uv1") return "uv.zw";
          if (name === "viewDirectionWorld") return "view";
          if (["positionWorld", "normalWorld", "vertexColor"].includes(name))
            return name;
          throw Error(
            "TC_GRAPH_CONTEXT: material " + binding.id + " input " + name,
          );
        },
        parameter: (name, type) => {
          const row = parameterRows.get(name);
          if (row === undefined)
            throw Error("TC_GRAPH_PARAMETER: " + binding.id + ":" + name);
          const base = "surfaceMaterials[" + row + "u].base";
          return type === "float"
            ? base + ".x"
            : type === "bool"
              ? "(" + base + ".x != 0.0)"
              : base + "." + "xyzw".slice(0, Number(type.slice(3)));
        },
        readBuffer: (name, element, type) => {
          let slot = slots.get(name);
          if (slot && slot.type !== type)
            throw Error("TC_RENDER_BUFFER_TYPE: " + binding.id + ":" + name);
          if (!slot) {
            const descriptor =
              binding.buffers && Object.hasOwn(binding.buffers, name)
                ? binding.buffers[name]
                : undefined;
            if (!descriptor)
              throw Error(
                "TC_RENDER_BUFFER_UNBOUND: " + binding.id + ":" + name,
              );
            if (descriptor.type !== type)
              throw Error("TC_RENDER_BUFFER_TYPE: " + binding.id + ":" + name);
            const count = descriptor.values.length;
            if (!Number.isSafeInteger(count) || count < 1 || count > 0xffffffff)
              throw Error("TC_RENDER_BUFFER_COUNT: " + binding.id + ":" + name);
            const row =
              snapshot.materials.length + (rows.length + bufferFloats) / 32;
            const reserved = Math.ceil(count / 8) * 32;
            if ((row * 32 + reserved) * 4 > maxMaterialBytes)
              throw Error(
                "TC_RENDER_BUFFER_LIMIT: Material table exceeds the device buffer limits.",
              );
            bufferFloats += reserved;
            const helper = "tcMaterialBuffer" + index + "_" + slots.size;
            slot = { helper, type };
            slots.set(name, slot);
            bufferCopies.push({
              descriptor,
              byteOffset: row * 128,
              count,
              type,
              material: binding.id,
              name,
            });
            const resultType =
              type === "float" ? "f32" : type === "bool" ? "bool" : type + "f";
            const zero = type === "bool" ? "false" : resultType + "(0)";
            const value =
              type === "bool"
                ? "(value.x != 0.0)"
                : type === "float"
                  ? "value.x"
                  : "value." + "xyzw".slice(0, Number(type.slice(3)));
            helpers.push(/* wgsl */ `
fn ${helper}(index:f32)->${resultType}{
 if ((bitcast<u32>(index)&0x7f800000u)==0x7f800000u){return ${zero};}
 if (!(index>=0.0 && index<4294967296.0 && floor(index)==index)){return ${zero};}
 let element=u32(index);if(element>=${count}u){return ${zero};}
 let row=surfaceMaterials[${row}u+element/8u];var value=vec4f(0);
 switch (element%8u){
 case 0u:{value=row.base;}case 1u:{value=row.factors;}
 case 2u:{value=row.emission;}case 3u:{value=row.maps0;}
 case 4u:{value=row.maps1;}case 5u:{value=row.normal;}
 case 6u:{value=row.physical;}default:{value=row.attenuation;}
 }
 return ${value};
}`);
          }
          return slot.helper + "(" + element + ")";
        },
        sampleTexture: (asset, uv) => {
          const sampler =
            graph.textureSlots && Object.hasOwn(graph.textureSlots, asset)
              ? graph.textureSlots[asset]
              : undefined;
          if (sampler) {
            let slot = textureSlots.get(asset);
            if (!slot) {
              const descriptor =
                binding.managedTextures &&
                Object.hasOwn(binding.managedTextures, asset)
                  ? binding.managedTextures[asset]
                  : undefined;
              if (!descriptor)
                throw Error(
                  "TC_RENDER_TEXTURE_UNBOUND: " + binding.id + ":" + asset,
                );
              const shape = descriptor.texture,
                count = descriptor.values.length;
              if (
                descriptor.type !== "vec4" ||
                !shape ||
                !Number.isSafeInteger(shape.width) ||
                !Number.isSafeInteger(shape.height) ||
                shape.width < 1 ||
                shape.height < 1 ||
                !Number.isSafeInteger(count) ||
                count < 1 ||
                count > 0xffffffff ||
                shape.width * shape.height !== count
              )
                throw Error(
                  "TC_RENDER_TEXTURE_RESOURCE: " + binding.id + ":" + asset,
                );
              const row =
                snapshot.materials.length + (rows.length + bufferFloats) / 32;
              const reserved = Math.ceil(count / 8) * 32;
              if ((row * 32 + reserved) * 4 > maxMaterialBytes)
                throw Error(
                  "TC_RENDER_TEXTURE_LIMIT: Material table exceeds the device buffer limits.",
                );
              bufferFloats += reserved;
              slot = { row, width: shape.width, height: shape.height };
              textureSlots.set(asset, slot);
              bufferCopies.push({
                descriptor,
                byteOffset: row * 128,
                count,
                type: "vec4",
                material: binding.id,
                name: asset,
                texture: { width: shape.width, height: shape.height },
              });
            }
            const signature = JSON.stringify([
              asset,
              sampler.filter ?? "linear",
              sampler.wrapU ?? "clamp",
              sampler.wrapV ?? "clamp",
            ]);
            let helper = textureSamplers.get(signature);
            if (!helper) {
              helper = "tcMaterialTexture" + index + "_" + textureSamplers.size;
              textureSamplers.set(signature, helper);
              helpers.push(
                textureHelpers(
                  helper,
                  slot.row,
                  slot.width,
                  slot.height,
                  sampler,
                ),
              );
            }
            return helper + "(" + uv + ")";
          }
          const source = binding.textures.get(asset);
          const id = snapshot.textures.findIndex(
            (texture) => texture.uuid === source?.uuid,
          );
          if (id < 0)
            throw Error("TC_GRAPH_TEXTURE: " + binding.id + ":" + asset);
          return "surfaceMap(" + id + ".0,vec4f(" + uv + "," + uv + "))";
        },
      });
    const statements: string[] = [];
    for (const [channel, graph] of Object.entries(binding.graphs)) {
      const g = lower(graph, channel);
      helpers.push(g.helpers);
      statements.push(g.code);
      const value = g.result;
      if (channel === "baseColor")
        statements.push(
          "result.base=" +
            value +
            "*vec3f(triangle.b.w,triangle.c.w,triangle.na.w);if(triangle.nb.w>0.5){result.base*=vertexColor.rgb;}",
        );
      else if (channel === "emissive")
        statements.push("result.emissive=" + value + ";");
      else if (channel === "normalWorld")
        statements.push(
          "result.normal=surfaceGraphNormal(" +
            value +
            ",normalWorld)*surfaceNormalSign(surfaceMaterials[u32(triangle.a.w)],front);",
        );
      else if (channel === "opacity")
        statements.push("result.alpha*=clamp(" + value + ",0.0,1.0);");
      else
        statements.push(
          "result." +
            (channel === "opacity" ? "alpha" : channel) +
            "=clamp(" +
            value +
            ",0.0,1.0);",
        );
      if (channel === "opacity") {
        const alpha = lower(graph, "coverage");
        helpers.push(alpha.helpers);
        opacity.push(
          "case " +
            index +
            "u:{" +
            context +
            "let view=vec3f(0);" +
            alpha.code +
            "return vec2f(clamp(" +
            alpha.result +
            ",0.0,1.0),1);}",
        );
      }
    }
    full.push("case " + index + "u:{" + context + statements.join("\n") + "}");
  }
  const source = full.length
    ? helpers.join("\n") +
      /* wgsl */ `
fn surfaceGraphOpacity(index:u32,bary:vec3f,front:bool)->vec2f{
 switch u32(surfaceTriangle(index).a.w){${opacity.join("\n")}default:{}}return vec2f(0);
}
fn surfaceGraphApply(index:u32,bary:vec3f,front:bool,view:vec3f,value:SurfaceValue)->SurfaceValue{
 var result=value;switch u32(surfaceTriangle(index).a.w){${full.join("\n")}default:{}}return result;
}
`
    : DEFAULT_SURFACE_GRAPHS;
  const tableRows = new Float32Array(rows.length + bufferFloats);
  tableRows.set(rows);
  return { source, rows: tableRows, materials: full.length, bufferCopies };
}

/** Proposal only: every graph emitter needs support, even with a black standard emissive. */
export function graphEmissiveProposal(
  snapshot: SurfaceScene,
  bindings: MaterialGraphBindings,
): SurfaceScene {
  const emitters = new Set(
    [...bindings]
      .filter(([, binding]) => binding.graphs.emissive)
      .map(([material]) => material.uuid),
  );
  if (!emitters.size) return snapshot;
  return {
    ...snapshot,
    materials: snapshot.materials.map((material) =>
      emitters.has(material.uuid)
        ? { ...material, emissive: [1, 1, 1] as const, emissiveIntensity: 1 }
        : material,
    ),
  };
}
