# M4 首步前删除物理实体缺陷

> 后续实现补充：每个 production World 和回放候选各自创建 JS 绑定闭包及 WASM 线性内存，仅共享编译代码。shape/ray/joint descriptor 也由所属实例创建，候选不在活动堆中重放。原生失败的活动 owner 进入 requiresRecovery 状态。该隔离设计和释放/旧快照行为未运行验证，不代表完整安全验收。

> 2026-11-08 实现更新：按用户要求将验证后置，从锁定 Rapier 源码加 bootstrap-before-observations.patch 重新编译完整 release WASM 与官方 TS 绑定，生产入口改为 packages/physics/rapier.ts；npm 同包携带相同私有产物。实时首步删除和两盒体历史拒绝保护已移除，采用底层岛初始化顺序补丁而非延迟删除。类型/构建结果不证明当前二进制行为正确、旧 v3 字节兼容或完整恢复安全；下方实验仍是历史证据，不得转记为当前构建通过。旧夹具未修改，任意历史的隔离与故障后回收仍待完成。

## 历史缺陷记录

以下状态、拒绝保护与实验结论对应其原始提交；上方原生补丁、独立内存和当前结构预检已替代旧实现，运行验收仍未完成，不将历史证据转记为当前通过。

历史状态：已在真实游戏和插件层复现，未修复；不属于 M4 验收通过项。优先保持现有物理行为、即时查询和快照可信，不使用推进正时间或只消除异常的替代方案。

当前源码增加了一个纯数据预检：两个初始动态盒体的包围球明确分离，且历史首次步仅删除先创建体、未创建新体时，在分配候选 Rapier World 前以 `TC_PHYSICS_SNAPSHOT_UNSAFE_HISTORY` 拒绝回放。它可能拒绝符合该形态但原本能够恢复的旧快照；不覆盖其他形态，也不修复实时首步删除。旧 v3 夹具没有修改。按 D50/D58 未运行隔离复现或旧快照回归，因此不能宣称已验证兼容、安全或修复缺陷。

另在原生分配前核对历史里的实体创建、移除、活动帧、物理类型和步数与快照头部是否一致，并检查绑定是否属于活动刚体；不匹配时报 `TC_PHYSICS_SNAPSHOT_HISTORY`。这是结构性拒绝，不校验来源或可信性，结构一致的恶意历史仍可能触发 WASM 缺陷。新旧快照兼容性和拒绝行为尚未运行验证。

## 可复现入口

- `npm run probe:physics-first-removal`：独占 GPU 的公开游戏链路，`examples/physics-first-removal` 在首 tick input 阶段先射线查询、再删除动态刚体；预期 physics 阶段正常推进并且 postPhysics 查询看不到已删除实体。当前失败，报告 `evidence/m4/development/first-removal-before-1793887996301/physics-first-removal.json` 中为 `TC_RUNTIME_SYSTEM`、`stage=system:$engine.physics`、`unreachable`。启动和失败报告记录的后端是真实 NVIDIA WebGPU。
- `node node_modules/tsx/dist/cli.mjs --test tests/physics-first-removal-regression.ts`：插件级回归，当前预期失败；初始射线和销毁后的即时射线已通过，首次步进入 Rapier 时报 `RuntimeError: unreachable`。文件名故意不匹配 `*.test.ts`，避免把已知未修复问题当作日常通过项；修复时应纳入正式测试集合。
- `node node_modules/tsx/dist/cli.mjs tests/physics-initial-remove-regression.ts`：独立 Rapier 0.21 最小复现，不依赖游戏接口。既有日志在 `evidence/m4/development/angular-1793887575482/open-defects/physics-initial-remove.log`。
- `npm run probe:physics-zero-init`：18 个独立进程的动态／固定／运动学组合与先前正常步对照。记录 `evidence/m4/development/zero-init-matrix-1793888885591/physics-zero-init-matrix.json`：首次正常步前删除动态或运动学体、且另一体是动态或运动学的 4 组陷阱；其余 14 组本次未触发陷阱。未陷阱不证明碰撞、睡眠或快照正确。

## 已排除方案

