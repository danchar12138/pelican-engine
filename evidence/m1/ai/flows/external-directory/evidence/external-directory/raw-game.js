// ../threecat/packages/sdk/src/index.ts
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
	engine.configureGameSystems?.(systems);
	return {
		update(dt) {
			if (disposed) throw new Error("TC_RUNTIME_DISPOSED: Game has been disposed.");
			if (!Number.isFinite(dt) || dt < 0) throw new Error("TC_RUNTIME_DT: Expected a finite, non-negative timestep.");
			if (engine.runGameSystems) engine.runGameSystems(systems, dt);
			else {
				const context = new Proxy(engine, { get(target, key, receiver) {
					if ([
						"time",
						"entities",
						"random",
						"emit",
						"events"
					].includes(String(key))) throw new Error(`TC_RUNTIME_SERVICE_UNAVAILABLE: ${String(key)} requires a threecat runtime host.`);
					return Reflect.get(target, key, receiver);
				} });
				for (const system of systems) system.run(context, dt);
			}
		},
		dispose() {
			disposed = true;
			systems.length = 0;
		}
	};
}
// game.ts
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
var Progress = defineComponent({
	id: "Progress",
	schema: {
		ticks: {
			type: "number",
			default: 0
		},
		lastRandom: {
			type: "number",
			default: 0
		},
		events: {
			type: "number",
			default: 0
		}
	}
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
	roughness: .8
});
var green = defineMaterial({
	id: "green",
	color: "#27bd75",
	roughness: .45
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
var input = defineSystem({
	id: "input",
	phase: "input",
	reads: ["Motion"],
	writes: ["Transform"],
	run(engine) {
		for (const event of engine.events("input.key")) {
			const input = event.payload;
			if (!input.pressed || !["ArrowLeft", "ArrowRight"].includes(input.key)) continue;
			for (const id of engine.query(Motion)) {
				const transform = engine.getTransform(id);
				engine.setTransform(id, { position: [
					transform.position[0] + (input.key === "ArrowRight" ? .25 : -.25),
					transform.position[1],
					transform.position[2]
				] });
			}
		}
	}
});
var spin = defineSystem({
	id: "spin",
	phase: "update",
	reads: ["Motion"],
	writes: ["Transform", "Progress"],
	run(engine, dt) {
		for (const id of engine.query(Motion)) {
			const motion = engine.getComponent(id, Motion);
			if (!motion.enabled) continue;
			const transform = engine.getTransform(id);
			engine.setTransform(id, { rotation: [
				0,
				transform.rotation[1] + motion.speed * dt,
				0
			] });
			const progress = engine.getComponent(id, Progress);
			engine.setComponent(id, Progress, {
				ticks: progress.ticks + 1,
				lastRandom: engine.random()
			});
			if (progress.ticks === 0) engine.emit("started", { entity: id });
		}
	}
});
var observe = defineSystem({
	id: "observe",
	phase: "postPhysics",
	reads: [],
	writes: ["Progress"],
	run(engine) {
		for (const event of engine.events("started")) {
			const id = event.payload.entity;
			const progress = engine.getComponent(id, Progress);
			engine.setComponent(id, Progress, { events: progress.events + 1 });
		}
	}
});
var AICounter = defineComponent({
	id: "AICounter",
	schema: { ticks: {
		type: "number",
		default: 0
	} }
});
var aiCount = defineSystem({
	id: "ai-counter",
	phase: "presentation",
	after: ["spin"],
	reads: ["AICounter"],
	writes: ["AICounter"],
	structural: false,
	run(engine) {
		for (const id of engine.query(AICounter)) {
			const counter = engine.getComponent(id, AICounter);
			engine.setComponent(id, AICounter, { ticks: counter.ticks + 1 });
		}
	}
});
var game_default = defineGame({
	id: "m1-foundation",
	scene: defineScene({
		id: "foundation",
		camera: {
			position: [
				4,
				3,
				6
			],
			target: [
				0,
				.7,
				0
			],
			fov: 45
		},
		environment: {
			background: "#111d2a",
			ambientIntensity: 1.1
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
				] },
				components: [{ component: AICounter }]
			},
			{
				id: "spinner",
				mesh: {
					geometry: {
						kind: "box",
						size: [
							1.3,
							1.3,
							1.3
						]
					},
					material: copper
				},
				transform: { position: [
					-.9,
					.8,
					0
				] },
				components: [
					{ component: Motion },
					{ component: Progress },
					{ component: AICounter }
				]
			},
			{
				id: "orb",
				mesh: {
					geometry: {
						kind: "sphere",
						radius: .65
					},
					material: green
				},
				transform: { position: [
					1.1,
					.7,
					0
				] }
			},
			{
				id: "ground",
				mesh: {
					geometry: {
						kind: "box",
						size: [
							12,
							.2,
							12
						]
					},
					material: floor
				},
				transform: { position: [
					0,
					-.1,
					0
				] }
			},
			{
				id: "sun",
				light: {
					kind: "directional",
					color: "#fff1d4",
					intensity: 4,
					castShadow: true
				},
				transform: { position: [
					-3,
					7,
					4
				] }
			}
		]
	}),
	systems: [
		spin,
		observe,
		input,
		aiCount
	],
	computes: [pulse]
});
// \0threecat:m0-game-entry
function createGame(engine) {
	return instantiateGame(game_default, engine);
}
export { createGame };

//# sourceMappingURL=game.js.map