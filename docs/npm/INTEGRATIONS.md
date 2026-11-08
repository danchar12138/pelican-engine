# 普通依赖、运行实例与渲染扩展

游戏开发使用 npm 的 `pelican-engine`。普通 TypeScript 是创作语言；引擎的组件、图和服务是可组合能力，不要求所有算法都重写为引擎语法。

可以自由组织游戏源码、类、闭包、数据结构和自己的内容生成器，与引擎 API 混合使用；不要求把每一段游戏逻辑变成引擎内置规则。用 `npm install <package>` 将组件声明在游戏 package.json，正常 import。引擎 1.x 自带的背包、对话、任务等只是可选便利服务，自己的实现无需套用这些数据模型。

起步可用 `pelican guide --goal npm`；浏览器模块与每实例状态直接用 `pelican create --template runtime-lifecycle`，按返回的 `dependencies` 安装依赖。渲染组合用 `pelican create --template managed-rendering`。两者都是公开 npm 项目配方，不需要引擎源码。

## 先选择合适的接入方式

| 需求 | 接入方式 | 谁管理状态和资源 |
| --- | --- | --- |
| 数学、压缩、数据结构、规则算法 | 在游戏 package.json 安装普通浏览器兼容 npm 包，正常 import | 游戏作者；要存档的数据放组件或 runtime hooks |
| 顶层读取 window/document 的浏览器库 | `runtime.create` 内 `await import(...)` | 每实例 `scope.own/defer`，用 `scope.signal` 响应取消 |
| 第三方输入、网络、音频或设备适配 | runtime 初始化连接，在同步系统中消费已准备数据 | 适配器负责断开监听、连接和释放；外部消息不自动变成确定性回放事件 |
| Worker／WebSocket／npm 传输组件 | `createRuntimeAdapter`，显式 owned/borrowed，`decode/subscribe/send` 接原组件 | 有界队列、同步 `drain`、监听注销和所有者释放；不强制通信协议 |
| 程序化网格与常用 PBR 贴图 | `Geometry.kind: "buffer"`、MaterialInput 的 normalMap/roughnessMap/metalnessMap/aoMap/emissiveMap | 引擎复制声明数据并释放所拥有的几何、贴图视图 |
| 可复用材质、计算或后处理包 | npm 模块导出 `defineRenderExtension` | 版本化声明、受管资源与每实例 runtime；同一保存恢复协议 |
| 任意 Three.js/TSL/raw GPU 插件 | 尚无通用无损接入协议；查询所需算子、资源与帧阶段的准确缺口 | 不把私有 renderer/device/world 对象当成稳定接口 |

算法复用不需要另建“批准依赖列表”。旧 `content: "static"` 模式才有 runtime-only libraries 配置。新项目使用 `content: "typescript"`。

依赖的实际运行环境仍要匹配：Node-only 文件系统／命令行包用于资产和构建准备，不能假定浏览器存在 fs 或 process；DOM 库放在浏览器实例初始化。联网库可以接入，但引擎没有承诺内置多人状态同步，也不会自动把外部网络结果录入确定性回放。不要通过放开依赖就宣称这些未实现系统已经存在。

## 每个游戏实例有自己的初始化和状态

优先使用 `defineGameRuntime` 合并系统声明、实例状态与保存协议；需要 Map、自定义 codec 或更复杂恢复时仍可直接使用 `runtime.create(scope)`。两者的初始化都不会在内容构建时执行。`run` 保持同步，异步准备在 setup/create 内完成。

```ts
import { defineGame, defineScene, defineGameRuntime } from "pelican-engine";

export default defineGame({
  id: "counter",
  scene: defineScene({ id: "main", entities: [{ id: "state" }] }),
  ...defineGameRuntime<{ count: number }>({
    version: "counter-v1",
    state: () => ({ count: 0 }),
    validateState(value) {
      if (!value || typeof value !== "object" || !("count" in value) ||
          !Number.isSafeInteger(value.count) || Number(value.count) < 0)
        throw new Error("COUNTER_STATE: Expected a nonnegative integer count.");
    },
    systems: [{ id: "counter", run(_ctx, _dt, state) { state.value.count++; } }],
  }),
});
```

`state.value` 在恢复时被替换为校验过的副本，不要长期缓存旧引用。辅助器不限制非存档数据结构；任意外部对象仍不自动存档。使用低级 hooks 的完整例子在 `runtime-lifecycle`。

