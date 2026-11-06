<div align="center">
  <img src="docs/assets/pelican-mark.svg" alt="Pelican Engine" width="120" height="120">
  <h1>Pelican Engine</h1>
  <p><strong>用 TypeScript 构建面向 Web 的游戏。</strong></p>
  <p>代码优先 · WebGPU 优先 · 面向人和外部 AI 的开发工作流</p>
  <p>
    <a href="https://www.npmjs.com/package/pelican-engine"><img src="https://img.shields.io/npm/v/pelican-engine?label=npm&amp;color=168b80" alt="npm version"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-24536b" alt="MIT license"></a>
    <img src="https://img.shields.io/badge/TypeScript-SDK-3178c6" alt="TypeScript SDK">
    <img src="https://img.shields.io/badge/rendering-WebGPU%20%7C%20WebGL2-337d82" alt="WebGPU and WebGL2 rendering">
  </p>
  <p><a href="#快速开始">快速开始</a> · <a href="docs/GETTING-STARTED.md">使用指南</a> · <a href="docs/api/REFERENCE.md">API 参考</a> · <a href="docs/STATUS.md">当前状态</a> · <a href="#参与开发">参与开发</a></p>
</div>

---

Pelican Engine 是一个开源、代码优先的游戏引擎。它提供 TypeScript SDK、编译器、运行时、渲染器和命令行工具，帮助你用代码定义场景、材质和玩法，再构建可部署的 Web 游戏。游戏可以由人编写，也可以由外部 AI 编码工具协助；**游戏运行时不内置大模型或 AI 智能体**。

> **研发状态**：项目仍在开发中，不是完整首发引擎。当前源码的运行、硬件、性能与完整功能尚未经过完整验收。发布版本使用普通版本号，但这不等于上述项目已经验证通过。已知物理生命周期缺陷和其他限制见 [当前研发状态](docs/STATUS.md)。

## ✨ 能做什么

- **以 TypeScript 定义游戏**：通过 `pelican-engine` 的公开接口组织场景、实体、材质和玩法系统。
- **面向现代 Web 渲染**：优先使用 WebGPU；不可用时通过 Three.js 内置机制尝试 WebGL2 光栅回退。依赖计算能力的功能不可用时会返回诊断，不静默冒充支持。
- **渲染与图形扩展**：已有光栅、混合光追和路径追踪研发实现，以及受控材质、后处理和计算接口；具体支持边界见 [能力说明](docs/CAPABILITIES.md) 和 [渲染后端](docs/RENDER-BACKENDS.md)。
- **从游戏到静态构建**：命令行提供开发服务、构建与结构化诊断；游戏构建输出到 `dist/`，可交给普通 Web 服务器。
- **AI 友好的代码工作流**：公开 API、错误信息和项目文档可供外部编码工具使用；不要求游戏玩家使用 AI 服务。

## 🚀 快速开始

准备 Node.js **24.x** 和 npm，在一个新的空目录中运行：

```sh
mkdir my-pelican-game
cd my-pelican-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

首次启动时，CLI 会在符合条件的空项目中生成 `game.ts`、`pelican.project.json` 和游戏开发说明；已有项目文件不会被覆盖。安装命令中的 `--prefix .` 用于避免 npm 意外选择父级项目。停止开发服务后，构建游戏：

```sh
npx --no-install pelican build
```

将生成的 `dist/` 内容部署到 HTTP(S) 静态网站。示例、项目结构、外部目录和部署说明见 [快速入门](docs/GETTING-STARTED.md)；完整游戏开发入口见 [Game Author 指南](docs/npm/GAME-AUTHOR.md)。

> 命令采用通用 npm / Node 写法，不绑定特定 shell。**引擎开发与游戏开发目前仅以 Windows 为支持范围**；Linux 和 macOS 的开发流程尚未承诺或验证。玩家端不按操作系统或浏览器品牌设白名单，而是检测实际图形能力。详见 [后端说明](docs/RENDER-BACKENDS.md)。

## 📚 文档导航

| 我想…… | 从这里开始 |
| --- | --- |
| 安装引擎、创建游戏或使用源码开发游戏 | [快速入门](docs/GETTING-STARTED.md) |
| 查看公开类型和接口 | [API 参考](docs/api/REFERENCE.md) · [API 索引](docs/api/index.json) |
| 了解能力、限制和后续计划 | [当前状态](docs/STATUS.md) · [能力说明](docs/CAPABILITIES.md) · [研发计划](docs/ROADMAP.md) |
| 了解后端选择和诊断 | [渲染后端](docs/RENDER-BACKENDS.md) |
| 让外部 AI 使用引擎制作游戏 | [Game Author 指南](docs/npm/GAME-AUTHOR.md) |
| 修改引擎或准备发布 | [参与开发](CONTRIBUTING.md) · [发布说明](docs/RELEASING.md) |

仓库也保留历史使用文档、实验和证据；它们对应各自记录的旧版本，不代表当前源码已经通过同样的检查。

## 🛠️ 参与开发

引擎源码采用 MIT 许可证。想要研究实现、贡献修复或从源码启动示例，可克隆仓库并安装锁定依赖：

```sh
git clone https://github.com/danchar12138/pelican-engine.git
cd pelican-engine
npm ci
npm run dev
```

源码方式与 npm 方式共用公开 SDK；一般制作游戏推荐先使用 npm，只有需要研究或维护引擎时才需要源码。详细的源码工作流、当前编译约束和贡献边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 许可证

引擎自有代码使用 [MIT License](LICENSE)。第三方依赖和示例资产的来源与许可分别记录在 [第三方声明](docs/THIRD-PARTY-NOTICES.md) 和对应资产说明中。
