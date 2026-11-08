# Pelican Engine：引擎贡献者入口

此仓库仅用于维护引擎。游戏开发者在独立目录安装 `pelican-engine`，使用 `pelican` CLI；不要克隆本仓库制作游戏。npm 单包包含 SDK、运行时、渲染器、编译器和 CLI，不维护另一套源码 SDK。

## 开发依据

- [贡献指南](CONTRIBUTING.md)：环境、命令、维护规则。
- [架构](docs/ARCHITECTURE.md)：当前实现与扩展边界。
- [能力说明](docs/CAPABILITIES.md)：查询能力与已知缺口。
- [发布](docs/RELEASING.md)：显式版本、检查、OIDC 分发。
- 游戏 AI 的独立入口：[GAME-AUTHOR](docs/npm/GAME-AUTHOR.md)。

公开类型的唯一信源是 `packages/sdk/src/index.ts`；能力元数据是 `packages/sdk/src/capabilities.ts`；命令协议是 `packages/protocol/src/index.ts`；项目配置是 `packages/compiler/src/version.ts`。API 文档、机器索引和 npm 声明从源码生成，不手写第二套接口。说明文档解释使用方式，不叠加历史阶段的产品禁令。

## 执行规则

1. 使用 Node.js 24 和 npm，支持 Windows、macOS、Linux。开发命令不依赖 PowerShell、管理员权限或固定路径。玩家按实际浏览器能力判断。
2. 在当前主线单工作树串行开发。修改前检查工作区；不覆盖未确认改动，不跟随 junction 递归删除文件。
3. 实现与修复应有适当的类型检查、测试、npm 安装回归。图形变化按需运行浏览器与真实后端检查。编译不等于运行通过，未执行的平台或能力必须明确说明。
4. 游戏内容可使用普通 TypeScript 与浏览器兼容的 npm 依赖。不要为维护自制语法子集继续加无必要限制。原有静态内容模式保留兼容。
5. 引擎提供通用运行时与稳定服务；游戏规则可由作者自行组合。不要强迫使用内置背包、任务等配方，也不把内部 Three.js/WASM 对象当作稳定插件协议。
6. WebGPU 优先，使用 Three.js WebGPURenderer 自带的 WebGL2 光栅回退。能力不满足应给出诊断；不伪称硬件光追，不凭一次对比宣称超过所有 Three.js 应用。
7. 错误提供稳定错误码、相关源文件或资源标识和修复建议。测试输出、截图、临时包放 `.pelican/` 或 CI artifacts；不提交运行证据、node_modules 或构建产物。
8. 使用中文 Conventional Commits。发布前显式更新一致版本，主线推送触发 OIDC 发布实际版本，不覆盖已发布 npm 版本、不使用长期令牌。失败如实报告。

历史阶段文档与原始证据保留在既有 Git 历史、标签及发布附件中，不构成当前研发约束。
