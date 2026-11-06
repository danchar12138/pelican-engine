# 快速入门

本指南介绍两种使用方式：**用 npm 制作游戏**，或**从源码仓库运行引擎和游戏**。两者使用同一个 `pelican-engine` 公开 SDK；一般游戏项目不需要引擎源码。已有功能及未完成项请先阅读 [当前研发状态](STATUS.md)。

## 环境

- Node.js 24.x 和 npm；仓库及 npm 包当前声明的 Node 版本范围为 `>=24 <25`。
- 当前支持的引擎与游戏开发环境为 Windows。本指南中的命令使用通用 Node/npm 形式，不要求特定 shell；**不代表 Linux 或 macOS 开发流程已经受支持或完成验证**。
- 玩家端无操作系统或浏览器品牌白名单，实际可用的 WebGPU、WebGL2 和图形能力取决于设备、浏览器和运行环境。
- 首次安装依赖需要网络。浏览器截图等自动化功能还需要按需安装 Playwright Chromium；普通启动与构建不要求先安装它。

## 方式一：使用 npm 开始游戏

在空目录中安装引擎并启动开发服务：

```sh
mkdir my-pelican-game
cd my-pelican-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

`--prefix .` 将安装目标明确指定为当前目录，避免 npm 选中父级项目；`--save-exact` 将安装版本锁定在游戏项目中。首次 `dev` 在允许的空目录里生成：

```text
my-pelican-game/
├── game.ts                 # 游戏入口
├── pelican.project.json    # 入口及引擎版本锁
├── AGENTS.md               # 外部 AI 的游戏开发入口
├── package.json
└── package-lock.json
```

默认示例创建一个方块、相机、灯光和旋转系统。编辑 `game.ts` 以修改它；游戏侧从 `pelican-engine` 导入公开接口。CLI 不覆盖已有项目：如果目录已有其他文件而无法自动生成，请使用空目录，或显式创建项目。

停止开发服务后构建：

```sh
npx --no-install pelican build
```

产物位于游戏目录的 `dist/`。将整个目录部署到支持静态文件的 HTTP(S) 服务器，并保留其中的资源和许可文件。部署到子路径时，可使用 `npx --no-install pelican build --base /game/`。

查看命令与 API：

```sh
npx --no-install pelican help
npx --no-install pelican api
npx --no-install pelican api --symbol defineGame
```

项目锁与安装版本不一致时，应先迁移项目，再明确更新 `pelican.project.json` 中的版本；不要通过修改 `node_modules` 绕过诊断。更多使用细节见 [npm 分发指南](npm/DISTRIBUTION.md) 和 [Game Author 指南](npm/GAME-AUTHOR.md)。

## 方式二：从仓库使用引擎

需要研究引擎源码、尝试仓库示例或参与维护时，可以检出仓库：

```sh
git clone https://github.com/danchar12138/pelican-engine.git
cd pelican-engine
npm ci
npm run dev
```

这会启动当前仓库配置的示例。源码 ZIP 或已有目录也可以使用，不要求 `.git` 存在。使用源码为另一个目录创建最小游戏：

```sh
node --import tsx tools/cli.ts create --project ../my-source-game --template minimal
node --import tsx tools/cli.ts dev --project ../my-source-game
```

这些命令从**引擎目录**执行；新游戏在相邻的 `my-source-game` 目录中。CLI 会写入相对引擎路径和版本锁，游戏仍使用公开的 `pelican-engine` API。已有目标文件不会被覆盖。更多引擎开发说明见 [参与开发](../CONTRIBUTING.md)。

## 选择渲染模式

引擎优先尝试 WebGPU，必要时通过 Three.js 内置回退尝试 WebGL2 光栅。WebGL2 不提供依赖 compute 的混合光追、路径追踪或受控计算；能力不足时应读取诊断，不应把光栅结果当成光追。能力查询和错误码见 [渲染后端](RENDER-BACKENDS.md)。

## 已知边界

当前版本仍在研发；构建成功不证明画质、性能、硬件兼容或所有功能已经验收。当前用户约束禁止项目验证活动，因此仓库中的历史测试命令不是本次执行或通过的声明。实际局限、已知物理缺陷和历史证据入口见 [当前研发状态](STATUS.md)。
