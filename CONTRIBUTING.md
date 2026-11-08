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