`defineGameRuntime<State, Dependencies>` 的 setup 可返回任意实例依赖（Map、浏览器视图、npm 客户端等），系统第五个参数接收这个类型化 context；不需要全局变量或把依赖对象塞进 JSON。context 不保存，也不隐式释放；资源仍用 scope 管理。需要该 context 时 setup 为必填。完整 `npm-component` 配方包含真实 fflate 往返、视图清理与存读档。

浏览器模块可以在顶层访问 DOM，返回可释放对象；仅在 setup/create 内导入并 `scope.own(createView())`：

```ts
const doc = document;
export function createView() {
  const element = doc.createElement("output");
  doc.body.append(element);
  const resize = () => { element.style.maxWidth = `${window.innerWidth}px`; };
  window.addEventListener("resize", resize);
  return {
    show(count: number) { element.textContent = String(count); },
    dispose() { window.removeEventListener("resize", resize); element.remove(); },
  };
}
```

清理同步、幂等，按登记逆序执行，包括初始化失败时。`own` 不重复释放同一对象；长请求应使用 signal。实例 `ready` 表示准备完成；浏览器和 `host.stepAsync` 会等待它。状态 hooks 必须成套提供，并只保存有限 JSON；独立对象、闭包、网络连接不能自动序列化。改变保存 schema 时更新 runtime.version，不冒充兼容。

普通组件不必伪装成引擎类。`scope.own(worker, value => value.terminate())`、`scope.own(connection, value => value.close())` 可适配原对象的释放函数；同一资源有不同释放者或被多个实例同时拥有时会拒绝。共享对象应显式借用，而不是重复 own。

`scope.listen(target, "message", listener)` 在实例释放时移除 EventTarget 监听，返回可提前、幂等注销的函数。支持 once、capture、passive 与调用方 AbortSignal；提前注销不会等到场景结束才释放监听引用。初始化失败也执行清理。

## 外部消息与 Worker

`createRuntimeAdapter(scope, {id, version, endpoint, ownership, decode, subscribe, send, release?})` 不要求外部组件实现引擎类，也不规定消息格式。用普通 TypeScript 回调接原来的 Worker、WebSocket、EventSource 或 npm 客户端。`endpoint` 只用于所有权身份检查，不读取其内部字段。

- `owned` 必须提供同步 `release()`；借用对象选择 `borrowed`，不允许设置释放函数，但仍须注销自己安装的监听。
- `subscribe(receive, fail)` 返回同步 unsubscribe。`decode` 验证／转换未知输入后入队，允许 TypedArray、Map 和自定义结构；它们不会因此自动成为存档数据。
- 系统在固定 tick 调用 `drain()`，再用普通玩法代码或现有服务消费。适配器不会向异步回调注入 ECS/GPU 对象；作者仍须避免在任意外部回调中直接修改世界。
- 默认容量 256，可设 1..65536。非法消息、传输异常或溢出进入 faulted，下一次同步操作给出稳定诊断，不静默丢弃并声称成功。容量按消息数量计，不是字节预算或恶意代码沙箱。
- 销毁后停止接收迟到消息、清空队列、注销监听，且只释放所拥有的端点。提前 dispose 可释放本实例的 ID／所有权，允许重新建立连接。

标准模块 Worker 可直接写 `new Worker(new URL("./worker.ts", import.meta.url), {type:"module"})`，放在 runtime.create 或其 browser-only 模块内。编译器包含 Worker 分包、类型检查、源映射与依赖指纹，生成 URL 相对游戏模块，不要求手写 Blob 脚本或固定部署根路径。外部托管的动态 Worker URL、Node 专用 worker_threads、浏览器 CSP 和安全上下文仍由对应环境决定。

完整 npm 起步配方：`pelican create --template external-adapters`。默认只运行本地 Worker，不依赖网络；可选 `?socket=ws://...` 接作者自己的 WebSocket 服务。配方演示 Worker 结果写入受管缓冲并由版本化渲染扩展使用，不是内置多人同步框架。

外部输入不会自动进入确定性回放。要可复现，应显式记录已接受的数据和消费 tick，并在恢复时取消／隔离旧请求、重新同步外部协议。配方用 epoch 丢弃恢复前的 Worker 回复；任意服务端、连接、重连和权限协议仍需作者适配，不能将网络对象或原始 GPU 对象塞进 JSON 存档。

声明构造仍要能在 Node 中运行。不要在声明层按 window、当前时间、未固定随机数或网络结果生成另一套 ID/组件/系统定义；`TC_GAME_CONSTRUCTION_DRIFT` 会报告构建与运行模块的定义差异。

