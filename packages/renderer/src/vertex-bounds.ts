import * as THREE from "three/webgpu";
import { createSurfaceCapture } from "./surface-capture.ts";
import { createSurfaceAcceleration, type SurfaceAcceleration } from "./acceleration.ts";
import type { MaterialGraphBindings } from "./material-graphs.ts";
import type { SurfaceScene, SurfaceTriangle } from "./surface.ts";

type MeshState = {
  mesh: THREE.Mesh;
  sphere?: PropertyDescriptor;
  box?: PropertyDescriptor;
  raycast?: PropertyDescriptor;
  acceleration: SurfaceAcceleration;
  surface: SurfaceScene;
};
const fail = (message: string): never => { throw new Error("TC_VERTEX_BOUNDS: " + message + " Repair: Supply finite nonsingular transforms and valid vertex graphs."); };
const entityName = (mesh: THREE.Mesh) => {
  for (let object: THREE.Object3D | null = mesh; object; object = object.parent)
    if (Object.hasOwn(object.userData, "pelicanPrefab")) return object.name;
  return mesh.parent?.name ?? "";
};

/** Content-owned derived bounds and render raycasts; explicit physics colliders are separate. */
export function createVertexBoundsOwner() {
  const capture = createSurfaceCapture();
  const states = new Map<THREE.Mesh, MeshState>();
  let disposed = false, updates = 0;
  const restore = (state: MeshState) => {
    for (const [name, descriptor] of [["boundingSphere", state.sphere], ["boundingBox", state.box], ["raycast", state.raycast]] as const) {
      if (descriptor) Object.defineProperty(state.mesh, name, descriptor);
      else delete (state.mesh as unknown as Record<string, unknown>)[name];
    }
    state.acceleration.dispose();
  };
  const install = (mesh: THREE.Mesh, surface: SurfaceScene, triangles: readonly SurfaceTriangle[]): MeshState => {
    const state: MeshState = { mesh, sphere: Object.getOwnPropertyDescriptor(mesh, "boundingSphere"), box: Object.getOwnPropertyDescriptor(mesh, "boundingBox"), raycast: Object.getOwnPropertyDescriptor(mesh, "raycast"), acceleration: createSurfaceAcceleration(), surface: { ...surface, triangles } };
    mesh.raycast = (raycaster, intersections) => {
      const direction = raycaster.ray.direction.clone().normalize();
      const near = Math.max(0, raycaster.near), far = raycaster.far;
      if (far < near) return;
      const origin = raycaster.ray.origin.clone().addScaledVector(direction, near);
      const hit = state.acceleration.intersect(origin.toArray(), direction.toArray(), far - near);
      if (!hit) return;
      const triangle = state.surface.triangles[hit.triangleIndex];
      const point = origin.addScaledVector(direction, hit.distance);
      const [a, b, c] = triangle.vertexIndices;
      const inverse = mesh.matrixWorld.clone().invert();
      const local = triangle.vertices.map(vertex => new THREE.Vector3(...vertex.position).applyMatrix4(inverse));
      const faceNormal = new THREE.Triangle(local[0], local[1], local[2]).getNormal(new THREE.Vector3());
      intersections.push({ distance: near + hit.distance, point, object: mesh, faceIndex: triangle.elementOffset / 3, face: { a, b, c, normal: faceNormal, materialIndex: triangle.materialIndex }, ...(triangle.instanceId !== undefined ? { instanceId: triangle.instanceId } : {}) });
    };
    return state;
  };
  return {
    update(scene: THREE.Scene, graphs: MaterialGraphBindings) {
      if (disposed) fail("Derived vertex owner is disposed.");
      if (![...graphs.values()].some(binding => binding.vertex)) {
        for (const state of states.values()) restore(state);
        states.clear();
        return;
      }
      const captured = capture.capture(scene, new Set(graphs.keys()), graphs, { geometryOnly: true });
      const byObject = new Map<string, SurfaceTriangle[]>();
      for (const triangle of captured.surface.triangles) {
        if (!byObject.has(triangle.objectUuid)) byObject.set(triangle.objectUuid, []);
        byObject.get(triangle.objectUuid)!.push(triangle);
      }
      const staged: { mesh: THREE.Mesh; triangles: readonly SurfaceTriangle[]; bounds: THREE.Box3; sphere: THREE.Sphere }[] = [];
      scene.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const triangles = byObject.get(object.uuid);
        if (!triangles) return;
        const inverse = object.matrixWorld.clone().invert();
        const bounds = new THREE.Box3();
        for (const triangle of triangles) for (const vertex of triangle.vertices) bounds.expandByPoint(new THREE.Vector3(...vertex.position).applyMatrix4(inverse));
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        if (![...bounds.min.toArray(), ...bounds.max.toArray(), ...sphere.center.toArray(), sphere.radius].every(Number.isFinite)) fail("Derived bounds are nonfinite for " + object.uuid);
        staged.push({ mesh: object, triangles, bounds, sphere });
      });
      const live = new Set(staged.map(item => item.mesh));
      for (const [mesh, state] of states) if (!live.has(mesh)) { restore(state); states.delete(mesh); }
      for (const item of staged) {
        let state = states.get(item.mesh);
        if (!state) { state = install(item.mesh, captured.surface, item.triangles); states.set(item.mesh, state); }
        const next = { ...captured.surface, triangles: item.triangles };
        state.acceleration.update(next);
        state.surface = next;
        Object.defineProperty(item.mesh, "boundingBox", { configurable: true, writable: true, enumerable: true, value: item.bounds });
        Object.defineProperty(item.mesh, "boundingSphere", { configurable: true, writable: true, enumerable: true, value: item.sphere });
      }
      updates++;
    },
    inspect() {
      return { disposed, updates, meshes: states.size, capture: capture.inspect(), accelerations: [...states.values()].map(state => ({ object: state.mesh.uuid, ...state.acceleration.inspect() })), bounds: [...states.values()].map(state => {
        const mesh = state.mesh as THREE.Mesh & { boundingSphere: THREE.Sphere; boundingBox: THREE.Box3 };
        return { object: mesh.uuid, entity: entityName(mesh), frustumCulled: mesh.frustumCulled, center: mesh.boundingSphere.center.toArray(), worldCenter: mesh.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld).toArray(), radius: mesh.boundingSphere.radius, min: mesh.boundingBox.min.toArray(), max: mesh.boundingBox.max.toArray() };
      }) };
    },
    intersect(origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance = Infinity) {
      if (disposed) fail("Derived vertex owner is disposed.");
      let nearest: { distance: number; normal: readonly [number, number, number]; object: string; entity: string } | null = null;
      for (const state of states.values()) {
        const hit = state.acceleration.intersect(origin, direction, maxDistance);
        if (hit && (!nearest || hit.distance < nearest.distance)) nearest = { distance: hit.distance, normal: hit.normal, object: state.mesh.uuid, entity: entityName(state.mesh) };
      }
      return nearest;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of states.values()) restore(state);
      states.clear(); capture.dispose();
    },
  };
}
