# 参与开发

感谢关注 Pelican Engine！本项目使用 MIT 许可证。游戏作者可以只安装 npm 包；本指南面向需要阅读、修改或维护引擎源码的贡献者。

## 开发前

请先阅读 [当前研发状态](docs/STATUS.md)、[架构](docs/ARCHITECTURE.md) 和与你的改动有关的文档。确认改动范围、现有工作区状态和已知限制，不覆盖他人的未提交文件。公开 API 由 SDK 源码定义；改动接口时应同时维护相关类型、文档和示例。

当前支持的引擎开发环境为 Windows，使用 Node.js 24.x 和 npm。以下是通用 Node/npm 命令的写法，不代表其他开发系统已经受支持。玩家端按实际浏览器与图形能力判断，不设置平台白名单。

## 从源码运行

```sh
git clone https://github.com/danchar12138/pelican-engine.git
cd pelican-engine
npm ci
npm run dev
```

`npm run dev` 使用仓库当前默认示例；`npm run build` 将示例静态构建输出到根目录 `dist/`。源码 ZIP 和已有目录也可以使用这些命令，不依赖 Git 元数据。若只是创建游戏，请优先阅读 [快速入门](docs/GETTING-STARTED.md)。

## 单线、单主题提交

- 在 `main` 主工作树按依赖串行工作，不建立额外工作树或开发分支。
- 一次提交围绕一个功能、修复或版本；不要把无关工作和历史证据混在一起。提交消息使用中文 Conventional Commits，例如 `fix(renderer): 修复资源释放`。
- 需要发布时在仓库中显式维护统一的标准版本号。推送 `main` 会触发 npm OIDC 发布；版本已存在时不会覆盖。GitHub Release 用于标记里程碑。详见 [发布说明](docs/RELEASING.md)。
- 用户要求当前只允许编译和构建；不要运行测试、浏览器、GPU、性能、smoke 或其他验证，也不要声称未执行的步骤通过。以前的测试文件和证据保留其历史属性。
- 不要为整理目录而删除未经确认的用户数据、历史报告或未合并候选；不能递归跟随目录链接或 junction。

## 提交问题或改动

描述目标、涉及的公开接口、实际运行的编译或构建命令、结果与已知缺口。运行或硬件行为未经验证时明确说明。涉及第三方代码或资产时记录来源与许可证；不要提交凭据、开发缓存或构建输出。

- [问题反馈](https://github.com/danchar12138/pelican-engine/issues)
- [公开 API](docs/api/REFERENCE.md) · [能力说明](docs/CAPABILITIES.md) · [开发状态](docs/STATUS.md)
