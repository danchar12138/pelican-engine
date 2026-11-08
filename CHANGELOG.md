# Changelog

## 1.3.0

- 修复 Windows 跨盘游戏的共享 runtime 源映射；仅允许选定引擎根内的稳定路径。API 索引统一换行，避免跨平台查询签名差异。

- 恢复鹈鹕图标与 README 项目展示，npm 包同样提供图标、价值说明和独立游戏开发入口。
- 发光面使用 alias sampling 与三角形索引 PDF，显式灯光不再重复扫描整张发光三角形表；缓存静态发光元数据。
- 保留不可变提取几何的私有 provenance，减少重复验证；缓存几何打包与身份，按脏块更新 GPU 数据，保持外部输入和失败恢复检查。
- 新增每实例 runtime.create、就绪状态、own/defer 生命周期、版本化状态 hooks，接入 Host 快照、恢复、回放与失败回滚；检查构建和浏览器定义漂移。
- 新增 BufferGeometryInput、normal/roughness/metalness/AO/emissive 贴图与 normalScale；新增 API v1 受管渲染扩展组合。
- 物理后端改为异步加载，支持 auto/required/disabled 计划；保留空世界查询及明确的需求冲突诊断。
- CLI 支持常见 --help/-h 与 --version/-v 入口，保持 JSON 协议。
- 补全能力目录和中英文别名；API 支持成员检索、精确 Type.member、相关性排序及 total/truncated。新增多文件 runtime 和受管渲染配方、llms.txt 与依赖接入指南。
- 增加跨平台生成目录清理工具、同资产 npm 渲染对比与独立 AI 作者评测记录器。运行输出不提交源码仓库。
- 浏览器场景切换与读档等待异步作者实例就绪；Windows 构建目录重命名对短暂共享锁进行有界重试，保留失败恢复路径。
- 自动化工具默认使用完整无界面 Chromium，保持实际 GPU；就绪检查不依赖 RAF 或桌面焦点，增加无焦点／禁用 RAF 的实际安装包复跑。

## 1.2.0

- 游戏开发统一使用 npm；仓库只供引擎贡献者，当前树不再保存历史证据、阶段任务、旧源码 ZIP 发布工具和重复生成文档。
- 新建 npm 项目使用普通 TypeScript 内容构建，支持循环、类、闭包和正常项目依赖；原有静态模式保留兼容。可信内容在独立进程执行，提供截止时间和结构化失败。
- doctor/setup 使用 Node 跨平台能力，浏览器参数按系统选择，移除 PowerShell bootstrap 与脚本依赖；CI 覆盖 Windows、Linux、macOS，检查完成后发布实际测试的 tarball。
- 修复相对引擎路径在 macOS `/var` 别名及不同深度目录别名下的解析，保留路径身份检查；剪贴板自动化使用系统主修饰键。
- 静态模块缓存仅在 Windows 忽略路径大小写；普通内容跟踪 workspace 依赖、声明及包 exports 的变化。
- 开发和生产默认隐藏技术 HUD，使用 `?diagnostics=1` 显式开启，避免遮挡游戏界面和截图。
- 修复 POSIX 下 npm exec 开发服务停止后遗留子进程与管道，安装回归等待进程树完全关闭。
- npm 包仅附带游戏作者需要的指南与机器契约；注册表传播等待延长，传播失败不触发盲目重复发布。

## 1.0.0 - 2026-11-08

- D60 milestone release under the compile/build-only policy. Runtime, GPU, numerical stability, performance, lifecycle and historical recovery acceptance are deferred until after 1.0. This release does not claim completion of every historical CAP item.

- Freeze the final 1.0 implementation scope under D60 to simulation coupling, dynamic-world lifecycle and full-body animation integration; other historical roadmap items are not added to this delivery.
- Interleave native physics and rope/cloth/soft-body/fluid integration on a shared substep clock, with once-per-tick forces, shared WCSPH pressure, per-substep reactions, moving-obstacle sweeps and structured fixed-tick history transactions. Runtime behavior, numerical stability, rollback and historical compatibility remain unverified.
- Support 64 explicit native sphere/box bindings per automatic fluid/soft-body entry, detach stale generations and refresh derived samples after host restoration. New automatic entries no longer create a hidden reference sphere; manual/legacy snapshot layout is retained. Behavior and compatibility are unverified.
- Park dynamic/kinematic/character roots with velocities, sleep/gravity/character state, internal joints, model animation and wholly owned material solvers. Reconstruct native bodies before animation/director evaluation and reject incompatible cross-chunk dependencies. Keep prepared assets cached; asynchronous asset streaming is not included. Lifecycle and recovery are unverified.
- Coordinate multi-chain grounding, bounded body adjustment, contact normals, moving-support anchors, post-collision root-motion stride feedback and generation-safe model residency. Preserve cinematic time ownership and saved pose state. Kinematic grounding is not ragdoll balance; all behavior remains unverified.

