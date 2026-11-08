# Private Surface Spatial Denoiser

这是可独立集成、可执行测试的 private WebGPU **spatial-only** 降噪组件。不是 SDK API，不接入主 renderer，不实现 temporal history、motion vectors、reprojection、disocclusion 或运动拖影处理，也不代表生产级降噪、完整路径追踪或 M3 complete。

## 接口和集成

实现唯一入口为 `src/denoiser.ts`：

```ts
export function createSurfaceDenoiser(
  device: GPUDevice,
): Promise<SurfaceDenoiser>;

interface SurfaceDenoiser {
  encode(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    normalDepth: GPUBuffer,
    albedoRoughness: GPUBuffer,
    width: number,
    height: number,
    options?: { iterations?: number; enabled?: boolean },
  ): GPUBuffer;
  inspect(): SurfaceDenoiserInspection;
  dispose(): void;
}
```

调用方先在同一 device 上创建三个输入 buffer。路径追踪 shader 先写入平均 radiance 和两个 guide，再在同一 encoder 的后续 pass 调用 `encode`；本组件不会生成 guides、重置累积、除以 sampleCount、执行 tonemapping 或提交命令。

```ts
const denoiser = await createSurfaceDenoiser(device);

// The caller's path pass has already ended on this encoder.
const filtered = denoiser.encode(
  encoder,
  averageRadiance,
  normalDepth,
  albedoRoughness,
  width,
  height,
  { iterations: 3, enabled: true },
);
// Encode the consumer/copy of filtered before a subsequent encode overwrites it.
device.queue.submit([encoder.finish()]);
```

`enabled` 默认 `true`，`iterations` 默认 `3`，必须是整数 `0..5`。禁用或 `iterations: 0` 经过参数/容量校验后原样返回 `input`，不分配资源、不创建 bind group、不记录 compute pass，也不改变已有尺寸/资源；`lastPasses` 记为 `0`。禁用时仍拒绝非法 options。

## Buffer ABI

三个输入均为 row-major、每 pixel 一个紧密排列的 `vec4<f32>`，索引 `y * width + x`，每 pixel 16 bytes，无行 padding：

| Buffer            | RGB / XYZ                          | W / Alpha                                  |
| ----------------- | ---------------------------------- | ------------------------------------------ |
| `input`           | 线性 radiance **平均值**，不是 sum | 该 pixel 的 sampleCount                    |
| `normalDepth`     | 世界空间法线，可非单位但必须非零   | 世界单位 distance；miss 为 `-1`            |
| `albedoRoughness` | 线性 albedo，`[0,1]`               | roughness，`[0,1]`                         |
| 返回值            | 空间降噪后的线性 radiance          | 原 pixel 的有效 sampleCount，逐 pixel 保留 |

三个输入必须有 `GPUBufferUsage.STORAGE`、`mapState === "unmapped"`、总容量为 16 的整数倍且至少 `width * height * 16`。允许额外 vec4 容量，但每个 binding 显式限定为实际图像的字节数，不读取尾部。显式 bind group layout 将 `source`、两个 guides、原始 radiance 声明为 `read-only-storage`，唯一可写 binding 是自有输出。输入不修改、不释放；不需要 `COPY_SRC`，测试为只读 readback 才额外添加它。

尺寸必须为正 safe integer，并满足 u32 pixel 索引、i32 坐标、device 的 `maxBufferSize`、`maxStorageBufferBindingSize` 和 8x8 workgroup dispatch 上限；不支持零宽/高。参数错误以 `TC_DENOISER_OPTIONS/DIMENSION/BUFFER/ALIAS/ENCODER` 同步失败，在任何分配或 pass 之前完成校验，不改变已有 state。

## 算法和边界

每轮使用可分离 B3-spline 外积核 `[1,4,6,4,1] / 16` 的 5x5 邻域，步长依次 `1,2,4,8,16`，边界丢弃越界 taps 并重新归一化。实现为每轮一个 compute pass、8x8 workgroups，并非两次横纵近似。

权重包含世界法线夹角、相对 distance、albedo RGB 与亮度、roughness 差以及**原始** radiance 亮度差。法线 cosine `< 0.85`、distance 差 `> 0.002 + 0.03 * max(min(distance), 0.01)`、roughness 差 `> 0.2` 时硬拒绝贡献。原始亮度 guide 不随 pass 被逐渐模糊；其带宽随 roughness 增大、随有效 sampleCount 增大而收窄，保护同材质中的阴影与粗糙 specular 亮暗边界。所有轮次都保留原始输入 binding，避免第一次清洗过的坏样本后续重新参与混合。