- 额外零 dt 物理步、原生快照往返、先删除 collider、让待删体休眠、重设运动学状态、替换 broad/narrow phase 或 CCD solver，仍触发崩溃。
- 删除前替换 `IslandManager` 可消除最小崩溃，但实测已有动态体可出现速度非零、位置不变，漏掉碰撞和事件；唤醒或禁用再启用不能可靠恢复。不得采用。
- 按可见位置、旋转、线速度、角速度和睡眠状态重建整个 World，初始接触、睡眠、碰撞事件及原生快照不同；不能作为通用等价恢复。
- 把初始化改为正时间预步、要求游戏先运行一帧或延迟销毁，会改变已定义的游戏时间、即时查询或结构提交语义，不能视为修复。
- 零 dt 期间临时把刚体改为固定体虽然绕过最小陷阱，但即使 collision types 为 ALL，初始碰撞开始事件也从零步推迟到首个正常步；另有睡眠状态改变和速度归零反例。先临时禁用／改型运动学体再恢复会错误地产生碰撞结束、重新开始事件。不能采用。
- 独立查询镜像与未预步的权威 World 是待研究方向：原生实验能先删除再正常步，但初始重叠体删除时旧流程有碰撞开始／结束事件，未预步流程没有；角色控制也依赖已建立的查询结构。镜像需明确事件去重顺序、碰撞体映射和旧快照重放语义，现阶段不足以安全落地。

下一步应研究仅针对首次正常 step 前的可验证拓扑重建／查询架构，或寻找可复验的底层修正。必须同时覆盖初始接触及事件、删除前冲量、睡眠、多个动态／运动学／角色、即时射线、动态创建、原生快照与历史重放、失败原子性，再让上述插件和真实游戏回归均通过。没有验证的路径保持开放。

## 内部原型

独立工作树 `threecat-worktrees/m4InitRemoval` 有尚未合并的受限候选：引擎在内部保存零步前的可信 native 状态，在首次正常步前的部分移动体删除场景重建，按历史重放之前的冲量等操作，再同步拓扑。外部传入的快照字节不直接交给 Rapier。36 项聚焦 CPU 检查覆盖初始碰撞事件、角色移动、先前冲量／角冲量、多个删除、同 ID 重生、history 重放及构造失败资源释放；常见固定体删除与仅剩固定体的旧路径对照保持字节一致。

候选**没有解决全部兼容性**：触发条件仍是当前样本的近似，且某些旧实现本来能成功的移动体删除场景可能被新重建覆盖，导致旧 v3 快照的 native 字节不一致。必须先建立旧 v3 恢复及新策略版本边界，安全处理不可信历史和可能的 WASM trap，再合并主线并执行真实游戏回归；当前主线物理实现未修改，缺陷仍开放。

## 真实旧快照兼容门禁

新增 `npx tsx tests/physics-first-removal-isolation.ts`，每种情况放入独立子进程：两份真实 v3 夹具须逐字节恢复，篡改但结构合法的 history 须安全、原子地拒绝。当前前两项通过，第三项触发 WASM 借用错误并使子进程以 Windows 状态码 `3221226505` 退出，命令整体明确失败；该诊断不是修复，也不应纳入默认通过计数。

已由主线原实现生成两份真实 v3 快照，保存在 `tests/fixtures/physics-v3/`：不相交动态刚体删除后创建体，以及初始接触动态刚体删除先创建体。两个场景均在首步前对幸存体设置线速度和力矩冲量。`tests/physics-v3-snapshot-compat.test.ts` 验证原生快照逐字节恢复、位置／角速度和恢复后继续步进；这两份夹具与旧的物理操作不得随修复重新生成。

当前主线 33 项相关物理测试和类型检查通过，证据 `evidence/m4/development/v3-compat-1793890561898/result.json`。同一测试对未合并原型的两个用例都以 `TC_PHYSICS_SNAPSHOT` 失败，日志同目录 `candidate-v3-failure.log`；因此不合并该原型。

旧版安全性不能只按删除顺序判断：不相交的两个动态体删除先创建体可导致 Node 进程以 `3221226505` 退出，删除后创建体正常；初始相交时两种删除均可正常。不能在主 WASM 实例中对不可信旧 history 乐观试跑后指望 catch；也不能直接把调用方的 native bytes 交给 Rapier。后续必须设计可验证的隔离回放／兼容方案，或找到不改变旧状态语义的底层修正；同时保留此 v3 夹具和原先的失败复现。

## 上游与隔离核查

2026-11-05 核查 npm 注册表：`@dimforge/rapier3d-compat` 最新稳定版为当前锁定的 `0.21.0`，canary 为 `0.0.0-b716d37-20260925`，两者登记的 gitHead 均为 `b716d375efc0201003f0cd9ef7168eee0b62c177`。下载 canary 包到项目内临时目录后，`rapier_wasm3d_bg.wasm`、`rapier.mjs`、`rapier.cjs` 与当前安装包逐文件 SHA-256 均相同；WASM 哈希 `17cfa80eebd8de0291b948496dbffba724b98b489687f8272ca236a7bbf1dd4b`。因此仅切换这个 canary 不会改变当前复现；未更改引擎依赖。

