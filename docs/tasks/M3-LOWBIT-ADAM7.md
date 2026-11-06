# M3 低位深 Adam7 纹理增量

状态：开发增量，非完整 M3 验收。高光颜色 PNG 的 1/2/4-bit 灰度和调色板 Adam7 现在由引擎独立解码各 pass，覆盖 PNG filter 0–4、非整除尺寸、单行/单列和 `tRNS`。数据先做有界解压与 chunk CRC 校验，再重排为普通 scanline；不使用 fast-png 对 packed Adam7 的错误布局。

CPU 回归覆盖 420 个组合（3 种位深 × 2 种颜色类型 × 7 种尺寸 × 5 种 filter × 2 种透明状态），`tests/embedded-image-adam7-cpu.test.ts` 和现有图像/生命周期测试通过；类型检查通过。输入、解压、RGBA 产物和资源 WeakMap 生命周期限制保持不变。不能处理或无法验证的格式继续返回 `TC_TEXTURE_PNG_UNSUPPORTED`。尚未把该切片作为完整跨浏览器或 M3 发布门禁。

后续修复了此前资产检查器在编译期拒绝 Adam7 的缺口；检查器按七个 pass 验证像素、调色板索引、CRC 和解压限制，115 项资产／纹理定向测试通过。2-bit 调色板透明 Adam7 GLB 的 raster/path/hybrid、快照恢复与设备重建在真实 NVIDIA 非回退 WebGPU 上通过，证据 `evidence/m3/development/specular-adam7-semantic-1793908500/`，源码指纹 `e51e697b6037738b282b4323ea5a5f5c9b2efb57e4821d795202450a985f0810`。离线图片与生命周期语义验证器重新检查该报告与 12 张截图，但不证明运行来源、不授权发布。

同一源码打包的 npm tarball SHA-256 为 `9e372d4320e13eb4445c0ec832b5ded3344e2a2a136b0ca7563a6835b9b3379a`；同机仓库外 Windows 中文目录离线安装、构建该 Adam7 项目并以 path 模式出图，截图及基础 CPU 冒烟记录在该证据目录。未覆盖新 Windows 系统、公开 registry 或 npm 渠道完整三模式正式验收。
