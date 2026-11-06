# M0-08 / M2 UI 风险原型

本模块是引擎内部的真实 DOM 后端；游戏只通过主线公开 typed API 定义和更新 UI，不取得 DOM、Three.js、Gamepad 或 GPU 对象。不建设编辑器，不依赖编译器 IR。完整 UI/可访问性体系仍属于 M6。

## 集成契约

从 `src/ui.ts` 导入 `createUIRenderer` 及独立结构类型 `UiElement`。字段固定为：

```ts
interface UiElement {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  text: string;
  value: number;
  visible: boolean;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x: number;
  y: number;
  width: number;
  color: string;
  world?: {
    entity: string;
    offset: readonly [number, number, number];
    occlude: boolean;
  };
}

const ui = createUIRenderer(definitions, {
  input: (key, pressed) => host.input(key, pressed),
  emit: (type, payload) => forwardExternalEvent(type, payload),
});
ui.mount(); // 同步、幂等；不聚焦、不请求 GPU、不需要点击或 RAF。
ui.present(elements, positions);
if (ui.consumesKeyboard(event)) return; // host 的 keydown 和 keyup 都须先判断。
const evidence = ui.inspect();
ui.dispose();
```

上例中的 host 和事件转发函数由主线提供。工厂创建后仍需 `mount()` 才附着 body；卸载后 mount/present 无操作。重复 id 抛出 `TC_UI_DUPLICATE_ID`。present 按 id 保留节点，只在新增、移除或 kind 改变时更换节点；焦点顺序采用本次 elements 的数组顺序。

保留 `[data-pelican-ui]` 与 `[data-pelican-element="<id>"]`。screen UI 保留旧 gameplay 的 absolute/inset 根布局、padding、圆角、背景、字号、width、color、四角 anchor 和中心 translate；center 与旧实现一样忽略 x/y。普通文本与进度条不接收指针事件，input/button 使用浏览器原生交互。input 不设置 autofocus。

## World UI 的输入边界

`positions?: ReadonlyMap<string, {x:number; y:number; visible:boolean; occluded:boolean}>` **以 UI 元素 id 为键**，与主线 gameplay 一致。同一实体可有不同 offset 的多个 UI。主线负责 entity/offset 到相机的投影、可见范围判断及 mesh 遮挡，将最终坐标交给本模块；x/y 是根布局内的 CSS 像素，作为元素左上角直接使用，不再叠加 screen 的 x/y 或重复投影。主线必须保证投影 viewport 与根布局的坐标空间一致。

只有元素 visible、投影存在且 visible、坐标有限，以及 occlude=false 或投影未 occluded 时才显示。其余情况同时 hidden、display:none、pointer-events:none、tabIndex=-1，原生交互控件 disabled；当前焦点会失焦。隐藏控件即便被脚本派发 click，也不会触发游戏回调。仅 opacity 不满足这里的语义。

## 输入、回显与事件

所有事件 payload 都是纯数据：

| 事件/回调   | 触发与 payload                                                                   |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| input       | button 激活时依次调用 `input('ui:<id>', true)` 和 false                          |
| ui.text     | 原生输入提交 `{id,text,composing:false}`；组合中只记 trace，不向游戏提交临时文字 |
| ui.submit   | input 的非组合态 Enter，`{id,text}`；按住 Enter 的 repeat 不重复提交             |
| ui.activate | button 的鼠标、原生键盘或手柄 A 激活，`{id}`                                     |
| ui.focus    | 实际 focusin/out 导致 id 改变时 `{id:string                                      | null}`；卸载当前焦点也发 null，present 不重复发送 |

真实 `<input type="text">` 保留中文 IME、系统剪贴板、Unicode 文本、selectionStart/End/Direction。组合态不会赋值 input.value，也不会重建现有节点；compositionend 与随后原生 input 对同一文本去重。只阻止非组合态 Enter 的默认提交；普通文字、方向键、粘贴和 F5 不调用 preventDefault。input 上的 Enter 不会激活玩法按钮。host 收到 ui.focus 后可释放已按下的玩法映射键，避免持键时聚焦输入框继续移动。

