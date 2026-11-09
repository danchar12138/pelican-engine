# Pelican Engine：npm 游戏开发 AI 入口

在独立游戏目录安装 `pelican-engine`。不要克隆、下载或修改引擎仓库来制作游戏。不要修改 `node_modules`；依赖升级、资产、玩法和配置都在游戏工作区管理。引擎 npm 包包含完整 SDK、CLI、运行时和构建能力，无需引擎源码、Git、专用 AI 平台或账号。

## 创建和查询

画质、加载或卡顿任务先运行 `pelican guide --goal "动态室内低噪光追、加载进度和移动端性能优化"`。开发服务启动后运行 `pelican diagnose --port 4173`，按原因和精确查询修复，不因一张噪声截图直接换渲染器，也不靠降分辨率或隐藏失败实现要求。外部 npm 网格生成器用 `npm-geometry` 配方；自己的加载 UI 用 `startup-feedback` 配方及 `onEngineStartup`。

第一次使用先运行 `npx --no-install pelican guide`，再用 `guide --goal "让角色跳跃并保存游戏"` 查询完整任务。精选任务与所有能力的派生入口提供方法、配方和限制；多个意图可以组合，但命中不代表整句话的所有要求都已支持，无配方的能力也不伪造完整例子。不要先通读源码或整份 API。

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

程序化几何可正常使用 Math.sin/cos 等运算。声明漂移检查保留结构、ID 和离散整数检查，对有限浮点数只容忍极小的相对尾数误差，不要求作者为跨 Node/浏览器计算尾数手动量化网格。这不是允许随机或环境分支生成不同内容的开关。

旧项目省略 `content` 时保留 `static` 模式，使用受限的非执行式表达式构建。该模式的 runtime-only 包需要 `libraries`；它不支持在内容构造中调用依赖。切换普通 TypeScript 后无需重写玩法，也不必沿用静态语法。

## 实现玩法

按任务选择完整配方；`recipe` 返回源码、辅助文件和明确的 npm 依赖，不是只能照用的玩法框架：

| 任务 | `pelican create --template` / `recipe --id` |
| --- | --- |
| 移动、跳跃、跟随相机、存读档 | `third-person` |
| browser-only npm、每实例资源与状态 | `runtime-lifecycle` |
| setup 返回类型化 npm／浏览器依赖、无需全局变量 | `npm-component` |
| 标准 Worker、WebSocket、受管缓冲更新 | `external-adapters` |
| 有大小与截止预算的动态 JSON → 受管渲染 | `dynamic-resources` |
| 动态二进制 → npm PNG 解码 → 受管纹理 | `dynamic-texture` |
| 索引网格与渲染扩展包 | `managed-rendering` |

`defineGameRuntime` 可展开到 `defineGame`：系统只声明一次，`state()` 每实例创建 JSON，`validateState` 校验，辅助器提供完整保存恢复协议。系统使用 `state.value`，恢复会替换它，不要把旧 value 缓存在闭包中。Map、类和第三方实例照常使用，但需自己的 JSON 编解码或原有 runtime hooks。`scope.cleanup` 返回可提前调用的幂等清理函数；`own/listen/defer` 保持兼容。

非存档依赖可由 `defineGameRuntime<State, Dependencies>` 的 setup 返回，并由系统第五个参数接收。它们与 JSON 状态分开，每实例独立，不会自动序列化或释放；仍用 scope 负责资源。

从组件、实体、系统、事件、输入和资源组合玩法，或使用 npm 中的算法模块。背包、任务、对话等服务是便利选项，不要求游戏遵循这些规则。组件 `{type:"json", default:[]}` 存有限普通 JSON，每字段最多深度16、8192节点、65536 UTF-8字节。

输入动作使用 `KeyboardEvent.key`，例如 `"w", "W", "ArrowUp"`，not `"KeyW"`。`ctx.input.pointer()` 提供画布 CSS 像素、Y向上 NDC、按钮边缘、滚轮和多触点。`setPointerLock(true)` 需下一次真实画布手势，不能把请求视为已经授权。失焦会释放按键和指针。

Use `ctx.audio.fadeBus` for mixer fades. 音频开始也受浏览器真实交互策略约束；不要用自动播放成功假定所有设备都允许。

## 图形、调试与运行

优先 WebGPU，WebGL2 只回退光栅。compute、混合和路径追踪不在 WebGL2 上伪装支持。路径追踪使用软件 BVH，不是硬件 RT。材质图、计算图、纹理与缓冲绑定是公开扩展入口；任意 Three.js/TSL 插件没有现成的引擎接入协议。

默认光栅：`renderQuality()` / `"low"` / `"realtime"` 选择 raster；原生 DPR、studio IBL、4096 阴影与各向异性过滤保留。显式 `"high"` 选择 path，4 samples/frame、8 bounces，时域与空间降噪开启；`"medium"` 选择 hybrid、2 samples/frame、4 bounces，`"low"` 选择 raster 并关闭追踪降噪；`"preview"` 别名中档，`"capture"` 为4采样/12反弹、不滤波的 path。完整切档用 `ctx.render.configure(renderQuality("medium"))`；不是只改模式却忘记滤波预算。