## 0.17.0 - 2026-11-08

- Compile-only cinematic/audio development batch. Timeline behavior, presentation, sound output, audio/video alignment, native teleports and restoration have not been runtime-validated. Complete coupled simulation and dynamic-world scope remain unfinished; this is not 1.0.

- Add a fixed-time cinematic director with camera/entity keys, skeletal intervals, owned audio cues, localized subtitles, screen fades, event markers and game-code branching. Add pause/resume/seek/speed, ownership restoration, stale-binding cleanup and peer snapshots. Runtime behavior, audio/video alignment and recovery are unverified.
- Add source-time audio seek/playback rate with snapshot accounting and Web Audio buffer-source revisions; sound output and compatibility are unverified.
- Add explicit 3D native/World teleport with reconstruction history, query refresh and ECS access checks before native mutation; behavior and recovery are unverified.

## 0.16.0 - 2026-11-08

- Compile-only animation development batch. IK constraints, retargeting, root motion, changed animation scheduling and snapshot behavior have not been runtime-validated. Cinematic sequencing, full coupled integration and broader world scope remain unfinished; this is not 1.0.

- Add IK joint limits, normalized hinge axes, two-link pole targets and effector orientation blending; behavior and recovery are unverified.
- Add isolated bind-pose-corrected skeletal clip retargeting, generated-clip lifecycle and descriptor-based snapshot reconstruction; runtime behavior and costs are unverified.
- Add loop-aware root-motion extraction and optional character/non-physical root application before native physics, with snapshot-preserved pending movement. Root motion, animation order and blocking interactions are unverified.
- Add empty-world legacy physics state for older scenes that did not initialize a 3D physics owner; compatibility is unverified.

## 0.15.0 - 2026-11-08

- Compile-only simulation/terrain development batch. Cross-material solving, native terrain collision, navigation, tracing, resource costs and recovery have not been runtime-validated. Complete 1.0 scope is still unfinished.

- Add editable height-surface terrain with native triangle collision, owned walkability/cost grids, triangle-height navigation agents, dynamic raster/tracing meshes, shared particle contacts and peer snapshot checks. This does not complete volumetric destruction or world streaming; runtime and restoration are unverified.
- Fault native 3D physics after any exception during action application, including stable diagnostics that may occur after mutation. Common invalid body/vector commands are rejected before native application; recovery is unverified.

- Add transactional cross-entry contacts for automatic rope, cloth, soft-body and fluid simulations, shared virtual rigid reactions, distance/volume reprojection and one reaction commit per host tick. This is split-step coupling, not complete rigid/material time integration; runtime and recovery are unverified.
- Add linear particle sweeps against sampled spheres, planes and oriented boxes, cross-entry moving particle/segment/triangle CCD, and positional/effective-mass Coulomb friction. Rotating/moving rigid obstacle CCD and full coupled scope remain incomplete; no behavior validation was performed.

## 0.14.0 - 2026-11-08

- Compile-only development batch. Native first-step deletion behavior, independent-memory recovery, v3 compatibility, joints, resource costs and browsers have not been tested. Unified simulation coupling, world/terrain and remaining animation work are not complete; this is not 1.0.

- Add production 3D joint creation, inspection and deletion for fixed, ball, revolute, prismatic, rope and spring constraints, with snapshot history and endpoint cleanup. Behavior is unverified.
- Isolate every 3D physics world and replay candidate in separate WASM memory, sharing compiled code only; recovery and memory behavior are unverified.

- Integrate a full pinned Rapier 3D release build with a persistent-island bootstrap patch, replacing deletion-order rejection guards. Native behavior and old snapshot compatibility are unverified.

- Support sparse glTF MAT2/MAT3 column padding during normalization and GLB inspection; asset behavior remains unverified.

- Preflight 3D physics snapshot lifecycle identities and tick counts before native history reconstruction; replay safety remains incomplete and unverified.

- Preflight one known unsafe two-box initial-removal history before native 3D physics replay; other history risks remain open and behavior is unverified.

## 0.13.0 - 2026-11-08

- Development batch only: built without tests or runtime, browser, GPU, performance, compatibility or recovery validation. The 3D first-step deletion defect and other 1.0 requirements remain open.

- Add dynamic-body rope particle attachments with approximate bilateral reactions and attach/detach operations; runtime and recovery remain unverified.

