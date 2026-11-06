# M3 片元与后处理受控计算缓冲

实现 CAP-17 已确认能力，沿用唯一公开 SDK 与 GPU 常驻版本协议。M3 尚未整体验收。

状态：实现及受影响验证通过，未提交或发布。证据 `evidence/m3/development/fragment-buffers-1793882714223/summary.json`，源码指纹 `2536cf39df5fc3d41fc32a853b94fc44114db55b7fcaaa6f2a5cec3fa55deac2`。

后续 [计算纹理核心](M3-COMPUTE-TEXTURES.md) 已取得独立证据；下文记录本次缓冲增量当时的边界。

## 契约

- 材质既有 `buffers` 槽扩展到 graph/graphs 片元读取，顶点接口不变。后处理新增相同的 `buffers` 声明，通过 `render.effects.buffers.bind/unbind/state(passId, ...)` 管理；材质仍用 `render.buffers`，两类 ID 独立命名空间。
- 公开数据只有类型化声明、逻辑缓冲 ID 与句柄；不暴露 Three/TSL/GPU 对象。两类槽联合 pin 源缓冲，快照分别保存逻辑引用并在 restore 前检查 compute peer。错误类型/数量/缺失槽均确定诊断。
- 片元/后处理支持逐像素动态整数索引，包含 UV 推导。渲染域 readBuffer 对负数、非整数、非有限或越界索引定义为对应类型的零值；不会 clamp 成有效邻居数据。compute 越界任务失败与 vertex CPU 几何校验保持既有规则。GPU 渲染 gather 的边界行为是明确接口语义。
- 光栅、path/hybrid 使用同一槽资源和索引语义；path/hybrid 不能通过 CPU 结果重传伪装 GPU 读取。允许初始化、CPU 显式写、恢复检查点上传；计算结果只通过 resident GPU 数据复制到渲染资源。版本变化使相关积分/时域失效。
- Three storage 槽用于光栅/后处理；原生 tracer 使用追加材料表空间，计算输出直接 GPU 复制到对应 vec4 范围，避免增加独立 storage binding 超出既有布局预算。CPU 表仅包含固定参数与零占位，不打包计算结果。
- WebGL2 使用槽时明确 `TC_RENDER_BUFFER_CAPABILITY`，不模拟 compute、不静默替换效果。设备/内容重建释放借用视图并重新绑定；重复帧不额外复制未变化版本。

## 并行写入边界与验证

主线负责 SDK/IR 契约、运行时联合 pins/快照、Three bridge/composer、浏览器接入与一条小型真实硬件链路。编译器 worktree 仅处理 normalize/graph 与专属编译测试。tracer worktree 仅处理 material-graphs/surface-tracer 及专属原生槽测试。三者不修改共享文件；主线合并后集中类型检查。

按 D49 只做受影响契约与一条 320×240 硬件链路，覆盖逐像素读取因果、GPU 拷贝/无 CPU 结果上传、重绑、越界零、快照和资源回收；不重跑完整 M3/1080p/安装矩阵。本增量不涵盖计算纹理及全部高级材质矩阵。

## 实际结果

- 182 项受影响测试通过，零跳过；集中类型检查通过。两个独立 worktree 的改动按文件范围合并；浏览器 CPU 事务测试使用真实新增函数体。
- 320×240 NVIDIA 非回退 WebGPU 的 raster/path/hybrid 全部通过计算调色板驱动材质/后处理的双像素数值对照；颜色来自逐像素 UV 索引，容差为 2 个显示字节。
- 连续 23 次计算提交，compute 上传保持首次检查点的 1 次；Three 材质与后处理共两个槽，原生 tracer 另有一个槽，均走 GPU 复制且 CPU 结果上传为零。path/hybrid 原生复制累计为 8/15 次，未变化的呈现帧不增加 Three 复制。
- 后处理负数/非整数/越界索引和三模式材质越界均为零值。重绑新检查点只新增一次上传，联合 pin 拒绝源释放；无效快照保持旧世界，恢复、一次真实设备销毁重建、继续计算、异步回放及零资源清理通过。WebGL2 明确返回 `TC_RENDER_BUFFER_CAPABILITY`。
- 保留两次开发失败报告：`fragment-buffers-1793882613735` 为旧后处理拦截未清除，`fragment-buffers-1793882689183` 为探针错误调用光栅累积接口。修正后取得当前通过报告，不降低画质或像素容差。

尚未重包 npm 或执行新的 npm 安装验证，旧 tarball 仍是早期分发基线。统一公开 API 及随包文档在稳定候选集中重建与渠道验收。
