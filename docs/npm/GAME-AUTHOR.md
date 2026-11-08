# Pelican Engine：npm 游戏开发 AI 入口

在独立游戏目录安装 `pelican-engine`。不要克隆、下载或修改引擎仓库来制作游戏。不要修改 `node_modules`；依赖升级、资产、玩法和配置都在游戏工作区管理。引擎 npm 包包含完整 SDK、CLI、运行时和构建能力，无需引擎源码、Git、专用 AI 平台或账号。

## 创建和查询

第一次使用先运行 `npx --no-install pelican guide`，再用 `guide --goal "让角色跳跃并保存游戏"` 查询完整任务。返回排序后的任务、精确方法、完整配方、验证步骤与限制；多个意图可以组合。不要先通读源码或整份 API。

需要 Node.js 24.x 和 npm。工具支持 Windows、macOS、Linux；玩家按浏览器实际图形能力检测，不按系统品牌白名单限制。

```sh
mkdir my-game
cd my-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

`--prefix .` 避免 npm 选择 parent 项目。首次 dev 只在允许的空目录生成内容，不覆盖已有游戏。停止服务后可执行：

```sh
npx --no-install pelican guide
npx --no-install pelican capabilities --summary --limit 8
npx --no-install pelican capabilities --feature content
npx --no-install pelican api --search "pointer"
npx --no-install pelican recipe --id pointer-3d
npx --no-install pelican create --template pointer-3d
npx --no-install pelican check
npx --no-install pelican build
```

`create` 用于新的空项目；已有默认文件时先保留工作，再决定是否替换。`recipe` 返回完整源码 JSON，`capabilities` 返回真实配方 ID、接口和边界，`help` 返回命令协议。无需读取长篇文档猜测符号；查询精确的 `api --symbol <name>`。类型与机器索引随 npm 包生成，入口 `pelican-engine` 是唯一公开 SDK。

新项目生成的 `AGENTS.md` 就是包内入口，不依赖专用 AI 平台。`capabilities --summary` 省略详细别名和限制，只用于挑选能力；选定后使用 `--feature <id>` 读完整边界。分页返回 `total/truncated/nextOffset`，使用 `--limit <1..100> --offset <n>` 继续，不把第一页当成全部能力。

完整能力结果仍保留原 1.x 形式。精确方法用 `api --symbol Type.member`；搜索用 `api --search <词> --member --limit 5`。`guide` 无匹配时返回 `discovery.status: "unrecognized"`、`TC_TASK_UNKNOWN` 与可直接查询的候选，候选不是“已支持”的断言。不要因一次查询失败就替换渲染器或砍掉游戏要求。

能力查询支持 ID、中英文与同义词，例如 `capabilities --feature 音效`、`--feature heightmap`、`--feature 计算着色器`、`--feature 后处理`、`--feature physics2d`、`--feature 存档` 和 `--feature geometry`。每项返回 `description`、`aliases`、真实 SDK `symbols`、实现状态、后端与限制；未带 `--feature` 时列出完整目录。这些是实现元数据，当前设备是否支持仍查询 `ctx.render.capabilities()`。目录未收录返回失败码 `TC_CAPABILITY_UNKNOWN`，不表示已经证明不支持；明确排除的硬件光追等返回 `TC_CAPABILITY_UNSUPPORTED`，不会以空数组成功响应。

方法级查询直接使用同一份 SDK 生成的机器索引：

```sh
npx --no-install pelican api --symbol AudioService.play
npx --no-install pelican api --symbol AudioService
npx --no-install pelican api --search play --member --limit 5
npx --no-install pelican api --search "TerrainService sculpt" --member
```

`--symbol` 精确且区分大小写，保留完整类型查询，也支持 `Type.member`；方法重载逐条返回。`--search` 优先排列精确符号名与精确成员名，`--member` 将搜索限定为成员，`--limit` 范围 1..100。查询结果中的 `total` 是截断前总数，`truncated` 表示是否省略结果；成员附带小粒度 `signature`、`owner`、`source` 和 `line`。无命中返回 `TC_API_SEARCH_UNKNOWN`。npm 包的 `docs/api/index.json` 保留顶层 `symbols` 并增加 `members`；源码路径/行号仅标识生成时来源，实际类型检查使用包内 `lib/sdk/index.d.ts`，CLI 同时返回 `installedDeclarations` 与 `sourceProvenance`。

## 普通 TypeScript 与依赖

运行实例、browser-only 库、资源释放、状态保存、受管几何与渲染插件的完整接入见 [INTEGRATIONS](INTEGRATIONS.md)。优先查询已有能力再决定第三方实现；未知查询不等于不支持。

Worker、WebSocket 或 npm 组件可查询 `pelican guide --goal worker`，完整配方为 `external-adapters`。使用 `createRuntimeAdapter` 的 owned/borrowed、消息校验和同步 drain 接入原组件；不要为了接入先改引擎源码，也不要取消 GPU、物理或存档检查。

新项目的 `pelican.project.json` 包含 `content: "typescript"` 和精确 `engineVersion`。支持普通循环、类、闭包、可变局部数据、模块和浏览器兼容 npm 依赖，依赖从游戏的 `package.json`/安装目录解析，不用再填 `libraries` 白名单。

构建时模块在独立 Node 进程执行，默认截止 10000ms；可设置 `contentTimeoutMs: 100..120000`。这是可信游戏构建，不是恶意代码安全沙箱。声明导出有限普通数据；实例、Map、Set 可用于构造过程，不能直接作为声明数据输出。系统 `run` 必须同步。

模块初始化同时用于构建和浏览器加载，使用稳定资源 ID 和确定性数据；不要在声明构造中放随机数、网络或外部副作用。DOM/浏览器 API 在 setup/runtime.create 或同步系统中使用，不放在声明构造顶层。普通依赖对象不会自动纳入存档、回放或资源释放；需要保存的状态放组件、公开服务或版本化 runtime 协议。

旧项目省略 `content` 时保留 `static` 模式，使用受限的非执行式表达式构建。该模式的 runtime-only 包需要 `libraries`；它不支持在内容构造中调用依赖。切换普通 TypeScript 后无需重写玩法，也不必沿用静态语法。

## 实现玩法

按任务选择完整配方；`recipe` 返回源码、辅助文件和明确的 npm 依赖，不是只能照用的玩法框架：

| 任务 | `pelican create --template` / `recipe --id` |
| --- | --- |
| 移动、跳跃、跟随相机、存读档 | `third-person` |
| browser-only npm、每实例资源与状态 | `runtime-lifecycle` |
| 标准 Worker、WebSocket、受管缓冲更新 | `external-adapters` |
| 有大小与截止预算的动态 JSON → 受管渲染 | `dynamic-resources` |
| 索引网格与渲染扩展包 | `managed-rendering` |

`defineGameRuntime` 可展开到 `defineGame`：系统只声明一次，`state()` 每实例创建 JSON，`validateState` 校验，辅助器提供完整保存恢复协议。系统使用 `state.value`，恢复会替换它，不要把旧 value 缓存在闭包中。Map、类和第三方实例照常使用，但需自己的 JSON 编解码或原有 runtime hooks。`scope.cleanup` 返回可提前调用的幂等清理函数；`own/listen/defer` 保持兼容。

从组件、实体、系统、事件、输入和资源组合玩法，或使用 npm 中的算法模块。背包、任务、对话等服务是便利选项，不要求游戏遵循这些规则。组件 `{type:"json", default:[]}` 存有限普通 JSON，每字段最多深度16、8192节点、65536 UTF-8字节。

输入动作使用 `KeyboardEvent.key`，例如 `"w", "W", "ArrowUp"`，not `"KeyW"`。`ctx.input.pointer()` 提供画布 CSS 像素、Y向上 NDC、按钮边缘、滚轮和多触点。`setPointerLock(true)` 需下一次真实画布手势，不能把请求视为已经授权。失焦会释放按键和指针。

Use `ctx.audio.fadeBus` for mixer fades. 音频开始也受浏览器真实交互策略约束；不要用自动播放成功假定所有设备都允许。

## 图形、调试与运行

优先 WebGPU，WebGL2 只回退光栅。compute、混合和路径追踪不在 WebGL2 上伪装支持。路径追踪使用软件 BVH，不是硬件 RT。材质图、计算图、纹理与缓冲绑定是公开扩展入口；任意 Three.js/TSL 插件没有现成的引擎接入协议。

默认走高质量实时光栅：原生 DPR、抗锯齿、ACES、studio IBL、4096 阴影图和硬件支持的各向异性过滤；未开启投影的灯不会因此自动投影。指定 `lighting: "none"` 可关闭 IBL；自带 lightingTexture 时使用作者环境。`renderQuality()`、`renderQuality("preview")` 和 `renderQuality("capture")` 返回可覆盖设置，后两档需要 WebGPU。采样数和反弹数只影响追踪，不会提高光栅采样。高模、贴图、曝光和帧率仍应按实际场景验证。

开发服务器对声明兼容的逻辑修改事务式替换实例并恢复完整检查点，不再整页丢失状态。声明、资产、保存版本或服务契约改变时保留旧游戏，`inspect.iteration` 报告 `TC_DEV_RESTART_REQUIRED`；`pelican reload --restart` 或显式刷新应用新内容。`pelican reload` 手动重试兼容更新。候选初始化或恢复失败保留旧实例，不自动抹掉进度。这不是任意 schema 迁移或全量资产热更新。

正常游戏跟随窗口与 DPR。自动截图可同时指定 URL 的 width/height 固定像素。开发与生产默认隐藏诊断 HUD，需要时用 `?diagnostics=1`。固定时间的质量捕获先暂停，再用 `pelican render --mode path --samples 256 --denoise false` 和 `capture --live`，积累采样不会推进玩法。

自动化支持 inspect、step、pointer、batch 和 capture。批处理预检查所有命令后顺序执行，运行失败不会回滚已经完成的命令。检查返回的 `causeCodes`、tick、stage、system、source；类型或编译成功不代表 GPU、音频、用户输入和长时间运行已经通过。

开发时反复执行 check → dev → 实际操作/自动化 → inspect/capture → 修复。按需用 `pelican setup` 安装浏览器自动化依赖，普通构建不要求浏览器。发布游戏只部署 `build` 的 `dist/` 到 HTTP(S) 静态服务器；不要部署引擎源码项目。

`?automation=1` 的开发测试页默认暂停，使用显式 step 或 resume 推进，停着不等于初始化卡住。普通 dev／生产页自动运行。测试应使用独立 headless 浏览器，按数值 polling 等待就绪，不依赖桌面焦点或回车；不要把人工输入当成自动化通过条件。音频解锁仍遵守浏览器的真实交互策略。

## 最小渲染内容

<!-- standalone-render-recipe:start -->
```ts
import { defineGame, defineMaterial, defineScene } from "pelican-engine";

const material = defineMaterial({
  id: "paint",
  color: "#303030",
  roughness: 0.35,
  metalness: 0,
  ior: 1.5,
  specularIntensity: 0.7,
  specularColor: "#ffb080",
});

export default defineGame({
  id: "render-recipe",
  scene: defineScene({
    id: "main",
    camera: { position: [0, 1, 5], target: [0, 0, 0], fov: 45 },
    environment: { background: "#17212a", ambientIntensity: 0.4 },
    entities: [
      { id: "object", mesh: { geometry: { kind: "box" }, material } },
      { id: "light", transform: { position: [2, 4, 5] },
        light: { kind: "directional", intensity: 3 } },
    ],
  }),
});
```
<!-- standalone-render-recipe:end -->

完整配方由 `pelican recipe` 返回，npm 包同时包含由配方源生成的 `docs/npm/RECIPES.md`。图形边界见 [GRAPHICS-GUIDE](../GRAPHICS-GUIDE.md)，动画见 [ANIMATION](../ANIMATION.md)，模拟见 [SIMULATION-COUPLING](../SIMULATION-COUPLING.md)。能力元数据见 `pelican capabilities`；缺失能力应明确反馈，不能通过修改引擎内部文件掩盖。
