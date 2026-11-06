# M3 受管理计算纹理

本增量落实 CAP-17 的真实 GPU 纹理采样/写入与依赖反馈。M3 和整个首发范围仍未验收。

状态：实现及受影响验证通过，未提交/发布。证据 `evidence/m3/development/compute-textures-1793884431902/summary.json`，源码指纹 `c97ff03b522fffd994f457cfb452ed3f116cb67699579305d6ecb1d6f563241a`。

后续 [直接纹理渲染与资产导入](M3-RENDER-TEXTURES.md) 已完成独立增量验证；本任务下文的限制记录当时边界。

## 冻结契约

- 公开 `ComputeTextureHandle` 为 owner/index/generation/kind:"texture"，与普通缓冲句柄分离；ID 在两类资源间唯一。`ComputeTextureInput` 为 id/width/height/data?，数据是线性 rgba32float 的行优先 Vec4 数组；不进行隐式颜色空间转换。宽高为正整数，总 texel 数不超过 2^24，并服从真实设备限制。
- compute 服务增加 createTexture/resolveTexture/describeTexture/readTexture/writeTexture/releaseTexture；writeTexture 支持整图或显式 x/y/width/height 矩形，完整预检后递增 revision。缓冲 API 不接受纹理，纹理 API 不接受缓冲。
- defineGame.computeTextures 可声明首帧纹理。defineCompute.textures 为具名采样槽，filter nearest/linear（默认 linear），wrapU/wrapV clamp/repeat/mirror（默认 clamp）。计算域 sampleTexture 引用声明槽，不隐式读取 Three 资产对象。
- dispatch.output 可为缓冲或纹理；纹理输出要求 vec4，kernel.count 必须等于 width*height。textures 绑定接受纹理句柄或 {task} 的确切纹理结果；buffers 和 textures 不能互换，after/失败传播/引用计数沿用现有协议。
- ordinary 纹理绑定在 dispatch 捕获 revision/CPU 镜像，task-result 在执行前解析确切版本。保留历史和释放、源忙保护、取消/更换 executor/恢复及晚到结果与缓冲一致。
- 私有普通输入描述符带 captured:true，表示 owner 认证的派发时 CPU 检查点；如果更早的纯输出任务已覆盖未上传的初始/CPU 写 revision，executor 可恢复这个检查点而不错误拒绝回退版本。已有精确 GPU 版本仍优先复用；无此私有标记的未知旧版本仍拒绝，task-result 不使用此标记。该字段不进入公开接口或快照。
- 计算图输入 pixelCoord/outputSize/uv 分别为输出整数像素坐标、输出宽高与 texel 中心归一化坐标。缓冲输出视为 count×1；index 仍是线性整数索引，time 规则不变。
- GPU 采样用真实 texture_2d<f32> + textureLoad 实现显式最近/双线性与寻址，无 rgba32float 硬件过滤特性依赖。非有限 UV 置 fault 位4，失败 TC_COMPUTE_TEXTURE_COORD；越界 UV 按声明寻址，不截断成未声明质量模式。
- 纹理输出同时由同一 compute shader 写 GPU storage texture 和 packed vec4 buffer；后者仅供已有结果读回验证及后续原生数据桥。成功前两者均为候选，校验后同一 revision 原子发布；失败/取消不得发布任何一半。不得把 CPU 结果 writeTexture 上传伪装 storage 写入。
- executor 纹理/缓冲共享版本缓存，描述符的可选 texture:{width,height} 区分资源形状；纹理 revision 的双 GPU 表示同时保留/收集/销毁。textureResident 是 renderer-private，公开 SDK 不暴露原生句柄。
- CPU 快照仍为 version1；buffers 条目可选 texture:{width,height}，有此字段必须 type vec4/count width*height。旧快照形状不变，恢复后旧两类句柄均失效。材质缓冲 peer 不能把纹理伪装成普通缓冲。

## 并行与证据

主线维护 SDK/IR/private contracts、编译与图输入、browser 初始资源、示例/小型真实 GPU 链路。runtime worktree 只写 compute-service 和专属 texture-owner 测试/文档；executor worktree 只写 compute-executor 和专属 texture-executor 测试/文档。主线统一类型检查和受影响测试，GPU 串行。

本次交付先贯通纹理生成→确切版本采样/反馈→已有缓冲渲染槽与快照/设备重建，证明真实 GPU storage/sampling。材质/后处理直接纹理槽和资产纹理导入仍按完整方案继续接入，不冒称本增量已覆盖所有纹理使用路径。D49 不逐次重包/安装或跑完整 M3/1080p。

## 实际验证

- 393 项受影响测试通过、零跳过；统一类型检查通过。覆盖纹理 API/矩形写入/资源种类、精确依赖、捕获初始值、成对候选和回收、GPU 布局/着色器结构、错误与晚到任务、编译及现有异步边界。
- 一个 320×240 NVIDIA 非回退 WebGPU 场景完成 2×2 生成/同纹理反馈、覆盖后的旧版本线性采样、ordinary 捕获零初值、跨 flush 重用、nearest/linear 与 clamp/repeat/mirror，及 3×2 非方形 HDR storage→texture 复制。最后 texel 的 HDR B=1.25 保留在线性数据中。
- 首轮 9 个任务提交包含 4 次 storage texture 派发；唯一一次 textureUploads 是延后读取的初始零检查点，生成/反馈结果不经 CPU writeTexture。随后跨 flush 采样无新上传，raster/path 双像素均与数据推导显示值一致。
- 非有限 UV 给 `TC_COMPUTE_TEXTURE_COORD`，下游给 `TC_COMPUTE_DEPENDENCY_FAILED`；独立任务继续。失败/取消不改变原纹理或渲染输出，也不增加 liveTextures。释放任务使纹理历史从 4 个回到 3 个当前资源，成对缓冲也同步收集。
- 显式矩形 CPU 写只新增一次纹理上传；错误尺寸快照原子拒绝。恢复、真实设备销毁重建、继续反馈、异步回放和最终零资源通过。WebGL2 拒绝由本次 CPU 能力契约覆盖，不重跑上一增量硬件回退场景。
- 保留 `compute-textures-1793884318658/build-report.json` 的静态声明属性访问失败；示例改为共享常量图。保留 `compute-textures-1793884361449` 的探针 HDR 显示参考遗漏 8 位钳制失败；修正参考后通过，像素容差仍为 2 字节。

API 索引更新为 95 项。npm 暂存/tarball 仍是旧分发基线；稳定候选集中重建与渠道验收。
