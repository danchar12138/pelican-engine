# M3 受控后处理与多通道

这是 CAP-13/CAP-17 的已确认能力实现，不新增产品范围，也不替代完整 M3 验收。

当前状态：公开定义、编译/源位置诊断、CPU 参数/快照所有者、全尺寸 HDR MRT/多 pass/历史反馈及浏览器三模式链路已接入。179 项受影响测试、类型检查通过；一条真实 NVIDIA WebGPU 三模式 + WebGL2 实测验证颜色因果、法线/距离、反馈重置、方向、4× MSAA、模式资源计数、设备重建与最终销毁。不同噪声帧的初始比较失败、MSAA 输出阶段误读及其修正证据保留，不提高门限或降低画质来通过。

证据见 `evidence/m3/development/postprocess-1793871281327/summary.json`；增量源码关联为 `dadb7d825930b9bedb046cc01343acddf60907529a954e68de727d6055dbbaab`。后续编译模块报告修正有独立 3 项局部复测，与 179 项有重叠，不相加制造覆盖数；真实 GPU 图像与 CPU 夹具报告分开。

## 契约与分工

SDK 定义 definePostProcess，GameInput.postProcesses 显式排列具名 pass，输出图为线性 HDR vec4。图可用 uv、screenSize、texelSize、time、参数及纹理采样；sampleFrame 读取 scene.color、scene.normal、scene.depth 或更早的 pass，sampleHistory 读取任意已声明 pass 的上一个成功呈现帧。禁止前向当前帧依赖、重复/保留 ID、域外读取和原始 shader/Three/GPU 对象。

scene.color 是未曝光/未色调映射的线性工作空间颜色，scene.normal 是世界空间着色法线（RGB 为 -1..1），scene.depth 的 R 是正向射线到首表面的世界单位距离、未命中为 0。颜色/法线/距离都通过 rgba16float 离屏目标。当前不承诺透明多层法线/距离跨后端逐像素一致；必须记录实际覆盖边界，不冒充完整 G-buffer。最终曝光和色调映射仅执行一次。保持 renderer.samples 指定的场景 MSAA，不把输出转换阶段可能为 0 的 currentSamples 误当作场景配置。

render.effects 提供 configure/state/setParameter/resetHistory。效果图不可运行时任意替换，参数类型受编译图约束；配置与参数属于受控 CPU 快照。历史纹理是呈现状态，恢复时明确清空，不伪称恢复旧 GPU 图像；反馈按渲染帧而非固定 tick 推进。内容/模式/设备重建也重置历史。开关变化重置所有历史，随后关闭的 pass 当前输出为上游直通、历史不再推进；重新开启防御性重置。

主线负责 SDK、编译图、浏览器与 tracer 的 HDR 交接、类型化图采样回调及小规模实测。状态 worktree 只实现 runtime/postprocess.ts 与 render-settings 集成和专属测试。图形 worktree 只实现 renderer/postprocess.ts 与专属测试，使用已冻结的内部视图/目标契约。互不覆盖共享文件。

无效果时保留原直出路径。启用效果不得偷偷降低尺寸/MSAA/格式或把 compute 光追替换成光栅；不支持 rgba16float 渲染/采样时明确失败。中间 pass 和反馈纹理由引擎管理，禁止同时采样正在写入的附件，销毁与重建需要可观测计数。

## 本轮验证

按 D49 只做类型检查、受影响编译/状态/生命周期契约及一个小型真实 GPU 场景（源颜色/通道、参数因果、两 pass、反馈、模式切换和一条 WebGL2 路径）。不运行整个 M3、1080p 性能或重复 npm 安装。完整画质/透明/反馈故障矩阵保持未验收，留到稳定候选集中验证。

当前尚未覆盖：完整 GPU 历史图像序列化/恢复、逐像素非有限算术故障诊断、透明多层及复杂材质通道矩阵、大场景/长期驻留、GPU 计算资源直接绑定后处理、顶点变形、独立 AI 新接口任务与新 npm 包安装。上一轮 npm tarball/大矩阵属于旧基线，不代表当前源码已完成这些验收。当前不重新打包/安装或做 1080p 性能矩阵；稳定候选再集中验证真正发生变化的渠道和质量契约。
