# pelican M0：当前可执行入口

状态：M0 风险原型验收通过。以 `evidence/m0/acceptance.json` 的实际结果判断里程碑是否通过；本指引不代表完整引擎已经实现。现有 API 仅为 M0 实验子集。

## 从任意目录开始

开发环境为 Windows，PowerShell。引擎可来自 Git、ZIP 或复制目录，无需 `.git`。以下 `<engine>` 替换为实际引擎目录，路径包含空格或中文时保持引号。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" setup --install-browser
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" doctor
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" create --project "<new-game-directory>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" check --project "<new-game-directory>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" dev --project "<new-game-directory>"
```

启动脚本复用 Node 24；缺少兼容版本时，尝试下载校验官方 Node 24.15.0 ZIP 到引擎本地工具目录。依赖按锁文件准备，不全局安装、不要求管理员。不允许绕过机器政策；网络/政策阻塞应输出事实，不伪称可用。

`dev` 保持运行，输出 localhost 地址；停止用进程信号。默认端口 4173，冲突时 `--port 4180`。更改项目 TS/JSON 后重新编译并完整重载；当前没有保持任意运行状态的实时热替换。

## 游戏开发边界

只修改新游戏目录中的源文件、内容与测试。通过 `pelican-engine` 导入：

- 公开实现与类型：[packages/sdk/src/index.ts](../packages/sdk/src/index.ts)。
- 当前编译规则和产物：[CONTRACT.md](../experiments/compiler/CONTRACT.md)。
- 可复制样板：[examples/m0/game.ts](../examples/m0/game.ts)。

组件、预制体、场景、材质/计算图和系统通过声明函数表达。编译期不会执行任意模块副作用。普通玩法写在 `defineSystem({run(engine,dt){...}})`，通过 EngineFacade 查询与修改状态。当前不支持任意 TS 静态求值，不允许导入内部渲染和底层依赖。

声明验证或类型失败时，命令返回 `status: failed`，诊断包含错误码、源文件、行、列和修复建议。修复后重新运行 `check`；旧的成功产物不能冒充当前失败构建。

## 构建与截图

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" capture --project "<game>" --mode path --output "<game>\capture.png" --port 4181
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" build --project "<game>"
```

外部项目输出 `<game>/dist/`，放到 Web 服务器即可运行。不能用 `file://` 代替 Web 服务。默认发布版剔除 `window.__pelican` 开发控制；玩家不依赖模型、开发服务或原引擎目录。

当前发布演示包含私有渲染/模拟探针舞台，是 M0 测试壳，不是成品游戏模板。材质仅支持文档列出的简单节点，路径追踪是软件三角 BVH 和简化积分；混合模式是光栅与追踪图像的合成试验，尚非完整材质分解集成。不要把它描述为生产级渲染器。

## 自动观察与测试

开发版页面提供 `window.__pelican`，由外部浏览器自动化调用。常用操作：

- `inspect()`：当前实体、组件、渲染模式、几何版本和诊断。
- `step(n)`：固定步推进真实玩法和当前模拟。
- `mode('raster'|'hybrid'|'path')`：切换原型模式。
- `compute('pulse', time)`：运行编译后的受控计算图，返回 GPU 读回和 CPU 参考值。
- `simulation('rope'|'cloth'|'softbody'|'fluid')`：装载实验模拟。
- `snapshot()` / `restore(saved)`：探针状态保存恢复，非完整长期存档承诺。
- `camera(phase)` / `topology()`：动态相机和几何变更探针。
- `accumulate(n)` / `pixels()` / `gpuTimeMs()`：静态采样、读回统计和可用的追踪 compute 时间。

这些是开发测试接口，不能从游戏源码直接调用。游戏仍通过公开 SDK 编写。真实键盘 `ArrowRight`/`ArrowLeft` 会驱动示例实体，便于验证浏览器输入链。完整验证入口 `npm run verify:m0`；需要真实 GPU，不能用软件后端替代性能结论。
