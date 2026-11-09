<p align="center"><img src="docs/assets/pelican-mark.svg" width="144" alt="Pelican Engine 鹈鹕标识" /></p>

<h1 align="center">Pelican Engine · 鹈鹕游戏引擎</h1>

<p align="center"><strong>自由写游戏，让 AI 高效上手。</strong><br />TypeScript 的自由 · WebGPU 的画面 · AI 可读的工具链</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pelican-engine"><img src="https://img.shields.io/npm/v/pelican-engine?label=npm&color=087f8c" alt="npm version" /></a>
  <a href="https://github.com/danchar12138/pelican-engine/actions/workflows/npm-publish.yml"><img src="https://github.com/danchar12138/pelican-engine/actions/workflows/npm-publish.yml/badge.svg" alt="Build, test and publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-247047" alt="MIT license" /></a>
</p>

<p align="center"><a href="docs/npm/GAME-AUTHOR.md">开发指南</a> · <a href="docs/npm/INTEGRATIONS.md">依赖与扩展</a> · <a href="docs/CAPABILITIES.md">能力说明</a> · <a href="https://github.com/danchar12138/pelican-engine/releases/latest">最新发行</a></p>

Pelican Engine 是面向 AI 编码工具的开源游戏引擎。**一个 npm 包，带齐 SDK、运行时、渲染器、编译器与 CLI。** 无需可视化编辑器，不绑定特定 AI 平台。

## 为什么选择 Pelican

- **玩法自由组合。** 普通 TypeScript、自定义模块与 npm 组件一起用，不必套专用语法或固定玩法。
- **默认路径追踪。** PBR 与时域/空间降噪，混合、光栅作为可选档，支持预热与受管渲染扩展。
- **开发不止渲染。** 实体、物理、动画、UI、音频与存档，组成完整游戏基础。
- **AI 有据可查。** 起步指南、精确 API、完整配方和结构化诊断，连接查询、运行与修复。
- **交付保持简单。** Windows、macOS、Linux 开发，构建后部署到普通静态服务器。

## 开始制作

需要 **Node.js 24.x 和 npm**。在独立目录安装，**不用克隆引擎仓库**：

```sh
mkdir my-game
cd my-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

`dev` 在空项目中生成起步游戏，不覆盖已有内容；`--prefix .` 避免误装进 parent 项目。发布游戏运行 `npx pelican build`，部署生成的 `dist/`。

## 给第一次使用的 AI

```sh
npx pelican guide
npx pelican guide --goal "让角色跳跃并保存游戏"
npx pelican api --symbol StorageService.save
```

按任务找到能力、精确方法与完整配方，查询失败也有下一步候选。新项目自带 `AGENTS.md`；不必猜接口或通读引擎源码。

## 用自己的方式扩展

`npm install <package>`，把自己的算法、组件和内容接进游戏。浏览器依赖通过 `runtime.create` 初始化，渲染模块通过 `defineRenderExtension` 组合。内置玩法服务可选，不替你规定规则。[接入指南](docs/npm/INTEGRATIONS.md)。

默认高档 path 需要 WebGPU；中档 hybrid、低档 raster 可选，WebGL2 需显式选择低档。路径追踪使用软件 BVH，实际画质与性能需按场景验证。[能力说明](docs/CAPABILITIES.md)。

<!-- contributor-only:start -->
## 参与开发

**这个仓库用于维护引擎，制作游戏使用 npm。**

[贡献指南](CONTRIBUTING.md) · [架构](docs/ARCHITECTURE.md) · [更新记录](CHANGELOG.md) · [发布流程](docs/RELEASING.md) · [报告问题](https://github.com/danchar12138/pelican-engine/issues)
<!-- contributor-only:end -->

## 许可

[MIT](LICENSE)。第三方依赖与资产遵守[各自许可](docs/THIRD-PARTY-NOTICES.md)。
