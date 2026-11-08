# Pelican Engine

这是 **Pelican Engine 的引擎研发仓库**，面向维护 SDK、运行时、渲染器、编译器和开发工具的贡献者。制作游戏请在独立目录安装 npm 包，无需下载、克隆或构建此仓库。

```sh
mkdir my-game
cd my-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

游戏开发 AI 从 [npm 游戏开发入口](docs/npm/GAME-AUTHOR.md) 开始。完整引擎构建产物由 `pelican-engine` npm 单包分发，CLI 为 `pelican`。

## 维护引擎

使用 Node.js 24 和 npm。开发工具面向 Windows、macOS、Linux，采用 Node API 和平台无关命令。浏览器图形能力通过运行时探测；Node 可移植性不等于每台设备都支持 WebGPU。

```sh
npm ci
npm run typecheck
npm test
npm run distribution:pack
npm run distribution:test
```

`packages/` 是引擎源码；`tools/` 是编译、打包和维护工具；`tests/` 是功能与边界回归；`examples/` 是贡献者使用的集成夹具和 npm 配方源。源码示例不是游戏作者的安装途径。

- [贡献指南](CONTRIBUTING.md)：开发、测试与提交。
- [当前架构](docs/ARCHITECTURE.md)：内容构建、运行时和扩展边界。
- [能力边界](docs/CAPABILITIES.md)：机器查询入口与缺口。
- [发布流程](docs/RELEASING.md)：版本、跨平台 CI 与 npm OIDC。
- [第三方来源和许可](docs/THIRD-PARTY-NOTICES.md)。项目代码采用 [MIT](LICENSE)。

公开接口以 SDK 源码为准，API 文档随 npm 构建生成。历史报告在 Git 历史和原发布附件中追溯，当前树不保存重复验收材料。