- Add model-local CCD IK chains with targets, blending and snapshot state; solver and rendering behavior remain unverified.

- Add named additive model animation layers with bone-subtree masks, playback controls and snapshot state; behavior and restoration remain unverified.

- Initialize perspective near-plane media per sample when the camera’s near region may intersect a volume; GPU behavior and cost remain unverified.

- Track closed-medium world winding and orient physical normals for either consistent shell winding, including mirrored instances; GPU behavior remains unverified.

- Initialize orthographic tracing media per sample from closed-shell nesting, with boundary and ambiguity diagnostics; GPU behavior remains unverified.

- Refresh tracing triangle medium IDs when the medium catalog changes without geometry changes; rendering and retry behavior remain unverified.

- Add development-stage orthographic hybrid/path rays, raster-primary sampling and motion reprojection for non-volume scenes; GPU behavior is unverified.

## 0.11.0 - 2026-11-07

- Development batch only: built without tests or runtime, browser, GPU, performance, compatibility or recovery validation. The 3D first-step deletion defect, continuous collision, unified coupling and other 1.0 requirements remain open.

- Add split-step effective-mass and normal-velocity cloth/rigid-body reactions for particles and sampled triangle surfaces; behavior remains unverified.

- Stage automatic cloth reactions until all cloth entries step before applying one sorted physics batch; failure behavior remains unverified.

- Add split-step particle/rigid-body effective-mass and normal-velocity reactions for fluid and soft-body contacts; runtime and stability remain unverified.

- Add optional orientation for manual fluid and soft-body box colliders; collision and snapshot behavior remain unverified.

- Add sampled dynamic oriented box contacts and optional delayed reactions for fluid and soft bodies; runtime, stability and snapshots remain unverified.

- Add split-step rope contact and reactions with dynamic 3D box bodies; runtime and snapshot behavior remain unverified.

- Add cloth contact with live dynamic 3D boxes and optional delayed reactions; native reaction failures report partial state without automatic history replay. Runtime behavior remains unverified.

- Add oriented sampled-box contacts for rope and cloth. Runtime and snapshot behavior remain unverified.

- Add sampled cloth-triangle contacts against axis-aligned boxes; runtime, stability and snapshot behavior remain unverified.

- Add discrete rope-segment contacts against sampled axis-aligned boxes; runtime and snapshot behavior remain unverified.

- Add manually sampled axis-aligned box contacts for rope and cloth particles; runtime behavior remains unverified.

## 0.10.0 - 2026-11-07

- Development batch only: built without tests or runtime, browser, GPU, performance, compatibility and recovery verification. The 3D first-step deletion defect and other 1.0 capabilities remain open.
- CI publishes the explicitly maintained version using OIDC; the npm registry rejects an existing version without a separate registry preflight.

- Track material graph parameter, time and managed GPU resource changes for path/hybrid recapture; runtime rendering remains unverified.

- Add read-only project-lock backup discovery for the explicit migration restore workflow; behavior remains unverified.

- Add per-body 3D gravity scaling with recorded state; runtime and snapshot replay remain unverified.

- Track runtime entity topology and transform changes for tracing recapture; rendering remains unverified.

- Add circle and oriented-box overlap queries to 2D physics; runtime behavior remains unverified.

- Preserve pending tracing recapture across raster frames and mode switches; runtime rendering remains unverified.

- Add optional fixed-clock maximum duration for audio voices; timing and restoration remain unverified.

- Add per-voice volume control and logical voice inspection; playback remains unverified.

- Mark runtime light and material changes for tracing recapture during unchanged draws; rendering behavior remains unverified.

- Add bounded occupied-cell rerouting for waiting navigation agents; runtime and snapshot behavior remain unverified.

- Add per-search temporary navigation obstacles without changing shared grid state; runtime behavior remains unverified.

- Add explicit normalized-time alignment for blended animation clips; runtime behavior remains unverified.

- Add opt-in grid-cell reservations and waiting for navigation agents; runtime behavior remains unverified.

- Add disabled button/input states and accessible UI labels; runtime and assistive-technology behavior remain unverified.

- Add runtime 3D rigid-body world gravity control with history recording; behavior and replay remain unverified.

- Add a composed public-API gameplay recipe covering inventory, equipment, quests, dialogue, camera and saves; runtime behavior remains unverified.

- Retain pending development reloads across coalesced file events and cache hits; watcher behavior remains unverified.

- Add staged tile, navigation and fixed 2D collider synchronization with explicit partial-state diagnostics; runtime behavior remains unverified.

