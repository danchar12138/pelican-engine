# M3 增量：Pelican 更名与单包分发

需求入口：DECISIONS D12/D16/D41–D48。先更新决策与 AGENTS，再统一活跃项目名称，随后接入编译分发。M3 未正式验收或发布，不创建独立提前发布节点。

## 已实现

- 产品 Pelican Engine（鹈鹕游戏引擎），GitHub 保留原所有者，仓库已改名 `danchar12138/pelican-engine`，本地 origin 已同步；不迁移组织。历史标签与 Release 保留。
- 唯一 npm 包与游戏导入 `pelican-engine`，唯一 bin `pelican`；单包含同源 SDK、runtime、renderer、编译器和 CLI，没有第二套 API。
- 源码使用 `pelican.ps1`；项目清单 `pelican.project.json`；缓存 `.pelican/`；运行态品牌、控制路由、IR/快照格式与构建元数据使用 Pelican 标识。稳定错误码保留，历史证据与 MIT 原始版权声明不改写。
- 编译包的公开导出仅根 SDK，含 JavaScript、SDK 声明、AI 入口、API 索引、MIT 和第三方许可。tarball 不含 TypeScript 实现、源码映射、证据、示例或游戏资产。
- 空 npm 工作区安装后 `npx pelican dev` 安全创建最小游戏；重复 dev 不覆盖已有文件。显式 minimal 模板两渠道共用，源码仓库原 M2 默认模板保留。
- check/compile/dev/build/optimize、运行态控制、截图、API 发现、doctor/setup 共用工具协议。依赖与浏览器准备后支持离线工作；编译包和项目版本及文件完整性检查有稳定错误与修复建议。
- npm 暂存 `.pelican/npm/package/`，tarball `.pelican/npm/artifacts/`，不污染静态游戏 `dist/`。静态部署不需要 Node、引擎源码或开发服务。
- WebGPURenderer 内置 WebGL2 回退，不手动构造或断言 WebGPUBackend；不主动降画质。SDK capabilities、状态栏与 inspect 提供实际后端；不支持的模式/降噪/compute 在提交前拒绝，保留原设置。
- Release 事件触发 npm CI；先核对标签、版本、提交及正式验收，再发布精确 tarball。Automation Token 仅作为 Actions NPM_TOKEN secret 使用，缺失时明确失败；不回显，不写证据。凭据已配置，不代表已发布。

## 已验证与边界

2026-11-05 对新增 specular 材质与直接依赖变更重新生成包：当前候选 tarball 188 个文件，SHA-256 `7f9d0b67036bd71fd4b7194ea178e48c74bd32c4a09501fe4dddef484cf894ab`，对应源码指纹 `39a385afcd87626f4c58c0029a3173cb69daa27ca66ce75ebe76584b57b8baab`。在引擎仓库外 Windows 中文临时目录，以 npm 离线缓存安装，`npx pelican dev`、检查、构建、许可和真实 NVIDIA WebGPU／WebGL2 基础流程通过；随后在同一安装项目中仅以公开 SDK 构建包含 `KHR_materials_specular`／`KHR_materials_ior` 的游戏，离线静态子路径部署并阻断外部网络请求，导入材质与 SDK 材质实际像素对照通过。证据 `evidence/m3/development/npm-current-1793895319798/`。

本次不是全新 Windows OS、公开注册表安装、独立 AI 使用或完整 M3 验收；`npm-current-1793895250249` 保留临时脚本中文编码失败，`npm-current-1793895286312` 保留截图采用错误画布尺寸导致的对照失败。原早期 tarball 已备份到 `.pelican/npm/artifacts/historical-pelican-engine-before-specular.tgz`；版本仍未正式发布。

针对 npm 包不包含仓库示例这一实际使用边界，统一游戏开发 AI 入口 `docs/npm/GAME-AUTHOR.md` 新增无需游戏资产或引擎源码的完整公开 API 配方，并明确仓库示例／维护者探针不随包分发。`tests/npm-author-recipe.test.ts` 直接提取该文档代码并通过编译；同一段代码也在已安装 npm 包的仓库外中文临时项目中离线 check／build 通过，记录 `evidence/m3/development/npm-author-recipe-1793895568013/recipe.json`。文档与测试在上次打包后更新，稳定候选须重新打包并验证文档随包分发；这不是独立 AI 正式验收。

严格类型检查、分发契约 6 项、全量硬件 opt-in 测试 1072 项通过，零跳过。Windows 仓库外中文空目录从本地 tarball 离线安装开发依赖，直接 dev 自动建游戏、重复启动、公开类型/API、doctor/setup offline、增量检查、构建、诊断、许可、真实 NVIDIA WebGPU 三模式、WebGL2 模式拒绝、两类截图与子路径静态部署已通过。该测试不借用引擎目录的依赖解析。

真实 WebGL2 专项覆盖缺 API、空适配器、请求失败三条内置回退路径，画布像素、确定错误码、连续两次上下文恢复、重复加载资源计数及最终上下文释放；另有 WebGPU path/hybrid/raster 设备重建。延迟初始化、取消、替换设备再次丢失、最终清理失败及曝光应用有针对性回归。

旧名称代码的通过报告仅说明对应冻结源码。每次新探针记录自己的源码指纹，不把旧通过数或历史证据贴到新源码上。M3 原有 16 项开发探针与独立游戏开发 AI 任务仍单独归档，不升级为完整 acceptance。

最终增量摘要为 `evidence/m3/development/pelican-npm/summary.json`。当前包 169 文件、410703 字节，SHA-256 `df50111d4ad2de7209f1c191faa17af74853e394d24a89014c8bb43f10b4f5f7`。独立游戏开发 AI 仅凭安装包完成新组件、玩法系统、预制体、输入/单步、快照/恢复和静态部署，12 项断言通过，检查/构建零警告；写无关测试 JSON 不再重载。最终包 smoke 在独占 GPU 条件下通过，原有 16 项 M3 探针也在独占 GPU 下全部通过，见 `1793861219227`。并行 GPU 冷编译的超时失败记录保留在增量 `attempts/`，没有修改超时或数值门限来消除失败。

**尚不能宣称完成的事项：**全新 Windows OS/虚拟机上的注册表公开安装尚未验证；npm 包尚未公开发布；GitHub 发布工作流尚未在真实 M3 Release 中执行。M3 完整高级图形接口、质量/故障矩阵、正式 verifier/profile 与全里程碑独立验收仍未完成。性能保留原负载真实数据，不作为僵硬 FPS 发布门槛，不静默降画质。

## 复测

```powershell
npm run typecheck
npm run distribution:test
npm run distribution:pack
npm run distribution:smoke -- --gpu
npm run probe:backends
npm run probe:m3
```

全量 GPU opt-in 环境变量使用 PELICAN 前缀，详见 M3 任务。npm 初次安装遵循 npm 的上级目录规则；嵌套到已有 npm 项目时用 `npm --prefix . i -D pelican-engine` 限定工作区。自动化 smoke 始终显式限制临时目录，不能修改用户上级项目。
