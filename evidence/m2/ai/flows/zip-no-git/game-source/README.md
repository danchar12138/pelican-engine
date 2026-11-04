# Three Core Relay

Repair a triangular relay yard using the public threecat SDK. Hold E beside the west, north and east cores for 1.2 seconds each. Every restored core grants +0.4 movement speed and drops a physical capacitor from a runtime prefab. Return to the south console and hold E for 1.5 seconds to reboot the exit. Its physical kinematic gate rises; walk south through it to finish. Candidate5 restores the original kinematic gate after the engine's character-contact fix; no fixed-body substitute is used for the gate.

WASD/arrows move, Space jumps, E repairs/reboots, F5 saves, F9 loads, R resets. The center block and closed gate have physical collision. Fox Run/Survey skeletal animation, character gravity and jumping, and dynamic reward rigid bodies use engine services. Components retain repair progress, rewards, speed boosts, exit state and gate height across saves. No engine internals or test bridge are imported by the game.

Assets come from the template. Fox and chime license/source/attribution are preserved in assets.ts and assets metadata. This game differs from the template's relic collection and northern exit route.
