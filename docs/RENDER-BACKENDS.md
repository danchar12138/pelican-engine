# 渲染后端与能力诊断

适用：M3 开发工作树及由同一版本生成的 npm 包。历史 M0–M2 标签保留当时 WebGPU-only 行为；本文件不改写旧验收。

## 同一公开接口

游戏仍只使用 `pelican-engine`。仓库、ZIP、外部目录和 npm 渠道共用相同声明、编译器和运行时。查询 `game.render.capabilities()` 或系统中的 `ctx.render.capabilities()`：

```typescript
const capabilities = ctx.render.capabilities();
// backend: "webgpu" | "webgl2" | "uninitialized"
// compute: boolean
// availableModes: readonly ("raster" | "hybrid" | "path")[]
```

返回值是分离的普通数据；没有 Three.js、GPUDevice 或 WebGL 上下文。未绑定浏览器渲染器的纯 CPU 运行时报告 `uninitialized`，不能据此声明已经初始化 GPU。

## 选择与画质

引擎创建 Three.js `WebGPURenderer`，由其 `getFallback → WebGLBackend` 处理 WebGPU 初始化不可用。没有 API、找不到适配器和适配器请求拒绝均可进入内置回退；引擎不自行构造 WebGPUBackend，也不根据缺少 `navigator.gpu` 提前拒绝。

引擎不改变作者指定的分辨率、采样、灯光、材质或后处理来适应回退。不同后端可能存在数值、驱动或扩展能力差异；支持边界必须明确记录，不能把近似图像当作相同功能。WebGL2 可用模式为 `raster`；依赖 compute 的 `path`、`hybrid`、降噪和受控计算不能使用。初始内容要求不支持模式时明确失败，不自动重写内容。

状态栏显示当前 WebGPU/WebGL2。开发态 `inspect` 同时提供实际后端名称、适配器（适用时）和 `capabilities`；WebGL2 不伪造 WebGPU 适配器信息。

## 错误与修复

| 错误码 | 含义 | 修复 |
| --- | --- | --- |
| `TC_RENDER_MODE_UNAVAILABLE` | 当前后端不支持请求的模式 | 按错误中的 available modes 选择模式，或启用实际可用的 WebGPU 后重新加载 |
| `TC_RENDER_COMPUTE_UNAVAILABLE` | 降噪或计算需要 WebGPU compute | 不请求该功能，或启用 WebGPU 后重新加载；不能替换成光栅并仍声称光追 |
| `TC_RENDER_BACKEND_UNAVAILABLE` | WebGPU 及内置 WebGL2 回退均无法初始化 | 检查图形加速、驱动、浏览器设置与安全上下文，修复后重载 |
| `TC_RENDER_CONTEXT_LOST` | WebGL2 上下文丢失，等待浏览器恢复 | 游戏暂停；浏览器恢复上下文后引擎重建资源并保留受控 CPU 状态；未恢复时不报告 ready |
| `TC_GPU_RECOVERY_FAILED` | 设备或上下文重建失败 | 保留诊断，修复缺失能力后重载；不宣称旧 GPU 资源仍可用 |

配置和检查点恢复先校验能力再提交；被拒绝的配置不改变当前模式或设置。运行态开发控制命令返回结构化 `failed` 与稳定错误码，不因正常的不支持请求把游戏置为崩溃状态。

## 实测入口

在 Windows、已安装依赖与 Playwright Chromium、真实硬件加速环境中：

```powershell
npm run probe:backends
# 仅运行独立 WebGL2 回退矩阵：
npm run probe:backends -- --webgl-only
```

输出 `.pelican/backend-probes/<run>/report.json` 与截图，包括源码指纹、实际 ANGLE/GPU 身份、画面像素检查、三类初始化失败、不可用模式/降噪/计算错误码、两次上下文恢复、重复内容重载，以及两后端都不可用的诊断。默认还复测真实 WebGPU 三模式设备重建。

这是开发专项，不是完整 M3 acceptance。主里程碑只接受真实 WebGPU 硬件证据；WebGL2 单列记录，不用它或软件渲染器代替主门禁。性能保留诚实观测，不以固定帧率阈值阻断 1.0，也不放松功能正确性和资源生命周期验证。
