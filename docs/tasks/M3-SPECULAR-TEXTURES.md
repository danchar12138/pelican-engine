# M3 不透射高光纹理增量

后续 1/2/4-bit 灰度和调色板 Adam7 支持见 [M3-LOWBIT-ADAM7.md](M3-LOWBIT-ADAM7.md)；下文较早记录的低位深交错拒绝是历史状态，不代表当前实现。

状态：开发增量，非完整 M3 验收或发布。自包含 GLB 的 `KHR_materials_specular` 可分别绑定强度纹理 alpha 和颜色纹理的 sRGB RGB，均乘材质因子；支持 `TEXCOORD_0`、原有纹理寻址和过滤。导入与优化检查保留纹理图像、因子和采样配置。正透射结合高光纹理仍明确拒绝；未实现的纹理变换和其他扩展不静默替换。

最初浏览器游戏实测发现 Canvas2D 读取透明 PNG 时丢失 RGB，造成 path 高光全黑；失败记录 `evidence/m3/development/specular-textures-1793898600/` 保留。现在针对 GLB 高光颜色 PNG 使用有界原始解码并关联共享 Source，避免透明 RGB 被预乘丢失；ICC profile、低位深交错、未支持的 16-bit 色彩块值和超过 256 MiB 的输入／解压／RGBA 输出明确诊断。普通 PNG 和 JPEG 保持原路径。解码器使用 MIT 的 fast-png 8.0.0、fflate 0.8.3 和 iobuffer 6.0.1，许可随 npm 包及 dist 分发。

修复后 `evidence/m3/development/specular-textures-1793899600/` 的 320×240 真实 NVIDIA 非回退 WebGPU 场景完成 raster/path/hybrid：强度纹理 zero alpha 区域为黑，红绿颜色区显著分离，透明颜色 PNG 的灰色区与对称 `#808080` SDK 材质相差约 1.2–1.4 显示字节。探针源码指纹为 `01488c32886c7e65eb745d51bdb6a2253864db336031b3179c23a68130061a9b`，不自动覆盖后续源码。CPU/GPU 表面数值探针在 `.pelican/m3-probes/1793898136485/`，24 次查询、28 通道最大绝对误差约 `9.53e-8`，为较早源码指纹；单元、浏览器加载、许可检查和类型检查分别执行。小型结果不证明完整画质矩阵、所有 PNG 变体、WebGL2、设备丢失或完整 M3 验收。

同一源码候选打包为 SHA-256 `9778c72a6d6fd0d1e32204d89b53c46dc95e5fef3cd6d0ced7716063e586faac`，在仓库外 Windows 中文临时目录通过 npm 离线缓存安装、默认场景 GPU 冒烟、许可和静态部署检查，记录 `npm-smoke.json`。另以安装后的 CLI 对同一纹理 GLB 项目执行 check、build 和 path capture，截图 `npm-installed-path.png` 显示灰、黑、红、绿区。这是本机安装链路检查，不是全新 Windows、公开注册表、该项目全部模式或独立 AI 正式验收。

当前主线还新增了 lifecycle probe。`evidence/m3/development/specular-textures-lifecycle-1793904000/` 在真实 NVIDIA 非回退 WebGPU 上完成初始 raster 懒初始化诊断、path 激活、raster/path/hybrid 像素与资源观察、snapshot→step→restore、非法 restore 原子拒绝和 `exerciseDeviceLoss` 后的 tick/mode/runtime/resource 保持。源码指纹为 `5e3c72b3680d12d03221cbd87779e05185c94d894cdb3f6ebe8fe88e0edbde5e`；该记录仍是小型开发证据，不替代完整 M3 生命周期与质量矩阵。

低位深 1/2/4-bit 灰度/调色板 Adam7 另有 420 组 CPU 组合回归，覆盖尺寸、五种 PNG filter 和 tRNS；解码器拒绝 fast-png 的错误 packed-layout 路径。后续包发布前必须重新打包并验证 npm 渠道。

