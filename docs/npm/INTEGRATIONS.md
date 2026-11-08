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
| 程序化网格与常用 PBR 贴图 | `Geometry.kind: "buffer"`、MaterialInput 的 normalMap/roughnessMap/metalnessMap/aoMap/emissiveMap | 引擎复制声明数据并释放所拥有的几何、贴图视图 |
| 可复用材质、计算或后处理包 | npm 模块导出 `defineRenderExtension` | 版本化声明、受管资源与每实例 runtime；同一保存恢复协议 |
| 任意 Three.js/TSL/raw GPU 插件 | 尚无通用无损接入协议；查询所需算子、资源与帧阶段的准确缺口 | 不把私有 renderer/device/world 对象当成稳定接口 |

算法复用不需要另建“批准依赖列表”。旧 `content: "static"` 模式才有 runtime-only libraries 配置。新项目使用 `content: "typescript"`。

依赖的实际运行环境仍要匹配：Node-only 文件系统／命令行包用于资产和构建准备，不能假定浏览器存在 fs 或 process；DOM 库放在浏览器实例初始化。联网库可以接入，但引擎没有承诺内置多人状态同步，也不会自动把外部网络结果录入确定性回放。不要通过放开依赖就宣称这些未实现系统已经存在。

## 每个游戏实例有自己的初始化和状态

`runtime.create(scope)` 在浏览器按实例执行，构建不会执行它。返回的系统按构建时声明的 ID 绑定，`run` 保持同步。异步请求、动态 import 和资源准备放在 create 中；普通系统不要返回 Promise。

```ts
import { defineGame, defineScene, defineSystem } from "pelican-engine";

export default defineGame({
  id: "counter",
  scene: defineScene({ id: "main", entities: [{ id: "state" }] }),
  systems: [defineSystem({ id: "counter" })],
  runtime: {
    version: "counter-v1",
    async create(scope) {
      const { createView } = await import("./browser-view.ts");
      scope.signal.throwIfAborted();
      const view = scope.own(createView());
      let count = 0;
      const validate = (value: unknown): void => {
        if (!value || typeof value !== "object" || !("count" in value) ||
            !Number.isSafeInteger(value.count) || Number(value.count) < 0)
          throw new Error("COUNTER_STATE: Expected a nonnegative integer count.");
      };
      return {
        systems: { counter(ctx) { count++; view.show(count); } },
        snapshot: () => ({ count }),
        validateSnapshot: validate,
        restore(value) { validate(value); count = (value as { count: number }).count; view.show(count); },
      };
    },
  },
});
```

浏览器模块可以在顶层访问 DOM，返回可释放对象：

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

声明构造仍要能在 Node 中运行。不要在声明层按 window、当前时间、未固定随机数或网络结果生成另一套 ID/组件/系统定义；`TC_GAME_CONSTRUCTION_DRIFT` 会报告构建与运行模块的定义差异。

## 受管网格、材质与渲染包

程序化网格使用 positions、normals、uv 和可选 indices 的有限普通数组。省略 normals 时生成顶点法线。属性数量、索引和 float32 范围会检查；先查 `pelican api --symbol BufferGeometryInput`。目前这是声明输入，运行时动态变形走顶点图或相应服务，不承诺任意 BufferGeometry 原地修改。

常用材质贴图接受 defineAsset 或 ID：normalMap、roughnessMap、metalnessMap、aoMap、emissiveMap。数据贴图在线性空间使用，粗糙度／金属度／AO 分别取 G／B／R；normalScale 缩放法线 XY。颜色与 emissiveMap 遵守资产颜色空间。贴图不是 clearcoat/sheen 等尚未实现物理模型的替代。

`defineRenderExtension({ id, version, systems, materials, assets, computes, postProcesses, computeBuffers, computeTextures, create })` 定义 API v1 的可复用渲染包；通过 `defineGame({ extensions: [...] })` 使用。资源进入现有检查和所有权链路，系统有明确 phase/before/after，后处理通过声明的 frame channels 和前序 pass ID 衔接。每实例 create、清理与保存状态按上面的协议组合，重复 ID、版本冲突和恢复失败有诊断。没有公开 GPUDevice 的隐式所有权转移。

无需物理的项目可显式设置 `services: { physics3d: "disabled" }`，避免载入 3D WASM；有刚体声明时会拒绝冲突。默认 auto 对未知用户 systems 保守准备物理，required 用于显式需求及旧原生 checkpoint 的恢复。

## 让编码 AI 找到已有能力

先查询目标，再查询精确方法与可运行配方。`capabilities` 支持中文和别名；`TC_CAPABILITY_UNKNOWN` 表示未匹配查询，`TC_CAPABILITY_UNSUPPORTED` 才表示有明确限制。检查 total/truncated，不要只读搜索第一项。

需要的 API 未找到时，依次尝试同义词、所属 service 的完整类型和方法检索。记录所需输入、输出、资源生命周期与后端，再反馈缺口。不要因一次空搜索就改成另一套引擎、关闭要求的效果或用固定展示代替交互。

可复用 npm 配方、从源码生成的方法索引、包内 llms.txt 和公开的任务评测协议，可以降低熟悉成本；它们不修改模型权重，也不能保证所有模型已经学会本引擎。独立任务成功率、首次检查、修复次数和查询字节数需要实际记录。
