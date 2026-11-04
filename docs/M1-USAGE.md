# M1：公开 SDK 与运行时开发入口

状态：M1 验收通过。版本为 `0.1.0-m1.0`，结果见 `evidence/m1/acceptance.json`。这是基础运行时，不是完整首发引擎。

## 从 ZIP 或本地目录开始

Windows 开发环境，可将仓库地址、ZIP 或已有目录交给外部 AI。引擎不要求 Git，也不要求游戏位于引擎目录。下面 `<engine>`、`<game>` 都是路径占位，路径可包含中文与空格。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" setup --install-browser
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" doctor
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" create --project "<new-game-directory>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" check --project "<game>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" dev --project "<game>" --port 4173
```

启动流程优先复用 Node 24，否则下载并校验项目内工具链；依赖按照锁文件准备，不全局安装，不要求人工管理员步骤。缓存已齐备时可 `setup --offline`。不在运行时接入模型或 AI 智能体。

`dev` 是长驻本地进程，输出状态 `running` 与地址。普通开发页和生产 `dist` 初始化后自动运行，无需点击或按回车。控制桥和截图工具打开的 `?automation=1` 测试页才明确暂停，以便确定性地操作，并显示 `paused · automation`，不是仍在等待 GPU。端口冲突时换一个端口，不停止未知服务。关闭时终止自己启动的 dev 进程；其控制浏览器也会关闭。

## 编写游戏

只修改游戏目录，通过 `@threecat/sdk` 导入定义。参考 [M1 示例](../examples/m1/game.ts)、[公开 SDK](../packages/sdk/src/index.ts)、[生成 API 索引](api/REFERENCE.md) 和 [编译契约](../packages/compiler/README.md)。

- 数据：`defineComponent`、`definePrefab`、`defineScene`、`defineMaterial`、`defineCompute`、`defineAsset`。
- 行为：`defineSystem` 的同步 `run(engine, dt)`。不要在模块顶层执行游戏副作用。
- 时间：`engine.time.tick/elapsed/fixedDt`，单位为模拟 tick 与秒。
- 随机：`engine.random()`，状态随快照和录放保存，不使用 `Math.random()` 表达可复现玩法。
- 事件：`engine.emit(type, payload)`；在下一 tick 由 `engine.events(type)` 读取，数据必须可序列化。
- 实体：`engine.entities.resolve(id)` 获取代际句柄；`isAlive` 检查。销毁或恢复前的句柄失效，应从稳定内容 ID 重新解析。
- 结构修改：`engine.entities.spawn/destroy/addComponent/removeComponent` 排队，在阶段边界提交。当前动态创建只保证组件与变换，完整可视预制体实例化将在 M2 扩展，不把空实体冒充带资产角色。

系统阶段固定为 `input → prePhysics → physics → postPhysics → update → presentation`。用 `before/after` 表达依赖，用 `reads/writes` 声明组件访问，`Transform` 是内置数据；结构修改需 `structural: true`。

```ts
const rotate = defineSystem({
  id: "rotate", phase: "update",
  reads: ["Motion"], writes: ["Transform"],
  run(engine, dt) {
    for (const id of engine.query(Motion)) {
      const speed = engine.getComponent(id, Motion).speed;
      const transform = engine.getTransform(id);
      engine.setTransform(id, { rotation: [0, transform.rotation[1] + speed * dt, 0] });
    }
  },
});
```

显式空权限数组不授权。未声明权限的 M0 风格源码保留兼容，但新游戏应明确声明。循环、缺失依赖、逆阶段依赖、非法访问在编译或运行时报告；故障 tick 不计为成功，并暂停，恢复已知有效快照后才能继续。

## 不写浏览器脚本也能检查运行态

保持 dev 进程运行，在另一个终端调用相同引擎入口，端口必须一致。控制桥惰性打开真实 headed 浏览器，并保持同一个会话。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" inspect --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" inspect --entity spinner --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" input --key ArrowRight --pressed true --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" step --count 30 --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" snapshot --output "<game>\checkpoint.json" --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" step --count 10 --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" restore --file "<game>\checkpoint.json" --port 4173
```

`input` 只是排队，下一次 `step` 才消费；真实键盘在显式暂停测试画面中自动推进一个 tick，以便观察。不应混用手动步进和后台 `resume` 来做确定性测试。`pause/resume` 控制自动推进。

就绪检查不依赖动画帧、窗口焦点或人工输入。工具使用数值轮询和 Node 侧截止时间，初始化与 GPU 提交也有超时诊断；页面被覆盖不能成为测试无限等待的理由。后台定时器相关设置仅用于外部开发测试浏览器，不作为玩家环境或 GPU 功能限制。

`inspect --offset 0 --limit 100` 可限定输出；它是分页响应，不代表 GPU 资源可直接操作。使用稳定实体 ID 或诊断返回的位置定位源代码，不导入内部模块。

## 录放、失败和恢复

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" record --action start --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" input --key ArrowLeft --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" step --count 20 --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" record --action stop --output "<game>\trace.json" --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" replay --file "<game>\trace.json" --port 4173
```

录放覆盖引擎控制的世界、时钟、随机、事件和输入，不保证任意闭包状态、外部 IO、GPU 或跨设备逐位相同。快照不是任意版本通用存档；内容重载后不匹配的快照明确拒绝。

命令返回 UTF-8 JSON envelope：`protocolVersion/taskId/status/diagnostics/artifacts/data`。失败检查退出非零，不把旧成功产物当成当前构建。`status` 查询任务；`cancel --task <id>` 取消任务。运行任务取消或超时会丢弃控制会话并报告 `stateReset: true`，需要 `reset-session` 明确建立新会话，不承诺保留被取消状态。

改源码后执行增量构建与明确的冷重载；M1 不宣称任意状态热替换已经完成。项目锁定版本；不同引擎版本需显式迁移，不自动升级或修改引擎来绕过缺口。

## 截图和发布

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" capture --project "<game>" --mode raster --output "<game>\raster.png" --port 4181
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" capture --project "<game>" --mode path --output "<game>\path.png" --port 4182
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\threecat.ps1" build --project "<game>"
```

默认 `capture` 启动独立冷会话。要捕获刚刚 `step` 的控制会话，使用 `capture --live --port 4173 --output "<game>\current.png"`，不必自行编写浏览器脚本。截图由外部开发控制桥读取真实页面，图像数据不会进入游戏逻辑或公开 SDK。

构建输出 `<game>/dist/`，部署到普通 Web 服务器；默认示例输出引擎根 `dist/`。支持子路径，不依赖开发服务、账号、AI 或原引擎目录。生产版不包含 `window.__threecat`，控制 HTTP 路由也只存在于 dev 服务。

## 需要直接使用浏览器自动化时

开发版 `window.__threecat.command(command)` 使用相同共享协议；这是测试接口，禁止游戏源码调用。`inspect/step/pause/resume/input/snapshot/restore/recordStart/recordStop/recordCancel/replay/mode` 均返回结构化结果。`window.__threecat` 旧 probe 方法保留用于内部回归；推荐使用共享协议，不依赖私有对象或 Three.js。

浏览器输入、帧推进和截图由外部工具执行，没有运行时智能体。GPU 验证必须检查真正的 WebGPU adapter，不能只依据截图或页面启动。生产光追、材质/纹理优化、完整角色/物理/UI/音频和大世界继续按 M2–M8 交付。