官方 Rapier PR 1012 明确记录了零时间步导致模拟状态损坏的修复，其合并提交是上述 npm 包提交的祖先；这不证明本项目“零步后删除移动体”的独立崩溃已经修复。按锁定包实际运行结果判断，不将上游相关说明当作本问题通过证据。

隔离执行研究：Node 子进程可提供比同进程 WASM 更强的故障边界；浏览器主线程不能同步阻塞等待 Worker。仅让 Worker 预检、再在主线程重放同一危险历史仍需证明两次执行完全一致；更稳妥的完整隔离恢复会涉及 Host／插件异步契约调整，且不能把用户提供的原生字节直接视为可信。当前没有为此增加 COOP／COEP 或玩家环境限制，也没有改变公开同步接口。

`npx tsx tests/physics-wasm-host-isolation-experiment.ts` 在独立子进程记录实验：样本中放弃受损 world 后另一 world 可步进，释放受损 world 则抛 Rust 借用错误；独立模块 URL 在样本中也能让另一实例继续，但受损实例回收、浏览器打包与可信状态迁移均未证明。放弃受损 world 会泄漏，不能作为修复；脚本输出各子进程状态，整体退出码不是缺陷已修复的验收信号。

### 锁定源码的根因假设

对 npm gitHead `b716d375efc0201003f0cd9ef7168eee0b62c177`（Rapier 0.36.0 Rust 源码）的只读研究发现：零 dt 已处理刚体修改并进行碰撞检测，但首次正步才 bootstrap persistent islands。`src/dynamics/island_manager/manager.rs` 的首次 `update_islands` 在 bootstrap 后消费此前采集的睡眠观测；bootstrap 在 `persistent.rs` 重建岛 ID，而睡眠扫描用观测中的旧 ID 索引。删除先创建的分离动态体会使幸存者旧 ID 与重建后 ID 空间不同，能解释已复现的删除顺序差异；若 ID 未越界但指向不同岛，也可能产生错误睡眠判断。隔离实验中原生快照往返不消除该陷阱，而先进行正步的对照可运行。

这是依据锁定源码和有限复现形成的最强假设，**不是带符号 WASM 栈证明的最终根因**。JS 公开 IslandManager 仅暴露遍历，尚未发现可安全触发 bootstrap 或重映射观测的接口。候选底层修复应在观测采集前完成 bootstrap，或 bootstrap 后重新采集；需重建可复验 WASM、验证释放和旧 v3 精确快照，并覆盖接触、睡眠、关节及动态创建。不能通过扩大数组或忽略无效 ID 假装修复。

### 隔离候选补丁结果

项目内 `.pelican/m4-rapier-wasm-lab/` 使用 Rust 1.99.1 GNU、MSYS2 GCC 16.2.0、wasm-bindgen 0.2.130，从锁定 `b716d375efc0201003f0cd9ef7168eee0b62c177` 构建原版和候选 WASM。`bootstrap-before-observations.patch` 在首个睡眠观测之前完成 persistent island bootstrap；候选在匹配 glue 的子进程对照中通过零步删除、碰撞事件、睡眠/动态创建以及两份 v3 插件历史重放，原版零步删除和睡眠/创建按预期触发带符号 `panic_bounds_check`。两份 v3 native bytes（2656/2752 字节）恢复和继续步进与原版逐字节一致，完整报告为 `REPORT-v3-replay.md`、`final-regress-results.json` 和 `v3-replay-results.json`。

这仍不是可合入生产的修复：候选是 instrumented test adapter，不是官方 npm compat 包；未覆盖浏览器 glue、完整关节/睡眠/碰撞/动态场景、性能和全游戏；上游编译还有 unused-argument warnings；任意不可信 history 的失败清理和受损 WASM 回收尚未证明。生产依赖保持 Rapier 0.21.0 不变，候选补丁不得在未完成这些门禁前替换它。

### 浏览器隔离对照

真实 headless Chromium 156 中另行运行 original/candidate 三个场景，每个场景使用独立进程与浏览器 WASM，未启用 GPU。原版在零步后删除和 sleep/create 场景触发 `panic_bounds_check`；候选完成这两项，单个重叠碰撞场景的开始／结束事件与原版一致。正常完成的四次执行中 world 和事件队列的 `free()` 未抛错；陷阱后直接结束进程，没有执行回收，因此不证明恢复安全或无泄漏。报告、脚本与逐场景日志保存在 `.pelican/m4-rapier-wasm-lab/browser-independent-202611/`；脚本使用原实验目录和本机 Playwright 的绝对路径，复跑前应核对路径及报告中的哈希。

