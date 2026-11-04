# candidate5 狐狸货运站外部游戏复验

sourceSHA: `857f76bd1d85de6d0e05b8ce5b08a2009b7d74b5692f38dbda39ed76ca5d44a2`

archiveSHA: `4d258d9140b3b5f2cc77770b1c2e714ecdaa3ed958af7e9324f5013bfa307deb`

引擎 `../candidate5/threecat`；游戏 `../外部游戏 空格`；原 `../report-candidate4` 完整字节保留，没有修改其报告身份。游戏源码逐字节保持；仅项目 engine.path 切换，故意错误动画测试期间的修改已修回。

本报告仅证明独立货运游戏和列出的附加接触退回场景通过，不是引擎 M2 全矩阵完成声明。

## 字节与差异审计

`audit.cjs` 同时验证 ZIP archiveSHA、candidate4 的 191 文件旧审计、candidate4 报告全部文件哈希、游戏源码、candidate5 的 195 文件 source-before/after。身份 sourceSHA 来自用户冻结声明，并以经过验证的 ZIP 及完整文件哈希绑定；不把其他哈希算法输出冒充该源码身份。

candidate4 → candidate5 变化记录在 `candidate4-to-candidate5-diff.json`：5 个修改文件（物理实现及 README、physics 单测、M2 验证器、M2 报告）和 4 个新增文件（physics-risk 场景及清单说明、物理 probe）。SDK 与编译器逐文件相同。只枚举/哈希交付文件，没有读取主线或使用交付 probe 的实现做游戏。

## 运行与复现

规范命令为 `flow.json.commands` / `commands.json`，每条包含 argv、实际退出码、工作目录、shell 与原始 stdout/stderr 路径。非故意负例全部退出 0。`negative-clip` 退出 1，`TC_MODEL_CLIP` 指向 `game.ts:96:134`；修回 Survey 后 check 通过。

复用 candidate4 的 `gameplay.cjs` 和 `production.cjs`，仅替换候选引擎引用；货运测试逻辑保持不变。`gate-retreat.cjs` 为附加独立测试，仅用真实键盘、文档公开 inspect/step；没有 setComponent、snapshot restore、传送角色或私有物理库调用。没有改变游戏以绕过物理修复。

游戏流程：E 牵引真实动态箱；W 运到称重台；闸门升起；绕过箱子到终点任务计数增加一次；E 用券兑换疾速；按钮保存，刷新后恢复，另新页面恢复。真实狐狸 GLB Survey/Walk 动画及 SDK UI；测试断言重力速度、落地、货箱水平位移、闸门、计数、券及疾速、存档状态。

`offline.cjs` 拒绝 Node HTTP/HTTPS/fetch/TCP，仅允许工具 IPC 命名管道，同时 npm offline。setup/check/build 成功，setup 明确复用 Chromium 1248 与锁定依赖。未下载浏览器。

`publish.cjs` 将最后一次 offline build 的 dist 40 文件复制到全新 `deployment-candidate5/arcade/fox-freight`，避免保留旧候选 bundle。`build-output/manifest.json` 对所有文件记录字节、SHA-256，finalize 再核对 dist 与独立静态部署逐字节一致。

生产测试只用键盘及按钮，阻止站外请求；从 /arcade/fox-freight/ 冷启动、游戏自动运行、任务/奖励、保存刷新恢复、无 window.__threecat 和控制路由，非 fallback NVIDIA WebGPU 与场景像素检查均通过。`01`–`10` PNG 为运行图像；报告内不重复完整第三方素材、node_modules、浏览器或 dist。

## 保留的非预期尝试

所有尝试在 `raw-command-log/commands.json`；意外失败不标 expectedFailure。

1. 第一次门测试导航发生在 dev 监听就绪前，ERR_CONNECTION_REFUSED。显式 HTTP 就绪轮询后运行成功；未重启或修改引擎。
2. 第二次接触后的 20 步退回实测约 0.812，初版断言要求 >0.9 导致失败。这证明已能退回，但没有达到接近理想全速的初始门槛。原检查点与截图保留在 attempts。最终断言使用 >0.7（超过两倍角色半径）确认退出接触范围，再追加 30 步要求累计 >2.1，证明持续退回；首次接触后第一步退回 >0.025 的要求未降低。测试不宣称每个接触 tick 均保持理想速度。

`cleanup.json` 验证自启动 dev/static 端口关闭；浏览器在每个脚本 finally 中关闭；`process-audit.json` 为进程复核。
