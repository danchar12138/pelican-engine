import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { crc32 } from "../packages/assets/src/texture.ts";

/** Deterministic tiny data fixtures, not externally generated art or runtime services. */
export async function prepareVertexAssets(directory = fileURLToPath(new URL("../examples/vertex/assets/", import.meta.url))) {
  await mkdir(directory, { recursive: true });
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), bytes]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(data));
    return Buffer.concat([size, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0,0,0,0,255,64,64,64,255,0,128,128,128,255,255,255,255,255]))), chunk("IEND", Buffer.alloc(0))]);
  await writeFile(path.join(directory, "height.png"), png);
  const doc = new Document(), buffer = doc.createBuffer(), geometry = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  const accessor = (name: string, type: Parameters<Accessor["setType"]>[0], array: Parameters<Accessor["setArray"]>[0]) => doc.createAccessor(name, buffer).setType(type).setArray(array);
  const position = geometry.getAttribute("position"), normals = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
  const vertices = position.count, weights = new Float32Array(vertices * 4);
  for (let i = 0; i < vertices; i++) weights[i * 4] = 1;
  const primitive = doc.createPrimitive()
    .setAttribute("POSITION", accessor("position", Accessor.Type.VEC3, new Float32Array(position.array)))
    .setAttribute("NORMAL", accessor("normal", Accessor.Type.VEC3, new Float32Array(normals.array)))
    .setAttribute("TEXCOORD_0", accessor("uv", Accessor.Type.VEC2, new Float32Array(uv.array)))
    .setAttribute("JOINTS_0", accessor("joints", Accessor.Type.VEC4, new Uint16Array(vertices * 4)))
    .setAttribute("WEIGHTS_0", accessor("weights", Accessor.Type.VEC4, weights))
    .setIndices(accessor("indices", Accessor.Type.SCALAR, new Uint16Array(geometry.index!.array)));
  const morph = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) morph[i * 3 + 1] = 0.15 * (position.getY(i) + 0.55);
  primitive.addTarget(doc.createPrimitiveTarget().setAttribute("POSITION", accessor("morph", Accessor.Type.VEC3, morph)));
  const mesh = doc.createMesh("skinned-morph-box").addPrimitive(primitive).setWeights([0.5]);
  const scene = doc.createScene("fixture"), bone = doc.createNode("bone");
  scene.addChild(bone);
  const skin = doc.createSkin("skin").addJoint(bone).setInverseBindMatrices(accessor("inverse-bind", Accessor.Type.MAT4, new Float32Array(new THREE.Matrix4().elements)));
  scene.addChild(doc.createNode("shape").setMesh(mesh).setSkin(skin));
  const times = accessor("times", Accessor.Type.SCALAR, new Float32Array([0, 0.5, 1]));
  const translations = accessor("translations", Accessor.Type.VEC3, new Float32Array([0,0,0,0.2,0.1,0,0,0,0]));
  const sampler = doc.createAnimationSampler().setInput(times).setOutput(translations).setInterpolation("LINEAR");
  const channel = doc.createAnimationChannel().setTargetNode(bone).setTargetPath("translation").setSampler(sampler);
  doc.createAnimation("sway").addSampler(sampler).addChannel(channel);
  await writeFile(path.join(directory, "skinned.glb"), await new NodeIO().writeBinary(doc));
  geometry.dispose();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareVertexAssets().then(() => console.log("Prepared tiny vertex data and skinned/morph GLB fixtures."));
