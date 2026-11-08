# 参与引擎开发

本仓库用于引擎研发；游戏开发只使用 npm 的 `pelican-engine`。先阅读 [架构](docs/ARCHITECTURE.md)，按 [AGENTS](AGENTS.md) 的维护规则工作。

## 环境和命令

Node.js 24.x、npm，Windows、macOS、Linux。使用项目依赖，不要求特定 shell 或系统级安装。首次联网安装锁定依赖：

```sh
npm ci
npm run typecheck
npm test
npm run distribution:pack
npm run distribution:test
```

浏览器集成需要 Playwright Chromium，按需执行 `npx --no-install playwright install chromium`；Linux CI 使用 `--with-deps` 安装运行库。CPU、DOM、真实 GPU 是不同检查层次，不用软件 GPU 结果冒充硬件结果。

`npm run distribution:smoke -- --online-install` 在临时独立游戏目录安装实际 tarball，执行 CLI、类型检查、构建和静态部署。`npm run verify:ai -- --output .pelican/verification/ai` 执行 npm 游戏开发与浏览器功能组合。后者需要本机可用的图形环境。

可选图形回归通过 `PELICAN_BSDF_GPU`、`PELICAN_DIELECTRIC_GPU`、`PELICAN_DENOISER_GPU`、`PELICAN_ENVIRONMENT_GPU`、`PELICAN_MODEL_BROWSER` 环境变量开启（值 `1`），应串行执行并记录实际后端。普通测试中的 opt-in 跳过不能记为通过。

## 文件与接口

公开 API 修改从 SDK 源码开始；机器能力在 SDK 的 capabilities 中维护，API 索引与声明自动生成。新增行为维护有意义的回归。测试和必要夹具是开发项目的一部分；输出日志、截图、压缩包、生成文档存 `.pelican/`，CI 上传 artifacts，不提交当前树。历史证据可从旧提交及发布附件复现。

游戏内容默认新建为普通 TypeScript 构建模式；旧项目保留静态解释模式。实现新玩法优先使用通用 ECS、系统、组件、事件和已有服务，避免为每种游戏再设计一套语法。

按功能或修复提交，使用中文 Conventional Commits。不要创建并行工作树或覆盖他人的工作。发布步骤见 [RELEASING](docs/RELEASING.md)。

## 清理与复测

`npm run clean` 预览可再生输出和大小；`npm run clean -- --apply` 删除 allowlist 中的生成目录，不跟随 symlink/junction，也不删除源码或 node_modules。保留必要的失败报告与性能基线后再清理，当前开发结束时不要累积旧 npm 安装副本、dist 备份或阶段缓存。

`npm run benchmark:render -- --tarball <candidate.tgz> --baseline pelican-engine@1.2.0` 使用实际 npm 安装、同资产和相机对比。需真实 WebGPU 环境，报告 GPU 时间、CPU 更新与上传量、显示图误差；不把协议耗时称为 FPS。

`npm run evaluate:author -- --package <candidate.tgz> --label candidate` 准备独立游戏 AI 的相同任务和 CLI 记录器。评测 AI 只读安装包公开入口，不读取引擎源码；保留首次检查、修复和查询记录。成功率是实际样本结果，不能推广为所有模型的训练熟练度。
