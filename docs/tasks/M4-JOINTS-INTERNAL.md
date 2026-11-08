# M4 内部关节切片

> 2026-11-08 当前实现：生产 physics 插件新增 createJoint/destroyJoint/inspectJoint/listJoints，包含 fixed、ball、revolute、prismatic、rope、spring。关节操作写入历史，绑定体删除时清理；新 v3 快照使用可选 joints 字段，旧无关节快照布局保留。底层使用补丁原生构建，每个世界/候选使用独立 WASM 内存，不采用历史候选跳过 free 的共享陷阱策略。按用户最新要求只编译/构建，未运行关节、回放、旧 v3 兼容或释放验证。下文是原始历史记录，不代表当前实现验收。

状态：内部实现与 CPU 验证，非公开 API、非 M4 验收。`packages/physics/joints-internal.ts` 基于 Rapier 构建 fixed、revolute 和 ball 约束，验证固定/动态及动态/动态刚体对、局部锚点/轴/框架、定义快照重建和非法输入，并支持查询、按 ID 删除与按实体清理。`tests/physics-joints-internal.test.ts` 12 项通过，旧 v3 夹具 2 项通过；类型检查通过。批量清理先检查所有关联关节，但底层原生删除异常时不保证事务原子性。

当前没有将该注册器接入现有 physics 插件、公开 SDK、固定 tick 生命周期、游戏资源或 v3 快照。其内部快照只包含关节定义且只支持空注册器恢复，不保存刚体状态，不代表旧快照兼容或可被游戏使用。首步删除和不可信 history 缺陷仍独立开放；接入时必须设计具版本边界的完整状态与删除/恢复语义，再验证真实游戏。

## 公开接口候选与阻塞

独立 worktree `threecat-worktrees/m4-joints-integrated-20261105` 将关节创建、删除和定义恢复按顺序写入物理 history，并覆盖关节步进、恢复、角速度交错和旧 pelican v3 夹具；另一个 Host 隔离实验确认缓存的嵌套 `physics.joints` 必须经异步服务代理。候选尚未合入主树，正常路径测试不能替代快照错误安全验证。

对现有 `tests/physics-first-removal-isolation.ts` 的隔离复验中，两份旧 v3 快照在基线和候选均可重放，但恶意删除历史在两者均使子进程异常退出。候选还修改共享 `validate()` 的 WASM 陷阱处理：跳过回收并重新抛出异常，改变了无关旧历史的行为且不能证明无泄漏。不得将该候选视为可直接集成的公开能力；需要先解决不可信 history 的隔离与回收，保留旧快照行为，并在真实 Host 的异步 step/replay、实体删除及生命周期中复验。详见 [首步删除缺陷](M4-FIRST-REMOVAL.md)。