path/hybrid 需要实际 WebGPU，不支持时明确诊断，不自动冒充低档；启动 URL 的 `?quality=low` 是玩家显式选择，也可在游戏声明里配置 low。默认并不保证所有设备帧率，高模、分辨率、动态光照和降噪应实测。`lighting:"none"` 关闭 IBL，环境贴图与曝光仍尊重作者设置。光栅保留4096阴影图与设备各向异性过滤。

需要在低档期间预热高档时，调用 `ctx.render.prepare("path")` 并检查 `ctx.render.preparation("path")`；开发 CLI 可用 `pelican prepare-render --mode path`。准备在帧边界处理，系统不 await，不切换当前模式或推进玩法；失败返回状态，内容/视口/设备改变后需重试。切档保留世界与实例，但重置追踪/后期历史；低档保留追踪缓存，显存不会立即全部回收。完整配方 `render-quality` 展示三档按钮和准备状态。

开发服务器对声明兼容的逻辑修改事务式替换实例并恢复完整检查点，不再整页丢失状态。声明、资产、保存版本或服务契约改变时保留旧游戏，`inspect.iteration` 报告 `TC_DEV_RESTART_REQUIRED`；`pelican reload --restart` 或显式刷新应用新内容。`pelican reload` 手动重试兼容更新。候选初始化或恢复失败保留旧实例，不自动抹掉进度。这不是任意 schema 迁移或全量资产热更新。

正常游戏跟随窗口与 DPR。自动截图可同时指定 URL 的 width/height 固定像素。开发与生产默认隐藏诊断 HUD，需要时用 `?diagnostics=1`。固定时间的质量捕获先暂停，再用 `pelican render --mode path --samples 256 --denoise false` 和 `capture --live`，积累采样不会推进玩法。

自动化支持 inspect、step、pointer、batch 和 capture。批处理预检查所有命令后顺序执行，运行失败不会回滚已经完成的命令。检查返回的 `causeCodes`、tick、stage、system、source；类型或编译成功不代表 GPU、音频、用户输入和长时间运行已经通过。

`pointer` 注入的是游戏画布指针状态，不是浏览器 DOM 点击器；测试界面按钮时使用 Playwright 对元素的真实 click。启动失败的 CLI 诊断保留底层 `causeCodes`；例如 `TC_AUTOMATION_BOOT_FAILED` 加 `TC_GAME_CONSTRUCTION_DRIFT` 指向声明构造问题，而不只是要求盲目重开浏览器。

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

## 紧凑发现与可执行验收

`pelican guide --compact --goal <任务>` 只读取项目 manifest，完整 JSON 信封目标不超过 2 KiB；截断提供完整查询命令，实施前需续查限制。普通 guide 保留完整输出。游戏 AGENTS 的任务导航由同一任务元数据生成；未知查询返回导航候选，不等于能力不支持。

`pelican inspect --summary` 返回实际后端、播放状态、tick、帧、关键故障及内存已知量；`--fields summary,rendering` 选择数据，selection 区分不可用与分页截断。status 只查控制会话，diagnose 分析观测，分页不再丢失显式请求的资产依赖。

`pelican capture --facts` 或 capture --live --facts 输出 PNG 亮度直方图、暗像素/上端饱和比例与显示动态范围，附阈值、帧、采样、后端和证据哈希。最终显示像素不是线性 HDR 辐亮度；暗画面本身不是错误。

`pelican verify` 在独立 headless 浏览器做三固定 tick、就绪和运行时错误冒烟，不猜玩法。`pelican verify --recipe third-person` 等执行原配方的共享专属验收，涵盖对应交互、保存恢复和必要像素检查；仅有验收定义的配方接受此选项。测试会推进/恢复独立实例，证据写入 .pelican/verify/。修改后的游戏规格由作者维护，模板断言不能代替任意游戏验收。

小型模型/音频资产随配方返回许可、大小、SHA-256 和 base64；create 安全复制并拒绝覆盖、越界或链接目录。模型动画与音频解锁查询 model-animation、audio-interaction；其余 examples 可是专项夹具，不自动成为公开模板。

CLI 默认 JSON，--json 为兼容参数；用法错误退出 1，检查/断言失败 2，环境/取消/超时 3。旧脚本若只接受失败码 1 需调整。[本地 HTTP 协议](HTTP-PROTOCOL.md) 从命令类型生成，保留原始请求体，解释文件输入、版本和会话重置。

开发态显式使用 `?trace=128`（0 关闭，最多 1024 条），`inspect --fields runtime` 的 world.developmentTrace 返回实际系统顺序、最近故障码及受管 Transform/组件写入来源。它不追踪任意 JavaScript 赋值、外部网络或全部 GPU 更新，不进入保存/回放，生产忽略参数。

受控截图用 `pelican verify --baseline .pelican/baseline.png --write-baseline` 创建，再以同命令去掉 --write-baseline 比较。固定独立新会话、三 tick、960×540、DPR=1，校验相机、档位、实际采样序列/历史初态，记录浏览器/后端/设备，使用明示像素容差；不保证跨设备逐像素一致。与 recipe 验收互斥，普通 verify 不强加画面阈值。采样已由像素与帧序列确定，本次不新增 seed。

兼容说明：显式 high/path、medium/hybrid 仍可使用；省略画质和 realtime 现为 raster。切换默认值会改变初始渲染契约，旧的默认 path 存档不会被悄悄改成光栅存档。其他设置完全匹配且仅缺新增 AO 字段的 1.x 快照可以恢复；不兼容时保留当前世界并报告诊断。