该对照使用实验构建及内存改写的浏览器加载器，不是官方生产 compat 包或游戏插件集成；不能据此认定浏览器生产 glue、任意关节/历史、资源回收或完整 M4 已通过。生产依赖和上述未完成门禁不变。

### 独立 Worker 边界实验

使用当前安装的 Rapier 0.21.0，在真实 headless Chromium 中分别触发并终止十个陷阱 Worker；另一个独立的长期 Worker 在前后均可创建、步进并释放自身 world 与 queue，前后生成的 2643 字节快照一致。复跑脚本、说明与本次结果保存在 `.pelican/m4-rapier-wasm-lab/worker-history-isolation-20261106/`。实验未使用外部 native bytes，控制组也不在引擎主线程中。

这只证明有限条件下独立 Worker 的执行隔离：未测量被终止 Worker 的内存回收，未实现插件 history 隔离回放、状态迁移或同步 API 的原子恢复，也不证明其他浏览器和生产打包路径可用。不能把它作为该缺陷的修复。

### 插件 API 子进程对照

`.pelican/m4-rapier-wasm-lab/plugin-api-comparison-20261106/` 保存了对实验 original/candidate 适配器的插件级对照。一个恶意 v3 history 样本中，候选的 `validateSnapshot` 和 `restore` 均返回 `TC_PHYSICS_SNAPSHOT`，活动快照保持不变，之后步进和 dispose 返回；original 实验适配器返回 Rust 借用错误，但该次子进程继续运行。另一个首步删除样本中 original 陷阱退出，候选完成步进、射线查询、快照验证/恢复及 dispose。此前使用生产 compat 包的相似恶意历史实验则发生进程异常退出，两种构建和执行上下文不可混为同一结果。

这些结果不证明任意历史安全、受损 WASM 内存回收或生产包与浏览器集成；对照驱动因 original 失败按设计退出非零，生产依赖未替换。

后续扩展的插件级隔离矩阵记录在 `.pelican/m4-rapier-wasm-lab/plugin-compat-matrix-20261106/`：候选 8/8、original 5/8；包含两份旧 v3 恢复及后续 native 字节对照、接触开始/结束、同 ID 重生、一个实验关节插件场景、恶意 history 和首步删除。关节场景使用单独的未公开候选插件，不能与现有主线关节能力混同。插件级 sleep/wake、广泛关节类型、真实内存回收、浏览器 bundler 和生产 compat 包仍未验证；这是插桩本地 WASM 对照而非修复或生产兼容性证明。

### Compat 发布形态实验

历史实验目录 `m4-compat-release-lab-20261105-1793940353` 曾以锁定 Rapier 源码、补丁、wasm-bindgen 和 Rollup 手工构建接近 npm compat 的 3D 子集，并记录构建输入、许可证、哈希及子进程输出。有限对照中原版首步删除陷阱、候选完成，两份旧 v3 快照及后续 native 状态哈希两版一致；同一恶意 history 重复 1000 次时，候选稳定拒绝并保留活动世界，原版出现所有权错误与后续陷阱。WASM 容量不是活跃内存，不能以此证明无泄漏。原始实验树已在单线收敛时移除；本段保留历史结论，不表示实验可复跑或候选可合入。

此实验并非完整上游发布流水线，候选仍有四条编译警告；浏览器、完整引擎及游戏集成、原生内存分配和跨机器二进制复现尚未通过。该目录包含独有构建与日志，在成果迁移并核对前不得清理；生产 Rapier 依赖仍未更换。

随后在该实验目录 `browser-e2e/runs/2026-11-06T05-13-38.959Z/` 执行真实 headless Chromium 插件对照，校验了两种 bundle 实际实例化的 WASM 哈希。original 首步删除后陷阱，且插件 dispose 报 Rust 借用错误；candidate 完成首步、快照验证/恢复和 dispose。浏览器恶意快照拒绝、内存回收及正式引擎/游戏集成仍未覆盖；context 关闭不证明 native 资源完全释放。该对照不能授权替换正式依赖。

历史隔离目录 `m4-browser-malicious-v3-20261105` 曾在真实 Chromium 中对照恶意 v3 history：candidate 返回 `TC_PHYSICS_SNAPSHOT`，活动快照与状态不变，随后步进、验证和释放调用返回；original 返回 Rust 借用所有权错误。该结果只覆盖一个变造历史；未覆盖浏览器重复调用、原生内存回收、其他浏览器或完整游戏，不能据此替换生产依赖。实验树已在单线收敛时移除；本段保留历史结论，不表示当前源码通过。