- Add opt-in nonadjacent particle self-contact for soft bodies; behavior and cost remain unverified.

- Add runtime non-graph material surface overrides and snapshot state; raster/tracing behavior remains unverified.

- Add weighted two-clip model animation blending with snapshot state; runtime behavior remains unverified.

- Add configurable global convolution reverb with snapshot settings and dry fallback. Audio behavior remains unverified.

- Add dialogue session variables and equality-gated choices; runtime and snapshot behavior remain unverified.

- Add manual camera poses and fixed-tick camera transitions with snapshot state. Runtime behavior remains unverified.

- Account for collider-center offset in fluid and soft-body reaction torque; runtime behavior remains unverified.

- Align UI input length limits across authored controls, runtime updates and browser IME commits; runtime behavior remains unverified.

- Add entity-following focus for static world chunk residency, with diagnostics and snapshot state. Runtime behavior remains unverified.

- Add named equipment slots, tag restrictions and atomic inventory/equipment transfers. Runtime and snapshot restoration remain unverified.

## 0.9.0 - 2026-11-07

- Development batch only: tests, runtime behavior, graphics, hardware, performance, recovery and snapshot restoration are unverified. The full 1.0 scope remains incomplete.
- Add spatial audio occlusion, localized UI bindings, animated tiles, runtime light overrides, navigation target following and 3D shape sweep queries. Their runtime behavior is unverified.

- Add standard single-gamepad gameplay input, analog sampling, digital action bindings and UI/game capture modes. Hardware and runtime behavior are unverified.

- Add 2D capsule colliders and one-way kinematic character movement with deferred query refresh and snapshot state. Runtime behavior is unverified.

- Add 2D fixed, revolute, rope and spring joints with structured snapshot reconstruction and a fail-closed native recovery boundary. Runtime behavior is unverified.

- Add fixed 2D compound colliders and explicit tile-to-physics synchronization. Collision behavior and failure recovery are unverified.

- Add opt-in 2D rigid-body simulation with box/circle colliders, sensors, impulses, events and structured-state restoration. Runtime behavior is unverified.

- Add explicit tile-to-navigation synchronization and XY-plane grid agents. Runtime behavior and rollback are unverified.

- Add editable entity-bound atlas tile maps with chunked rendering and snapshot state. Collision/navigation coupling and runtime behavior remain unverified.

- Add entity-bound sprite atlas planes, fixed-step frame playback and explicit material alpha blending. Rendering and runtime behavior are unverified.

## 0.8.0 - 2026-11-07

- Development batch only: independent usage, tests, runtime behavior, graphics, hardware, performance, recovery and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add orthographic raster camera configuration for 2D-positioned and 2.5D content; hybrid/path are explicitly unavailable. Runtime behavior is unverified.

- Align the default `create` template and current-directory behavior for source and npm use. Runtime and cross-channel behavior are unverified.

- Generate offline npm game-author recipes from the same asset-free source examples used by the repository. Runtime and cross-channel use are unverified.

## 0.7.0 - 2026-11-07

- Development batch only: tests, runtime behavior, deployment, hardware, performance, resource lifecycle and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Stage build output and preserve an existing dist as a backup before replacement. Concurrent edits and failure recovery remain unverified.

- Add explicit project version-lock planning, backup-based apply and guarded restoration. API and save migration are not included; runtime behavior is unverified.

- Make scene, model and audio teardown continue after individual cleanup errors and preserve diagnostics. Runtime lifecycle and leak behavior are unverified.

- Avoid duplicate main-push build jobs and report immutable npm version collisions as workflow failures. Workflow behavior is unverified.

## 0.6.1 - 2026-11-07

- Development batch only: tests, runtime behavior, browser input, graphics, hardware, performance, stability and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add explicit localization catalogs, locale fallback, template substitution and Intl plural/number formatting. Runtime behavior is unverified.

- Add branching text dialogue definitions, choices and snapshot-preserved sessions. Runtime behavior is unverified.

- Add game-driven quest objectives, prerequisite tracking, completion and snapshots. Runtime behavior is unverified.

- Add stackable items and bounded inventory containers with atomic operations and snapshot state. Runtime behavior is unverified.

- Add dynamic game UI controls, editable layout, and generation-aware input events and snapshots. Runtime behavior is unverified.

## 0.5.1 - 2026-11-07

- Development batch only: tests, runtime behavior, graphics, hardware, performance, stability, and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add grid-following point agents with fixed-tick movement, bounded obstacle/cost replanning and snapshot state. Runtime behavior is unverified; this is not physics or crowd avoidance.

- Allow chunk-owned static prefab roots to be built and removed at runtime, with bounded deferred active-chunk edits and snapshot persistence. Runtime behavior is unverified.

