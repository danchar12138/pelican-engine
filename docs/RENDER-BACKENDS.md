# 渲染后端与能力诊断

适用：当前源码及由相同版本生成的 npm 包。历史标签保留当时的行为与证据；本文件不改写旧验收。当前源码的后端兼容性尚未完成完整验收。

## 同一公开接口

游戏仍只使用 `pelican-engine`。仓库、ZIP、外部目录和 npm 渠道共用相同声明、编译器和运行时。查询 `game.render.capabilities()` 或系统中的 `ctx.render.capabilities()`：

```typescript
const capabilities = ctx.render.capabilities();
// backend: "webgpu" | "webgl2" | "uninitialized"
// compute: boolean
// availableModes: readonly ("raster" | "hybrid" | "path")[]
// modeLimitation?: string — 场景配置限制模式时的说明
```

返回值是分离的普通数据；没有 Three.js、GPUDevice 或 WebGL 上下文。未绑定浏览器渲染器的纯 CPU 运行时报告 `uninitialized`，不能据此声明已经初始化 GPU。

## 选择与画质

引擎创建 Three.js `WebGPURenderer`，由其 `getFallback → WebGLBackend` 处理 WebGPU 初始化不可用。没有 API、找不到适配器和适配器请求拒绝均可进入内置回退；引擎不自行构造 WebGPUBackend，也不根据缺少 `navigator.gpu` 提前拒绝。

引擎不改变作者指定的分辨率、采样、灯光、材质或后处理来适应回退。不同后端可能存在数值、驱动或扩展能力差异；支持边界必须明确记录，不能把近似图像当作相同功能。WebGL2 可用模式为 `raster`；依赖 compute 的 `path`、`hybrid`、降噪和受控计算不能使用。初始内容要求不支持模式时明确失败，不自动重写内容。

普通场景的正交相机已有 WebGPU `hybrid`/`path` 与逐采样初始介质开发实现；透明度裁剪的透射壳体返回 `TC_TRACE_ORTHOGRAPHIC_MEDIA_UNSUPPORTED`，一致的正反整体绕序均有开发实现，采样点靠近壳体或分类歧义返回 `TC_TRACE_MEDIUM_STATE`，不自动切换模式。透视相机的近裁剪区域可能与透射体相交时也会启用逐射线分类；若透射壳体使用透明度裁剪则报 `TC_TRACE_NEAR_MEDIA_UNSUPPORTED`。历史 M0 光追侧车仍仅支持透视相机；WebGL2 仍仅支持光栅。普通场景、World UI 和真实回退路径有专项回归；复杂正交介质和跨设备组合仍需完整覆盖。

状态栏显示当前 WebGPU/WebGL2。开发态 `inspect` 同时提供实际后端名称、适配器（适用时）和 `capabilities`；WebGL2 不伪造 WebGPU 适配器信息。

## 错误与修复

| 错误码 | 含义 | 修复 |
| --- | --- | --- |
| `TC_RENDER_MODE_UNAVAILABLE` | 当前后端或相机配置不支持请求的模式 | 按错误中的 available modes 和限制说明选择模式；需要光追时使用透视相机及实际可用的 WebGPU |
| `TC_RENDER_COMPUTE_UNAVAILABLE` | 降噪或计算需要 WebGPU compute | 不请求该功能，或启用 WebGPU 后重新加载；不能替换成光栅并仍声称光追 |
| `TC_RENDER_BACKEND_UNAVAILABLE` | WebGPU 及内置 WebGL2 回退均无法初始化 | 检查图形加速、驱动、浏览器设置与安全上下文，修复后重载 |
| `TC_RENDER_CONTEXT_LOST` | WebGL2 上下文丢失，等待浏览器恢复 | 游戏暂停；浏览器恢复上下文后引擎重建资源并保留受控 CPU 状态；未恢复时不报告 ready |
| `TC_GPU_RECOVERY_FAILED` | 设备或上下文重建失败 | 保留诊断，修复缺失能力后重载；不宣称旧 GPU 资源仍可用 |

配置和检查点恢复先校验能力再提交；被拒绝的配置不改变当前模式或设置。运行态开发控制命令返回结构化 `failed` 与稳定错误码，不因正常的不支持请求把游戏置为崩溃状态。

## 历史实测入口

以下为引擎贡献者使用的开发探针，输出应留在忽略目录。

在已安装依赖与 Playwright Chromium、实际硬件加速可用的环境中：

```sh
npm run probe:backends
# 仅运行独立 WebGL2 回退矩阵：
npm run probe:backends -- --webgl-only
```

输出 `.pelican/backend-probes/<run>/report.json` 与截图，包括源码指纹、实际 ANGLE/GPU 身份、画面像素检查、三类初始化失败、不可用模式/降噪/计算错误码、两次上下文恢复、重复内容重载，以及两后端都不可用的诊断。默认还复测真实 WebGPU 三模式设备重建。

这些是历史开发专项记录，不构成当前版本的完整图形或硬件验收。WebGPU 与 WebGL2 应分别记录，不用一种后端或软件渲染器代替另一种后端的证据。当前授权只允许编译和构建，历史测量不自动适用于当前源码。