有效 radiance RGB 的有限范围为 `[-1e20,1e20]`，负分量输出裁为零。NaN/Inf/超范围 RGB 输出黑色并不向邻域贡献；有效的 alpha 仍保留。sampleCount `0` 输出黑色且不贡献；NaN/Inf/负 alpha 清为 `0`，这是 alpha 保留规则的无效输入例外。黑色且 sampleCount 正常的像素是有效黑色样本，不被当作缺失样本。distance 的有效上限为 `1e20`；法线平方长度必须在 `(1e-12,1e12)` 内。

miss 和无效 guide 不参与过滤，保留自身清洗后的 radiance/count，也不向 surface 邻域贡献。空黑、坏数、非法 guide 不会扩散 NaN。`iterations: 0`/disabled 是真正旁路，**不清洗**输入。

这是启发式空间滤波，不是论文全量复现：没有 variance estimator、direct/indirect 或 diffuse/specular 分离、albedo demodulation、跨帧信息。仅有 albedo/roughness 无法完整辨识金属、折射、镜面、高频等亮度色差或强噪声与真实细节；不能保证任意场景的边缘/能量严格无偏。距离阈值使用调用方的世界单位，陡斜面和不同尺度需要独立评估。不宣称已完成生产画质验收。

算法一手来源：Dammertz, Sewtz, Hanika, Lensch, _Edge-Avoiding À-Trous Wavelet Transform for fast Global Illumination Filtering_, HPG 2010；作者公开论文 `https://jo.dreggn.org/home/2010_atrous.pdf`，DOI `10.2312/EGGH/HPG10/067-075`。B3-spline/逐轮扩张是此实现的基础，本文列出的具体阈值为本组件策略。另核对本机已安装的 Three.js `node_modules/three/examples/jsm/tsl/display/DenoiseNode.js` 中 `denoiseSample` 的 normal/depth/luminance 联合 guide；不复制其 Poisson 算法，不引入新依赖或外部服务。

## 资源和失败语义

成功创建后尚无 buffer。首次有效过滤懒分配两个 `STORAGE | COPY_SRC` ping-pong 输出和一个 `UNIFORM` 参数 buffer；参数包含五个对齐槽位，每轮数据在 mapped-at-creation 时一次写入，不使用后续 `queue.writeBuffer`。因此同尺寸下多次 `encode` 可记录到同一个 encoder；消费/复制前一次输出的命令必须排在下一次 `encode` 之前。

过滤返回的是**借用的、denoiser-owned** ping-pong buffer。调用方不可 `destroy`/map 它，也不可再将它作为本组件 active encode 的任一输入；需长期保存或再次输入时，请先复制到调用方自有 buffer。下一次过滤会复用并覆盖输出；resize、dispose 或 device loss 会销毁它。旁路返回的则始终是调用方 input，所有权不转移。

尺寸变化（包括相同 pixel 数的宽高交换）时先分配新资源、建立全部 bind groups，再替换旧 allocation 并销毁旧的三个 buffer。**必须在 resize/dispose 前先 submit 引用旧输出/参数的 encoder**；不支持在未 submit 的旧 encoder 仍引用资源时 resize。提交后的正常 WebGPU 资源生命周期由 device/queue 管理，不要求每帧等待 GPU 完成。

分配、mapping、bind group 建立或编码期间的同步异常会释放新申请资源、保留原 allocation/尺寸/统计/输入。调用方不得 submit 已经因异常而部分编码的 encoder，需要重建 encoder。GPU API 的异步 allocation/validation 失败不可能由同步 `encode` 完整回滚；此时不得把 `inspect` 当作 GPU 成功证明。

`encode` 不 push/pop error scope，不拦截 `uncapturederror`，不静默 fallback。因此被销毁的 buffer、foreign-device buffer/encoder、已结束的 encoder 等无法由公开同步属性验证的错误，仍会到达调用方 error scope 或 device 事件。集成方可在 encode/submit 外自行 `pushErrorScope("validation")`，并在异步任务中 `await popErrorScope()`；本组件不会消耗调用方 scope。GPU 实测含 foreign-device 负例，确保错误可见。

