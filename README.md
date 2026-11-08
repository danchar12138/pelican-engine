<p align="center"><img src="docs/assets/pelican-mark.svg" width="200" alt="Pelican Engine 鹈鹕图标" /></p>

# Pelican Engine · 鹈鹕游戏引擎

**让 AI 把想法直接写成可运行的游戏。** TypeScript 定义世界与玩法，WebGPU 呈现画面，结构化工具负责检查、操作和捕获。没有必需的可视化编辑器，没有游戏内大模型，也不绑定专用 AI 平台。

## 从代码到游戏

- **一个 npm 包，完整开发链路。** SDK、渲染器、运行时、编译器和 `pelican` CLI 一起安装；新目录即可启动，构建后部署到普通静态服务器。
- **普通 TypeScript，自由组合玩法。** 使用类、循环、模块和浏览器兼容 npm 算法库；实体、组件、输入、事件、动画、物理、界面和音频提供共同基础，不强迫套用某种游戏规则。
- **现代渲染与可编程画面。** WebGPU 优先，支持光栅、混合及路径追踪，提供受管材质、计算与后处理图。WebGL2 可回退光栅；追踪采用软件 BVH，不冒充硬件光追。
- **面向 AI 的可检查工作流。** 查询接口与配方，读取带源位置的诊断，驱动输入、单步模拟、保存恢复、截图和批处理。游戏开发不需要接触引擎内部实现。
- **开放且可部署。** MIT 源码，Windows、macOS、Linux 的 Node 开发工具链；玩家按实际浏览器能力运行，不设置系统品牌白名单。

## 开始制作

这是 **Pelican Engine 的引擎研发仓库**，面向维护 SDK、运行时、渲染器、编译器和开发工具的贡献者。制作游戏请在独立目录安装 npm 包，无需下载、克隆或构建此仓库。

```sh
mkdir my-game
cd my-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

游戏开发 AI 从 [npm 游戏开发入口](docs/npm/GAME-AUTHOR.md) 开始。完整引擎构建产物由 `pelican-engine` npm 单包分发，CLI 为 `pelican`。

```sh
npx pelican capabilities
npx pelican api --search pointer
npx pelican recipe --id pointer-3d
```

路径追踪、交互模拟与大世界各有实际支持边界，不承诺所有设备的画质和帧率。先看[能力说明](docs/CAPABILITIES.md)，再选择适合游戏的配置。我们正在把可复用算法、明确的资源生命周期与可观测工具结合起来，让复杂游戏也能由代码持续迭代。

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
