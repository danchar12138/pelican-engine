import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareMaterialSlotsGLB(destination: string): Promise<void> {
  const doc = new Document();
  doc.getRoot().setExtras({ source: "Procedural Pelican material slot fixture", license: "MIT" });
  const buffer = doc.createBuffer();
  const normals = doc.createAccessor("normals", buffer).setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const indices = doc.createAccessor("indices", buffer).setType(Accessor.Type.SCALAR)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
  const mesh = doc.createMesh("two-planes");
  for (const [name, center, color] of [
    ["Paint", -0.8, [1, 0, 0, 1]],
    ["Trim", 0.8, [0, 0, 1, 1]],
  ] as const) {
    const positions = doc.createAccessor(`${name}-positions`, buffer).setType(Accessor.Type.VEC3)
      .setArray(new Float32Array([
        center - 0.5, -0.9, 0, center + 0.5, -0.9, 0,
        center + 0.5, 0.9, 0, center - 0.5, 0.9, 0,
      ]));
    const material = doc.createMaterial(name).setBaseColorFactor([...color])
      .setMetallicFactor(0).setRoughnessFactor(0.8);
    mesh.addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions)
      .setAttribute("NORMAL", normals).setIndices(indices).setMaterial(material));
  }
  const scene = doc.createScene("scene").addChild(doc.createNode("panels").setMesh(mesh));
  doc.getRoot().setDefaultScene(scene);
  const bytes = await new NodeIO().writeBinary(doc);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL("../examples/material-slots/assets/panels.glb", import.meta.url));
  prepareMaterialSlotsGLB(target).then(() => console.log(target)).catch(error => { console.error(error); process.exitCode = 1; });
}