- Add bounded focus-based chunk residency for static prefab roots, including transform/component preservation and host snapshots. Runtime behavior is unverified; this is not asset or dynamic-physics streaming.

- Add optional diagonal weighted grid paths with blocked-corner protection. Runtime behavior is unverified.

- Add model animation clip discovery, pause/resume, seeking and speed control, including snapshot suspension state. Runtime behavior is unverified.

## 0.4.1 - 2026-11-07

- Bundle the accumulated simulation, graphics, asset and API improvements after 0.3.35, including fluid and soft-body forces and manual colliders.
- Add a conservative live-path guard against removal of moving physics bodies before the first physics step. The underlying issue and historical snapshot risks remain open.
- Build-only development release: runtime, hardware, stability, performance, and snapshot behavior have not been verified. This does not declare M4 or the complete engine finished.

- Normalize sparse GLB accessors for inspection, optimization and model loading.
- Extend GLB material handling with emissive strength and texture transforms.
- Improve fluid and soft-body binding, presentation and state lifecycle.
- Add an animation clip starting-time option.
- Build-only development; runtime, hardware, performance and snapshot behavior remain unverified.

## 0.3.34 - 2026-11-07

- Added a soft-body sphere-binding example.

## 0.3.33 - 2026-11-07

- Added a dynamic sphere binding and approximate reaction option for soft bodies.


## 0.3.32 - 2026-11-07

- Added the public `ctx.softBodies` service backed by the bounded CPU tetrahedral XPBD reference solver.
- Added dynamic soft-body surface presentation and automatic fixed-step scheduling.
- Refreshed fluid body bindings before every automatic tick instead of sampling only at creation.
- Build-only release; runtime, stability, performance, rendering, and snapshot compatibility remain unverified.

## 0.5.0 - 2026-11-06

- Added optional fluid binding to one dynamic sphere with fixed-step WCSPH sampling and approximate reaction impulse submission.
- Added fluid particle presentation and the fluid-basin example.
- This release is build-only; fluid runtime, stability, performance, rendering, and snapshot compatibility were not verified.

## 0.3.31 - 2026-11-06

- Made cloth and rope reaction batches recoverable: a failed native action rebuilds physics state and history from the pre-batch snapshot before the host fault is reported.
- Build-only release; runtime rollback behavior was not verified.

## 0.3.30 - 2026-11-06

- Restored cloth binding definitions together with solver state when an automatic cloth tick fails, preventing destroyed-body pruning from surviving rollback.
- Build-only release; runtime and snapshot behavior were not verified.

## 0.3.29 - 2026-11-06

- Rewrote the public release and status documents as clean standard-version documentation.
- Preserved the current unverified/build-only boundary; no runtime, stability, performance, or snapshot claim was added.

## 0.3.28 - 2026-11-06

- Consolidated the release notes, development status, API index, version locks, and example locks.
- Removed duplicate and malformed release entries.

## 0.3.27 - 2026-11-06

- Cloth triangle-surface contacts support sampled spheres and planes with discrete projection and reaction output.

## 0.3.26 - 2026-11-06

- Cloth body bindings support the explicit bodyReactions option for approximate reaction impulses; it is disabled by default.

## 0.3.25 - 2026-11-06

- Cloth body binding creation, world preflight, and snapshot restore now reject stale or non-physical bindings.

## 0.3.24 - 2026-11-06

- The cloth example uses the dynamic sphere binding API instead of manual static sampling.

## 0.3.23 - 2026-11-06

- Automatic cloth stepping can sample live dynamic non-trigger spheres as one-way moving obstacles.

## 0.3.22 - 2026-11-06

- Cloth triangle-surface contacts support sampled spheres with closest-point projection.

## 0.3.21 - 2026-11-06

- Historical cloth snapshots without selfCollisions restore in legacy particle-only mode.

## 0.3.20 - 2026-11-06

- Cloth self-collision state migration and snapshot validation were corrected.

## 0.3.19 - 2026-11-06

- Added discrete non-adjacent cloth particle self-collision with a switch and snapshot state.

## 0.3.18 - 2026-11-06

- Added the triangular cloth foundation: distance constraints, approximate bending, anchors, forces, sampled contacts, host snapshots, and dynamic mesh presentation.

## 0.3.17 - 2026-11-06

- Added discrete non-adjacent rope self-contact with broad-phase filtering.

## 0.3.16 - 2026-11-06

- Added discrete rope segment and sphere contact.

## 0.3.15 - 2026-11-06

- Added segmented rope presentation that follows simulated particles.
