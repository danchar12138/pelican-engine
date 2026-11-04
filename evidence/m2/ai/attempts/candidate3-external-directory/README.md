# 外部目录验收：狐狸货运站

最终候选 sourceSHA：77606289ee5e5ae5189c307d818b5b3aebf7021203b826de6b6f5822977284e4

最终候选 archiveSHA：23951c241183e834ccd3fcf76ea629b725e24f44cce8dc352ce9c29cc4d0737c

游戏在 flow 的 `外部游戏 空格`，引擎在 `candidate3/threecat`；不是引擎内项目。无 Git 依赖，没有读取主线，没有提交，没有修改引擎源码、SDK、工具或依赖实现。依赖由官方 setup 按交付 lock 安装，浏览器只读复用用户确认的 chromium-1248。

## 实际玩法

WASD 移动狐狸，靠近动态货箱按 E 连接；通过公开 physics.setVelocity 牵引货箱，不直接传送货箱。送到薄荷色称重台后自动验收，升起带碰撞的闸门。绕过卸下的货箱走入终点，任务计数增加一次，并获得一张运费券。在出口按 E 兑换 4.5 速度的疾速资格（原速度 3）。K/L 或 SDK UI 按钮保存与恢复。

`Dispatch` 组件保存牵引、交付、完成、计数、运费券、疾速资格及朝向。三个玩法系统使用 SDK 的输入、角色移动、物理、动画、UI、音频和持久化。狐狸 GLB 及 Survey/Walk 骨骼动画来自交付素材，来源与许可在游戏声明及 asset-notices 中。货箱是 mass=1.8 的 dynamic box prefab，运行时已断言下落速度、落地接触及水平运输位移。世界空间 UI 随货箱定位。

## 证据

- flow.json / commands.json：最终结果与规范命令；所有非预期步骤退出 0，故意动画负例退出 1。
- raw-command-log/commands.json：所有已捕获命令退出状态，包括意外失败；stdout/stderr 保持原文。
- negative-diagnostic.json / game-intentional-bad.ts：MissingCargoDance 导致 TC_MODEL_CLIP，定位 game.ts:96:134，修复为 Survey。
- gameplay-checkpoints.json：真实键盘与 SDK UI 操作推进，包含 NVIDIA WebGPUBackend 非 fallback、动态物理、开门、计数、奖励、刷新及新页面恢复前后状态。
- production-result.json：独立静态子路径冷启动，无开发 hook，控制路由 404；实际完成玩法、保存、刷新、恢复。
- 01–08 PNG：准备、运输、开门、保存、恢复及生产截图；production-result 包含排除 UI 区域的场景像素检查。
- build-output/manifest.json：实际构建所有文件、大小和 SHA-256。此处只保留小型构建清单与编译内容，不重复完整 dist 或第三方模型。
- all-engine-integrity.json 及各候选 before/after：原候选 183 文件、中间候选 191 文件、最终候选 191 文件均无变更；排除 node_modules、.threecat、dist 生成目录。
- cleanup.json / process-audit.json：自己启动的服务器进程与监听端口均已关闭，测试浏览器在 finally 中关闭。

## 复跑

在 flow 根使用 PowerShell，按 `commands.json` 的 argv 执行规范步骤。所有工具脚本属于 report 或游戏，没有修改交付引擎。可用 `node report/run.cjs <唯一日志名> ...` 捕获退出码和原始输出。

1. `candidate3/threecat/threecat.ps1 setup`，明确 `PLAYWRIGHT_BROWSERS_PATH` 指向用户已有锁定缓存。
2. `check --project "外部游戏 空格"`；负例可用 `node report/negative.cjs introduce`、check（预期失败）、`node report/negative.cjs repair`。repair 根据 negative-clip.stdout.txt 检查来源诊断。
3. `powershell.exe -NoProfile -File report/start-dev.ps1`，`node report/gameplay.cjs`。测试仅通过文档的控制 command inspect/step 读状态和固定步进；所有玩法推进用 Playwright 键盘或真实 UI click，没有 setComponent/restore 注入、位置传送或私有物理调用。
4. `node report/offline.cjs setup` / `check` / `build`：Node 网络由外部预加载脚本拒绝，仅允许本机命名管道 IPC，同时 npm offline；不改引擎或系统网络。成功 setup 明确复用缓存。
5. `node report/publish.cjs`，`powershell.exe -NoProfile -File report/start-static.ps1`，`node report/production.cjs`。普通静态服务器只读取 deployment，生产测试只用玩家界面和键盘，页面阻止所有站外请求。
6. `powershell.exe -NoProfile -File report/cleanup.ps1`，`node report/verify-all-engines.cjs`。

## 保留的意外失败与修复

这些失败不是故意负例，未伪装 expectedFailure：

- 初次内联 node -e 被 Windows PowerShell 引号处理破坏：改为独立 hash.cjs 后成功记录原始基线。
- 中间 ZIP 解压脚本的中文路径被 Windows PowerShell 按非 UTF-8 读取：脚本加 UTF-8 BOM 后核对 SHA 成功解压。
- 自设空浏览器缓存引起旧 session64223 重复下载并最终 TCSETUP_BROWSER_TIMEOUT，退出 1。根据活进程检查与最终 session 返回确认结束；随后只读复用已锁定本机缓存，最终候选 setup 成功。未把观察超时当作进程结束。
- 首次自动路线直行被卸货后的真实货箱挡住：保存失败状态与图像，改为键盘绕行，并补充游戏提示，完整通关和冷存档通过。
- 离线网络脚本的 Windows 反斜杠在 NODE_OPTIONS 中被解释：改为正斜杠；随后过严的 socket 拒绝误拦 tsx 本机命名管道，明确只允许命名管道，TCP/HTTP/HTTPS/fetch 继续拒绝，setup/check/build 均退出 0。
- 在离线构建未成功时尝试复制 dist 报不存在：仅在成功构建后复制并复验。
- 归档脚本曾错误假定 Rapier compat 必须输出单独 .wasm：删除这个无文档依据的文件后缀断言，改由独立生产真实重力与运输验收证明运行，仍保留失败日志。
- 初版命令捕获器使用匿名 stdin pipe，导致后台子进程继承 pipe 让启动步骤迟迟不返回；清理旧服务后一个延后执行的 discover 因服务已关而失败。命令捕获改为独立文件 stdout/stderr 与 ignore stdin；新 dev/static 启动均真实退出 0，随后再次完整跑通 gameplay 和 production。没有把延后 discover 当成游戏失败或通过证据。

没有确认的引擎/文档阻塞。中文 IME 与硬件手柄专项不属于本货运游戏验收范围，没有冒充硬件手柄专项通过。
