// source/threecat/packages/sdk/src/index.ts
function defineComponent(input) {
	return {
		...input,
		kind: "component"
	};
}
function defineMaterial(input) {
	return {
		...input,
		kind: "material"
	};
}
function defineCompute(input) {
	return {
		...input,
		kind: "compute"
	};
}
function definePrefab(input) {
	return {
		...input,
		kind: "prefab"
	};
}
function defineScene(input) {
	return {
		...input,
		kind: "scene"
	};
}
function defineSystem(input) {
	return {
		...input,
		kind: "system"
	};
}
function defineGame(input) {
	return {
		...input,
		kind: "game"
	};
}
/** Runtime wrapper used by compiled game.js. Source declarations are never imported by the compiler. */
function instantiateGame(game, engine) {
	let disposed = false;
	const systems = [...game.systems ?? []];
	return {
		update(dt) {
			if (disposed) throw new Error("TC_RUNTIME_DISPOSED: Game has been disposed.");
			if (!Number.isFinite(dt) || dt < 0) throw new Error("TC_RUNTIME_DT: Expected a finite, non-negative timestep.");
			for (const system of systems) system.run(engine, dt);
		},
		dispose() {
			disposed = true;
			systems.length = 0;
		}
	};
}
// 外部 游戏 中文/ai-game-b/game.ts
var Motion = defineComponent({
	id: "Motion",
	schema: {
		speed: {
			type: "number",
			default: 1.5
		},
		enabled: {
			type: "boolean",
			default: true
		}
	}
});
var green = defineMaterial({
	id: "ai-green",
	color: "#22cc44",
	roughness: .6
});
var copper = defineMaterial({
	id: "copper",
	color: "#db7836",
	roughness: .26,
	metalness: .65
});
var floor = defineMaterial({
	id: "floor",
	color: "#71839a",
	roughness: .8,
	metalness: .05
});
var animated = defineMaterial({
	id: "animated",
	color: "#4488dd",
	roughness: .35,
	graph: {
		nodes: [
			{
				id: "base",
				op: "vec3",
				value: [
					.1,
					.4,
					.8
				]
			},
			{
				id: "clock",
				op: "time"
			},
			{
				id: "wave",
				op: "sin",
				inputs: ["clock"]
			},
			{
				id: "tint",
				op: "multiply",
				inputs: ["base", "wave"]
			},
			{
				id: "color",
				op: "add",
				inputs: ["base", "tint"]
			}
		],
		output: "color"
	}
});
var pulse = defineCompute({
	id: "pulse",
	count: 16,
	workgroupSize: 16,
	outputType: "float",
	graph: {
		nodes: [{
			id: "clock",
			op: "time"
		}, {
			id: "wave",
			op: "sin",
			inputs: ["clock"]
		}],
		output: "wave"
	}
});
var Spinner = definePrefab({
	id: "Spinner",
	mesh: {
		geometry: {
			kind: "box",
			size: [
				1.4,
				1.4,
				1.4
			]
		},
		material: copper
	},
	components: [{ component: Motion }]
});
var game_default = defineGame({
	id: "m0-game",
	scene: defineScene({
		id: "m0-scene",
		camera: {
			position: [
				5,
				3.8,
				7
			],
			target: [
				0,
				.7,
				0
			],
			fov: 45
		},
		environment: {
			background: "#151c2b",
			ambientIntensity: .5
		},
		entities: [
			{
				id: "ai-created-crate",
				mesh: {
					geometry: {
						kind: "box",
						size: [
							.6,
							.6,
							.6
						]
					},
					material: green
				},
				transform: { position: [
					2.6,
					.5,
					1.6
				] }
			},
			{
				id: "m0-spinner",
				prefab: Spinner,
				transform: { position: [
					-2,
					1,
					1.5
				] }
			},
			{
				id: "m0-group",
				transform: { position: [
					6,
					0,
					-2
				] }
			},
			{
				id: "m0-child",
				parent: "m0-group",
				mesh: {
					geometry: {
						kind: "box",
						size: [
							.25,
							.25,
							.25
						]
					},
					material: copper
				},
				transform: { position: [
					1,
					.5,
					0
				] }
			},
			{
				id: "m0-orb",
				mesh: {
					geometry: {
						kind: "sphere",
						radius: .7
					},
					material: animated
				},
				transform: { position: [
					-3.8,
					.85,
					1.5
				] }
			},
			{
				id: "m0-ground",
				mesh: {
					geometry: {
						kind: "box",
						size: [
							4.8,
							.2,
							3.6
						]
					},
					material: floor
				},
				transform: { position: [
					-2,
					.05,
					1.5
				] }
			},
			{
				id: "m0-sun",
				light: {
					kind: "directional",
					intensity: 4,
					color: "#fff0d8",
					castShadow: true
				},
				transform: { position: [
					-2,
					7,
					5
				] }
			}
		]
	}),
	systems: [defineSystem({
		id: "spin",
		phase: "update",
		run(engine, dt) {
			for (const id of engine.query(Motion)) {
				const motion = engine.getComponent(id, Motion);
				if (!motion.enabled) continue;
				const t = engine.getTransform(id);
				engine.setTransform(id, { rotation: [
					t.rotation[0],
					t.rotation[1] + motion.speed * dt,
					t.rotation[2]
				] });
			}
		}
	})],
	computes: [pulse]
});
// \0threecat:m0-game-entry
function createGame(engine) {
	return instantiateGame(game_default, engine);
}
export { createGame };

//# sourceMappingURL=game.js.map