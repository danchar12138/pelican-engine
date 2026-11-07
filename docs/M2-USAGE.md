# M2：游戏切片开发入口

当前版本 `0.2.0-m2.0` 为游戏切片预发布，已通过完整 M2 门禁与独立 AI 验收，实际结果以 `evidence/m2/acceptance.json` 为准。M2 不等于完整首发，M3–M8 的全部能力仍须逐项完成。

## 准备与创建

Windows 下可从 GitHub、ZIP、解压目录或外部引擎路径开始，不要求 Git、账号或专用 AI 平台。只修改游戏目录，游戏代码仅导入 `pelican-engine`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" setup --install-browser
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" create --project "<new-game>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" check --project "<game>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" dev --project "<game>" --port 4173
```

`create` 复制 M2 完整示例和素材并配置本地引擎引用；不会覆盖已有目录。项目清单 `engine.path` 按游戏目录解析，`engine.version` 必须精确匹配。准备好缓存后可用 `setup --offline`；模型和素材生产方式不由引擎限制。

## 公开编程面

- 内容定义：`defineComponent/definePrefab/defineScene/defineAsset/defineMaterial/defineSystem/defineGame`；`game.scenes` 定义额外场景。
- 实体：`entities.spawn({id,prefab,transform,components})` 按编译预制体默认值生成，`entities.destroy` 在阶段边界提交。省略 prefab 创建仅含变换和组件的逻辑实体。实体句柄在恢复后须重新解析。
- 输入：`game.input` 将 action 映射至 `KeyboardEvent.key` 字符串，`ctx.input.held/pressed/released/axis` 读取固定 tick 状态，Space 是单个空格。UI 按钮可映射 `ui:<id>`；同 tick 按下与释放会保留 pressed 边沿。
- 角色：`character` 定义胶囊，`physics.moveCharacter` 提交下一物理步 XYZ 位移；`setVelocity` 设置持续速度，正 Y 跳跃。角色 gravity 是向下加速度大小，默认 9.81；场景 gravity 为带符号向量。
- 物理：声明 `rigidBody`，使用速度、冲量、射线及碰撞/触发事件。射线可传 `{exclude:[entity],includeTriggers:false}`。所有第三方对象都由引擎持有。
- 模型与动画：`model.asset/scale/offset/rotation/animation/castShadow/receiveShadow`；`ctx.animation.play/state` 支持片段切换和淡入。GLB 使用私有 GLTFLoader，骨骼和 Morph 实例独立。
- 相机：`scene.follow`、`ctx.camera.follow/orbit`；smoothing 为 0–1 的每 60 Hz 插值比例，0 表示立即跟随。跟随相机通过物理射线避开遮挡物。
- 光栅：GLB PBR/纹理、sRGB、阴影、环境照明；`scene.environment.lighting: "studio"` 是显式 IBL 预设。方向光支持 target 和 shadow mapSize/extent/bias/normalBias/near/far。
- 资产优化：`optimize --project <game> --asset <id> --output <新.glb>` 显式生成无损优化文件，合并位级相同的顶点及重复资源，保留动画和材质名称，不覆盖原文件。源码采用优化产物前需显式更新资产路径。`build` 额外生成可选 `.br/.gz` 及 `compression-manifest.json`；普通静态服务器可选择配置 Content-Encoding 协商，原始文件始终保留。
- UI：`game.ui` 声明 text/bar/button/input，使用 `ctx.ui.setText/setProgress/setVisible`。输入框的 `text` 是内容，组合输入只在提交时发送 `ui.text`，Enter 发送 `ui.submit`；按钮发送 `ui.activate`，焦点发送 `ui.focus`，payload 均为普通数据。`world:{entity,offset,occlude}` 将控件锚定到实体，offset 为世界空间偏移，遮挡或离开视锥时不可见、不可点、不可聚焦。输入焦点消费玩法键盘输入，聚焦文本框时释放已按下的映射键。0.6.1 开发批次还提供 `ctx.ui.create/remove/get/setLayout` 及动态控件代次，详见 npm 使用指南；输入、布局与快照尚未运行验证。基础子集不代表 M6 完整 UI。
- 音频：`game.sounds`、`ctx.audio.play/stop/volume`。逻辑 voice ID、音量与已知时长按固定 tick 管理；浏览器禁止自动播放时仅音频等待真实手势，不阻塞 GPU、玩法或测试。
- 存档与场景：`ctx.storage.save/load/status`、`ctx.scenes.current/load`。请求在完整 tick 之后由平台执行，失败保留当前场景并输出状态；存档绑定引擎、游戏与资产哈希。每 tick 只接受一个存档/切场景请求。

系统阶段为 `input → prePhysics → physics → postPhysics → update → presentation`。游戏系统声明 `reads/writes` 与 `structural`；时间、随机、事件和跨 tick 状态使用公开服务或组件，不用模块闭包承载必须恢复的状态。源码入口、Schema 与完整签名见 `packages/sdk/src/index.ts` 和 `docs/api/REFERENCE.md`。

## 示例与无人值守测试

默认示例 `examples/m2/game.ts`：WASD/方向键移动，Space 跳跃，E 收集，F5 保存，F9 读取，R 重开，Q/T 旋转相机；B 生成刚体箱子，N 生成一只胶囊碰撞角色，用于验证公开预制体生成与存档。任务是回收三件物品、躲避巡逻障碍、进入北侧门，再可从通关场景读取旧存档。

普通页面自动运行，无需点击或回车。仅开发版 `?automation=1` 明确暂停。控制桥使用数值轮询和 Node 截止时间，启动不等待窗口激活或 GPU 队列完成通知。游戏 UI 不显示内部引擎状态，测试通过结构化 `inspect` 区分 paused 与 faulted。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" inspect --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" input --key w --pressed true --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" step --count 60 --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" input --key w --pressed false --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" capture --live --output "<game>\frame.png" --port 4173
powershell -NoProfile -ExecutionPolicy Bypass -File "<engine>\pelican.ps1" build --project "<game>"
```

`capture --live` 读取控制桥持有的当前页；独立 `capture --project` 建立冷会话。返回 JSON envelope 和退出码，负例不会被旧构建冒充成功。生产 `dist/` 部署到普通 Web 服务器，包括子路径，去除开发控制 API，不依赖原引擎目录或任何 AI 服务。

## 边界与下一步

素材检查当前支持自包含核心 GLB 2.0、受支持 PNG/JPEG、PCM/float WAV 与 binary；不支持的扩展、外部资源或编码明确报错。资源明细见 `packages/assets/README.md`。编译器检查损坏文件、片段名、来源声明和字节哈希，并输出 `asset-notices.json`；许可证字段不是引擎对第三方权利的担保。

GLB 纹理场景目前只允许 raster；hybrid/path 明确返回 `TC_TRACE_STAGE`，不静默使用无纹理近似。完整光追材质与动态 PT 属于 M3。物理历史快照目前有操作数和恢复成本限制，见 `packages/physics/README.md`；长期固定大小 checkpoint 仍须优化。完整模拟、大世界、2D/UI/音频、迁移与最终首发验收继续按 M4–M8 完成。