factory 使用显式布局和 **`createComputePipelineAsync`** 编译/校验，创建阶段自己的 validation scope 必定 pop。失败以 `TC_DENOISER_PIPELINE` 拒绝并保留原始 `cause`；包括 shader/layout validation、设备失效。pipeline 成功前没有 buffer 可泄漏，pipeline/layout 无显式 destroy API。创建与 device loss 竞速，并有 10 秒 timeout，pipeline/scope promise 即使不完成也不会永久 pending。

实例在 `device.lost` 可观察后销毁自有 buffers 并拒绝后续 encode（`TC_DENOISER_DEVICE_LOST`）；不恢复设备或重建主 renderer。丢失回调用 WeakRef，不因长期存活的 device promise 强持有已释放实例。`dispose()` 幂等，只销毁自有资源；dispose 后 encode 拒绝 `TC_DENOISER_DISPOSED`。

`inspect()` 返回 detached、JSON 可序列化快照：`entries` 为现有自有 buffer 数（0 或 3），`bytes` 为两个图像 buffer 加实际五槽 uniform 的分配字节数，`passes` 为累计成功记录的 compute passes，`lastPasses` 为最近一次 encode 记录的 pass 数，`dimension: { width, height }` 为当前 allocation（释放后 0x0），另有 `disposed/lost`。统计不包含外部输入、bind groups、pipeline/驱动内部内存，也不是 GPU 执行/完成计数。

## 验证

默认 CPU 单测，只用 recording fake GPU 验证 host 契约，不当作 WGSL 编译、GPU 正确性或性能证据：

```sh
node --import tsx --test tests/denoiser.test.ts
```

真实 GPU opt-in 与导出 helper 均在同一个 `tests/denoiser.test.ts` 内：

```sh
node tools/run-with-env.mjs PELICAN_DENOISER_GPU=1 -- node --import tsx --test tests/denoiser.test.ts
```

`runDenoiserGpuTest()` 使用已有 TypeScript 将实际模块转为内存中的 ES module，临时 localhost HTTP server + Playwright 加载，无主渲染路径、临时 bundle 文件、外部服务或用户点击。Node 侧 60 秒 deadline 包住初始化、browser launch、GPU probe 和执行；`finally` 关闭自有 browser/server，browser 内 finally 销毁 buffers/device。使用完整无界面 Chromium，不启动可见窗口，不依赖键盘或桌面焦点；图形参数由共享浏览器工具按平台提供，不把启动参数当作已测得的 WebGPU backend。无硬件时 opt-in 失败而非 skip/软件回退，检查 `isFallbackAdapter === false` 并拒绝显式软件名称。

实测日期 **2026-11-04**：NVIDIA `blackwell`，`isFallbackAdapter: false`；headless 由于 `dxcompiler.dll` Windows Error 87 失败，自动 headed 成功。真实 WGSL 异步 pipeline 编译、dispatch、readback 已执行，且 uncaptured GPU error 为空：

- 96x64 多平面带噪 HDR 图，3 轮，名义 25 taps/轮，共 460,800 tap visits（边缘/guide 拒绝会减少实际贡献），MSE `0.0552927361 -> 0.00229747752`，比例 `0.0415512`。
- 5 轮独立断层测试：normal/depth/albedo 最大误差各约 `8.94e-8`；同材质亮度阶跃误差约 `4.29e-6`；roughness 0.9 的 specular 亮暗阶跃误差约 `2.77e-5`。
- 逐 pixel alpha 保留；三个输入逐 bit readback 不变；NaN/Inf、坏 alpha、零计数、黑图、miss 与坏 guide 隔离；所有 `1..5` 轮、0 轮/disabled 旁路、同一 encoder 的两次调用均覆盖。
- 15 次 resize（1x1、17x9、64x32、9x7、96x64，三轮循环）与重复 create/dispose；显式 foreign-device validation 仍由调用方 scope 获取；释放后 `entries/bytes = 0`。
- 首次实测 submit-to-readback wall time 约 `5.3 ms`，包含提交/同步/map 成本，不是 timestamp-query GPU kernel 时间，无主流性能或跨硬件帧率结论。每次重跑在 TAP diagnostic 输出当前原始统计，不将本次数字作为性能门禁。

类型与格式复验不改其他文件：

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/denoiser.ts tests/denoiser.test.ts packages/renderer/DENOISER.md
```

支持边界仍为独立 private spatial 模块；尚无 temporal/motion 能力、主线 path guides 产出或 renderer 集成证据，不宣称 M3 complete。