## 受管网格、材质与渲染包

程序化网格使用 positions、normals、uv 和可选 indices 的有限普通数组。省略 normals 时生成顶点法线。属性数量、索引和 float32 范围会检查；先查 `pelican api --symbol BufferGeometryInput`。目前这是声明输入，运行时动态变形走顶点图或相应服务，不承诺任意 BufferGeometry 原地修改。

常用材质贴图接受 defineAsset 或 ID：normalMap、roughnessMap、metalnessMap、aoMap、emissiveMap。数据贴图在线性空间使用，粗糙度／金属度／AO 分别取 G／B／R；normalScale 缩放法线 XY。颜色与 emissiveMap 遵守资产颜色空间。贴图不是 clearcoat/sheen 等尚未实现物理模型的替代。

`defineRenderExtension({ id, version, systems, materials, assets, computes, postProcesses, computeBuffers, computeTextures, create })` 定义 API v1 的可复用渲染包；通过 `defineGame({ extensions: [...] })` 使用。资源进入现有检查和所有权链路，系统有明确 phase/before/after，后处理通过声明的 frame channels 和前序 pass ID 衔接。每实例 create、清理与保存状态按上面的协议组合，重复 ID、版本冲突和恢复失败有诊断。没有公开 GPUDevice 的隐式所有权转移。

无需物理的项目可显式设置 `services: { physics3d: "disabled" }`，避免载入 3D WASM；有刚体声明时会拒绝冲突。默认 auto 对未知用户 systems 保守准备物理，required 用于显式需求及旧原生 checkpoint 的恢复。

动态数据可以经现有 `ctx.compute.createBuffer/writeBuffer/releaseBuffer`、纹理对应方法和 `ctx.render.buffers/textures` 绑定进入渲染模块；引用、尺寸、有限数值、后端与释放检查仍生效。任意动态网格拓扑替换、原始 GPU 对象互通和完整异步世界流送不是此适配器自动提供的能力。

具体适配可直接用 `createWorkerAdapter`、`createWebSocketAdapter`，传标准端点、owned/borrowed 与 decode；Worker 可显式传 transfer 列表，WebSocket 还需 encode。未 OPEN 发送、解码失败、连接关闭和队列溢出有诊断，没有隐式重连。泛型适配器继续服务于 npm 客户端的自定义订阅协议。

`loadRuntimeJSON(scope, { url, decode, maxBytes, timeoutMs })` 为动态数据提供流式大小检查、HTTP/JSON/UTF-8 校验、截止时间与实例取消。默认 1 MiB、10 秒，可显式调整到最多 64 MiB、120 秒。decode 同步且由作者定义，CORS/CSP 照常适用；不要在同步系统中 await。完整 `dynamic-resources` 配方把准备结果在固定 tick 写入受管缓冲并显式保存恢复，不把任意 fetch 伪装成资产流送。

二进制使用同一预算和取消契约的 `loadRuntimeBytes`，返回精确 Uint8Array，再接普通 npm 解码器。完整 `dynamic-texture` 配方用 fast-png 解码 PNG、先检查解码尺寸、转换 sRGB 和行方向，然后在固定 tick 创建/绑定受管纹理并释放旧资源。编码大小不能限制解码后的内存；此配方限 RGBA8、16384 像素，不是任意不可信图像的沙箱。存档保存受管资源数据，不保存 URL 连接；场景候选初始化仍会执行 setup，因此远程资源不可用时不能承诺离线读档。

## 让编码 AI 找到已有能力

先 `guide --goal "完整任务"`，再查返回的精确方法与可运行配方。无匹配返回标记为候选的导航，不伪称支持；`capabilities` 的 `TC_CAPABILITY_UNKNOWN` 也只是未匹配，`TC_CAPABILITY_UNSUPPORTED` 才是明确限制。检查 total/truncated，不要只读第一项。

需要的 API 未找到时，依次尝试同义词、所属 service 的完整类型和方法检索。记录所需输入、输出、资源生命周期与后端，再反馈缺口。不要因一次空搜索就改成另一套引擎、关闭要求的效果或用固定展示代替交互。

可复用 npm 配方、从源码生成的方法索引、包内 llms.txt 和公开的任务评测协议，可以降低熟悉成本；它们不修改模型权重，也不能保证所有模型已经学会本引擎。独立任务成功率、首次检查、修复次数和查询字节数需要实际记录。
