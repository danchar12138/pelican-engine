# M3 受管理计算任务

状态：首条公开 API 到真实 GPU、固定 tick、回放/恢复链路已集成并通过针对性开发验证；不是 CAP-17/M3 正式验收。331 项受影响测试通过，另有浏览器销毁与验证选择器的局部跟进；类型检查通过。20 次微型 GPU 派发覆盖全类型/反馈/参数/负例/释放，公开反馈游戏覆盖输入、快照/回放、设备重建、原生键盘和 WebGL2 不执行分支。未重跑整套 M3、1080p 或 npm 安装矩阵。

本轮证据在 `evidence/m3/development/managed-compute-1793864698588/`，摘要记录执行范围及未执行项。源码快照为 `6991658e75b93d46b60b989af7e900a745b1a0d7adb2b1e02b1d641402de9042`，是增量关联记录，不是完整冻结验收。各 XML 计数有重叠，不相加冒充额外覆盖；真实 GPU 报告与 CPU 夹具明确分开。

本任务落实 CAP-17 的计算、反馈、越界及生命周期契约，不代替整个 CAP-17 或 M3 验收。产品范围不变，继续使用唯一 pelican-engine SDK；不暴露 GPU/Three/着色器源码。

实现顺序：固定 SDK 和私有 executor 契约；独立 worktree 实现状态所有者与真实 WebGPU executor；主线扩展类型化图与编译诊断、接入浏览器 tick/恢复/清理，再串行执行硬件和 npm 验证。

按最新 D49：本轮先做受影响模块类型/单元测试，再一次小规模真实 GPU 反馈及失败链路；不逐次跑整个 M3/1080p/质量矩阵。npm 分发本轮未改通道机制时复用既有分发证据，只在新接口实际打包冻结时补一次渠道验证。全量门禁留到稳定候选，不能拿局部通过宣称 M3 完成。

## 契约

- `compute.createBuffer/resolve/describeBuffer/readBuffer/writeBuffer/releaseBuffer` 管理有代数身份的缓冲区；值支持 float/vec2/vec3/vec4/bool，输入/返回数据分离，名称唯一。read 返回上次成功提交结果，write 先完整校验再改变状态。
- defineCompute 声明具名只读输入缓冲绑定及其值类型。图 readBuffer 的索引必须为 float 表达式，实际读取时要求有限整数和有效范围。材质域不允许此操作。每个 dispatch 写一个与 kernel count/outputType 相同的输出缓冲；输出允许同时作为输入，语义为读取派发前快照后原子提交结果，不是原地并发写。
- dispatch 返回任务句柄，状态 queued/running/succeeded/failed/cancelled。游戏系统保持同步；引擎在每个固定 tick 后等待私有 flush，再进入下一 tick。只有完整成功且所有者未过期的 GPU 结果进入 CPU 镜像；失败/取消不写输出。
- shader 负责索引越界及非有限结果诊断，不靠 WebGPU 越界零值伪装成功。参数、绑定、类型、尺寸和真实适配器限制在提交前校验。WebGL2 dispatch 明确拒绝，没有 CPU 伪装 GPU 的回退。
- CPU 镜像用于检查点与重建，GPU executor 复用受管理输入资源并按版本上传。释放资源/任务有明确规则；涉及未结束任务的资源不可修改或释放。任务终态可显式 release，防止历史无限驻留。
- 快照要求没有未结束任务，包含缓冲定义/已提交值及 kernel 契约。恢复先完整预检，成功后使旧缓冲/任务句柄失效，可按名称 resolve；不自动保留游戏闭包中的旧句柄。设备更换保留已提交 CPU 值，取消旧任务，销毁旧 GPU 缓存。

## 并行写入范围

主线：SDK、compiler/types/normalize/graph、graph-expressions、browser、host/plugins、文档集成。
状态工作树：runtime/compute-service.ts 及专属单元测试。
GPU 工作树：renderer/compute-executor.ts、专属单元测试和硬件探针。

完成证据要求：全类型真实 GPU 结果、跨派发反馈、同缓冲读写、动态参数、错绑定/越界/非有限值、取消/销毁/设备丢失、快照恢复、资源计数、普通游戏系统调用及 npm 同一接口。尚无证据的条目继续保持未验收。

当前限制：任务结果逐次读回 CPU，不冒称完全无读回。后续增量已接入 [受控渲染槽](M3-COMPUTE-RENDER.md)、[显式依赖链](M3-COMPUTE-DEPENDENCIES.md)、[片元/后处理缓冲](M3-FRAGMENT-BUFFERS.md)、[计算纹理核心](M3-COMPUTE-TEXTURES.md)、[直接纹理渲染及资产导入](M3-RENDER-TEXTURES.md)、顶点图和后处理的首条链路；完整通道/故障矩阵仍待完成。npm 旧编译暂存和 tarball 属于此前基线，未随每个本地增量重包/安装。稳定候选再集中补齐必要渠道与发布门禁。