`consumesKeyboard` 在本模块输入框拥有焦点、事件来自其 input、任何输入框正在组合或 event.isComposing 时返回 true；销毁后返回 false。这是 host 在键盘路由前调用的判断，不会全局安装键盘拦截器。

本地提交后记录 pendingCommit。聚焦期间，在游戏状态确切回显最新已提交文本之前，忽略旧 tick 和较早提交的回显，保留真实 value 与 selection；收到确切回显时只清 pending，不重写 input.value。组合期间收到的远端文本也不覆盖 IME。失焦后的下一次 present 允许新状态写回；非组合态的实际远端文本更新在必要时赋值并保留、按新长度截断 selection。若业务主动规范化文本而永远不回显原文，聚焦期间将继续保护本地提交，待失焦再接受规范化状态，这是该原型的明确策略。

## 手柄与检查状态

仅在已 mount 的 present 中读取 `navigator.getGamepads()`；不注册 RAF、定时器或 gamepad 全局事件。只接受 connected、mapping=standard 的控制器。D-pad 12/14 向前、13/15 向后，左摇杆轴 0/1 绝对值超过 0.5 等效；这里只按稳定 UI 数组顺序循环，不做空间最近邻。每次采样只处理一个方向，按住不重复，松开再按才产生新边沿。A/button0 只激活当前 button；input 上 A 不提交，未有焦点时 A 建立首个可交互焦点。隐藏 screen/world、遮挡 world、text/bar 均排除。

组合输入期间读取并记住手柄边沿，但暂停导航和激活，因此不会抢走 IME 焦点，也不会在组合结束后重放按住的边沿。

`inspect()` 返回独立 JSON 快照：

- `mounted/disposed/focus/composing/inputValue/selection` 为当前状态，缺失项使用 null。
- `elements` 按 UI 数组顺序列出 id、kind、实际 visible、composing、inputValue、selection、pendingCommit。
- `trace` 最多保留最新 128 条：单调 sequence、type、id、value、composing、selection、data、inputType、trusted。记录 beforeinput/input/paste/select、原生组合、焦点及激活；不存 event、DOM、剪贴板对象或 Gamepad 对象。
- `gamepad` 仅含 source、hardwareVerified:false、index、connected。测试 stub 的普通对象标为 virtual；浏览器原生 Gamepad 实例标为 physical，只描述对象来源，不能据此宣称实物硬件验收。

## 实测与限制

在独立 worktree 使用已有依赖，不安装浏览器或 npm 包。默认 `npm test` 的 `tests/*.test.ts` 已包括此测试，无需修改根配置。专项命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/ui.test.ts
npm run typecheck
```

测试以 TypeScript 内存转译的真实 ui.ts 启动本地随机端口 HTTP 服务，运行 Playwright Chromium headless；不请求 GPU，不导入整个 gameplay。浏览器启动 15 秒、每项 20 秒、总测试 120 秒截止；页面操作/导航 5 秒，finally 关闭 context/browser/server，截止时也关闭已拥有的浏览器与连接。就绪轮询不用 RAF。

实际覆盖：无点击挂载；原生 CDP `Input.imeSetComposition` 的“你→你好”和 `Input.insertText` 提交；多次重绘保留组合/selection；组合时 pad 不抢焦点；延迟回显与乱序回显；原生剪贴板中文/emoji 替换选区；原生按钮点击、Enter、Space；焦点事件去重；输入键盘消费；传入 world pixel 的定位/隐藏/遮挡与 elementFromPoint 点击穿透；虚拟标准手柄 dpad/axes/A 边沿；trace 上限和 JSON 隔离；动态移除与 dispose 后保留节点无残余监听器。

实测浏览器为 Chromium 156.0.8078.4。CDP 原生浏览器编辑通道提供真实 DOM/焦点/选区/组合事件证据，未验证操作系统中文候选窗或不同系统输入法。手柄仅 stub navigator 的虚拟标准输入，没有实物连接证据。World UI 此处只验证传入像素与可见/遮挡状态，不提供相机投影、Three raycast、WebGPU、GPU 启动或性能证据；这些由主线独立场景验收。尚未验证其他浏览器、读屏、完整 tab/模态焦点体系、M6 正式 UI 功能。
