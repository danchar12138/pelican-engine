# 能力与边界

当前功能状态与精确符号通过 `npx --no-install pelican capabilities` 查询；该结果由 `packages/sdk/src/capabilities.ts` 维护。公开签名通过 `pelican api --search <query>` 或 `--symbol <name>` 查询，来自同一 SDK 源码。实现元数据不代表每种设备、规模与组合均已通过运行验证。

首次 npm 使用从 `pelican guide` 开始，简短任务用 `guide --goal <关键词>`。全目录有兼容的完整形式和可选 `--summary` 摘要；摘要／完整形式均支持 `--limit/--offset`，依据 `total/truncated/nextOffset` 翻页。普通 TypeScript 与浏览器兼容 npm 组件是正式创作方式，不存在算法依赖白名单或强制内置玩法 DSL。

| 能力 | 使用入口 | 主要边界 |
| --- | --- | --- |
| npm 独立开发 | `pelican create/dev/check/build` | Node.js 24，Windows/macOS/Linux；平台检查结果以实际 CI 为准 |
| 普通 TypeScript 内容 | 项目 `content: "typescript"` | 可信的跨 Node/浏览器模块初始化、有限数据、同步系统、构建截止时间 |
| 旧静态内容 | `content: "static"` 或省略 | 非执行式语法子集与 runtime libraries 配置，仅作兼容/可选入口 |
| 通用玩法与作者实例 | 组件、系统、runtime.create、scope.own/defer、版本化保存 hooks | 同步系统；异步初始化等待 ready；闭包和第三方对象需要显式 JSON 状态协议 |
| 外部组件与 Worker | createRuntimeAdapter、scope.own(resource, release)、scope.listen | 有界消息与明确所有权；模块 Worker 分包；不等于内置网络同步、字节沙箱或自动回放 |
| 图形 | 光栅、混合/路径追踪、受管几何、PBR 贴图、材质/计算/后处理图、API v1 渲染扩展 | compute 依赖 WebGPU；软件 BVH 非硬件光追；不保证所有动态组合或帧率 |
| 刚体与交互模拟 | physics/physics2d、ropes、cloth、fluid、softBodies | 各服务有不同交互范围；不能等同成熟统一的多物理求解器 |
| 输入与界面 | 键盘、手柄、指针、UI、音频 | 指针锁和音频解锁需要可信用户交互；实际设备支持需浏览器探测 |
| 场景和资源 | prefab、scene、streaming、terrain、animation | chunk residency 不等于完整异步大世界资产流送；骨骼 grounding 不等于布娃娃平衡 |
| AI 工具 | JSON CLI、api、capabilities、recipe、batch、capture | 批处理预检查不是事务回滚；图像捕获需要浏览器桥接 |

图形细节见 [GRAPHICS-GUIDE](GRAPHICS-GUIDE.md) 与 [RENDER-BACKENDS](RENDER-BACKENDS.md)；模拟、地形、动画、过场各自有独立使用指南。配方是可组合起点，不是玩法强制框架。

API v1 渲染扩展组合现有受管资源、图与实例生命周期；任意 Three.js/TSL 内部对象接入仍没有稳定契约。联网同步游戏框架与完整资产异步流送体系仍是缺口。普通 TypeScript 与 npm 依赖解决语言和算法自由度，不会自动补足这些系统。画质、效率和 AI 任务成功率应通过相同任务与预算比较，不能仅用功能数量推断。