后续生命周期修复使解码完成的图像在读取关联 PNG 前即登记资源，避免后续失败时遗失清理所有权。`tests/specular-image-cancellation.test.ts` 在浏览器中延迟真实 ImageBitmap 解码、取消加载并验证 dispose 等待所有在途操作且每张图片恰好关闭一次；`tests/models.test.ts` 原有 30 项包含浏览器资源和失败清理回归，均在本次变更后通过。此后源码已变，上述旧包及 GPU 指纹不能当作当前源码验证。

16-bit 灰度、RGB、灰度 alpha、RGBA 及 tRNS 已接入，比较透明键时保留完整 16-bit，最后按当前 Chromium 的上传行为取高字节。`evidence/m3/development/png16-webgpu-1793901600/png16-gpu.json` 保存 Chromium 156／NVIDIA 非回退 WebGPU 原始纹理读回：灰度全 65,536 值、RGBA 全 65,536 alpha 和多种边界／Adam7 情况的解码器误差均为 0 显示字节，源码指纹 `7c43a206cf36067b76d5d066bd4ce16563a1e185724c72a63fd609a3402cc847`。另在 `evidence/m3/development/specular-textures16-1793901900/` 对真实 16-bit GLB 执行三模式游戏测试，源码指纹 `f3b337816151052f9c647bdd2005dbeaeeae7a088a9ac454af8b8636171b0f47`。上述读回仅证明该浏览器／设备与该样本，不证明跨浏览器上传一致、色彩块支持或完整 M3。后续测试代码改动导致当前源码指纹不同。

随后源码指纹 `de8810fa10b4ad0c23f44a5a732ae0778385487cea077a48dbf06304740ce1be` 的 npm tarball SHA-256 `976faca74be113190015e3f845543bfe2bd68b8de6acfa184acc61b47344064a`，在同机仓库外中文临时目录离线安装并通过基础构建与部署检查；安装包构建同一 16-bit GLB 项目后 path 模式出图，`specular-textures16-1793901900/npm-installed-path.png` 保留截图，`npm-smoke.json` 记录该次基础 CPU 冒烟。它不证明全新系统、公开注册表、npm 项目其余模式或独立 AI 验收。

后续开放经实测的 16-bit 色彩块值：gAMA 45455/100000、标准 sRGB cHRM、sRGB intent 0、cICP [1,13,0,1]；其他值继续报 `TC_TEXTURE_PNG_UNSUPPORTED`。`evidence/m3/development/png16-metadata-1793903000/` 的 Chromium 156/NVIDIA 非回退 GPU 纹理读回对五种值各 19 像素与解码器逐字节一致，源码指纹 `59e369649c55bd82d0b699681801af0ca46ba41bb8918f456efcb8a290c0e136`；BT.2020/PQ 只做浏览器观察，并未开放或对照解码器。组合 gAMA/cHRM/sRGB 的 16-bit GLB 在三模式通过，证据 `evidence/m3/development/specular-textures16-metadata-1793903300/`，源码指纹 `3b660d7a4b27800985908306b2978f8958f529aebbdfec8db548a557dfc8b66a`。这些是特定浏览器、显卡和样本的结果，不代表其他值、跨浏览器或完整 M3 验收。

源码指纹 `0d8f744352b9118f8501ebd57c3fef4d60c3a04e24b5d858e73241686b9a79bb` 的 npm tarball SHA-256 为 `cc5f13363d8b83505ac63ff4a308c8027dcc35481f0a49a737b1a75f7eaaee61`。同机仓库外中文目录离线安装通过基础构建／部署，安装包构建组合元数据 GLB 并在 WebGPU path 模式出图；截图与基础 CPU 冒烟记录在 `specular-textures16-metadata-1793903300/`。不代表公开注册表、新系统或安装包三模式正式验收。
