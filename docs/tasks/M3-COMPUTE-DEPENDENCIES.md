# M3 显式计算依赖与任务结果版本

实现 CAP-17 已确认的受管理计算能力，不新增范围，不替代正式 M3 验收。

状态：实现及受影响验证通过，未发布。证据为 `evidence/m3/development/compute-dependencies-1793881620000/summary.json`，源码指纹 `ac02133bc1d71f935839599493cef6c7fd285c28de45d7d076d3caff8ed97efe`。

后续 [片元/后处理缓冲](M3-FRAGMENT-BUFFERS.md) 已取得独立增量证据；下文的待完成描述记录本任务当时边界，不覆盖后续状态。

## 不变与新增语义

- 普通 ComputeBufferHandle 绑定仍在 dispatch 时捕获输入，多个同 tick 派发不隐式变成读前一任务的结果。
- bindings 的 `{ task: ComputeTaskHandle }` 显式引用该任务的成功输出版本，自动成为依赖；`after` 添加纯顺序依赖，不刷新普通缓冲绑定。参数与 time 仍在 dispatch 时固定。
- 只能引用同 owner 中已经创建、尚未 release 的较早任务，不能前向、自引用或跨恢复/跨 owner 使用，因此新任务的依赖图天然无环。重复 after 应去重，不保留额外引用。
- 前置 queued/running 时下游继续 queued；执行前检查前置必须 succeeded。前置 failed/cancelled 或结果源缓冲已经释放时，下游给 TC_COMPUTE_DEPENDENCY_* 确定失败，不提交输出，不调用 GPU 执行器，不消费旧缓冲。取消 owner/更换 executor 使未完成整链失效。
- 引用任务的确切输出而非“源缓冲当前值”。CPU 所有者保留已成功结果的不可变镜像，executor 在终态任务 release 及下游结束前保留所需 GPU 版本；读后续覆盖之前的版本不经 CPU 重新上传。
- 上游仍被未完成下游引用时 releaseTask 拒绝 TC_COMPUTE_TASK_IN_USE。终态结果源缓冲可以按原规则释放；新的 task-result 读取会明确拒绝已释放源，已排队读取则通过 busy 引用保护该缓冲。快照仍不序列化任务及未完成图，恢复清空旧任务句柄。
- flush 使用稳定队列顺序，成功提交点和既有 CPU/GPU 候选校验不变；所有保留版本通过 collect 统一回收。collect 接受同 key 不同 revision，重复 key/revision 仍拒绝；释放后 GPU 版本与 CPU 引用都不能无限残留。

## 执行安排

主线负责公开契约、executor 多版本回收、集成与小型真实 GPU DAG/像素验证。独立 worktree 只修改 compute-service 状态/引用计数及专属 CPU 测试。Windows 开发政策与全局依赖不变。

按 D49 只做相关状态/版本/失败契约、类型检查和一个小型真实 DAG 链路；不跑全 M3、1080p 或每增量 npm 安装。GPU 任务依次执行和每节点读回仍存在，不宣称一次批量 GPU 提交或 GPU-only 存档。计算纹理、片元/后处理 buffer、完整失效/质量矩阵、独立 AI 与稳定候选发布继续待完成。

## 验证结果

- 162 项受影响测试通过，零跳过；统一类型检查通过。覆盖精确旧版本、分支/合流、普通快照语义、严格引用检查、busy/refcount、失败传播、恢复和晚到结果。
- 一条 320×240 NVIDIA 非回退 WebGPU 游戏链路通过。源被覆盖为 -7 后，分支仍从指定结果 -7.9 计算为 -7.7；普通句柄加 after 得到派发快照 -8 + 0.4；跨 flush 继续读旧任务得到 -7.4。
- 初始渲染检查点及普通输入共两次上传，随后保留版本读取不增加上传；顶点后处理像素为 `[203,203,203]`，独立几何距离推导预期为 203。渲染未上传 CPU 计算结果。
- GPU 越界和取消的下游均以 `TC_COMPUTE_DEPENDENCY_FAILED` 失败，只有独立任务增加提交，不改变最终渲染缓冲。释放任务记录使 GPU 历史版本/缓冲从 8 个回到 4 个当前输出。
- 快照恢复后重建链路、异步回放和最终零资源清理通过。设备替换及失效引用由本次 CPU 契约验证；未重复上一增量的完整硬件设备重建、三模式或 WebGL2 矩阵。
