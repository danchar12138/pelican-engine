# M1 资源生命周期与异步取消

实现入口：`packages/runtime/src/resources.ts`。这是引擎内部模块，不直接导出到游戏公开 SDK。仅修改本模块、对应测试与本文档；浏览器集成和里程碑证据由主线完成。

## Host 接入契约

```ts
import { createResourceManager } from "./src/resources.ts";

interface HostResources {
  json: { descriptor: { url: string }; value: unknown };
  module: {
    descriptor: { url: string };
    value: { createGame: (facade: unknown) => unknown };
  };
  binary: { descriptor: { url: string }; value: Uint8Array };
}

const manager = createResourceManager<HostResources>();
manager.registerLoader("json", {
  async load(descriptor, signal) {
    const response = await fetch(descriptor.url, { signal });
    if (!response.ok) throw new Error("IR request failed");
    return response.json() as Promise<unknown>;
  },
  dispose() {},
});
manager.registerLoader("module", {
  async load(descriptor, signal) {
    if (signal.aborted) throw new Error("Cancelled before import");
    return import(/* @vite-ignore */ descriptor.url);
  },
  dispose() {},
});
manager.registerLoader("binary", {
  async load(descriptor, signal) {
    const response = await fetch(descriptor.url, { signal });
    if (!response.ok) throw new Error("Binary request failed");
    return new Uint8Array(await response.arrayBuffer());
  },
  dispose() {},
  estimateBytes: (value) => value.byteLength,
});

const scope = manager.createScope("compiled-content");
const controller = new AbortController();
const lease = await manager.acquire(
  "json",
  "scene",
  { url: "/compiled/scene.ir.json" },
  scope,
  { signal: controller.signal }, // 可省略；只取消本次 acquire 的等待
);
const compiledIR = manager.get(lease.handle); // 引擎内部使用
const identities = manager.snapshot(scope); // 可重建身份，不是 GPU 快照
await scope.release();
await manager.dispose();
```

Host 需要验证 JSON IR 的语义和模块 `createGame` 导出；资源管理器只管理加载与生命周期，不替代内容契约验证。示例中的类型占位需要替换为实际 `GameFacade` / `GameInstance`。不得向游戏 facade 暴露 manager、loader、原生纹理、模块命名空间或其他内部值。

`ResourceManager<HostResources>` class 与 `createResourceManager<HostResources>()` 等价。资源类型无需声明字符串索引签名。泛型同时关联 type、descriptor 和 `get(handle)` 返回值；运行时句柄检查 manager、index、generation、type。

## 接口与所有权

| 接口                                                      | 语义                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerLoader(type, { load, dispose, estimateBytes? })` | 每类型注册一次；捕获 loader 方法。load / dispose 支持同步值或 Promise，estimateBytes 为同步可选估计。                                          |
| `createScope(name?, parent?)`                             | 创建作用域；也接受 `createScope(parent)`。名称仅作调用方组织代码之用，不参与身份、快照或日志。父释放会级联释放子作用域。                       |
| `acquire(type, key, descriptor, scope, { signal? }?)`     | 异步返回 `ResourceLease<typeof type>`；相同 type/key/规范化 descriptor 共享一次加载，每次调用增加独立引用。                                    |
| `get(handle)`                                             | 引擎内部同步取值。pending、过期、其他 manager 或错误 type 均抛出稳定错误。                                                                     |
| `lease.release()` / `scope.release()`                     | 幂等释放。最后引用离开时删除身份、使句柄失效，并释放已加载资源或中止 pending 加载。返回 Promise，等待此次开始的释放。                          |
| `snapshot(scope?)`                                        | 返回独立 JSON 数据；省略 scope 表示全部存活身份；指定 scope 只包含该 scope 自身的引用，不隐式包含子 scope。                                    |
| `restore(snapshot, scope, { signal? }?)`                  | 先完整校验，临时子 scope 加载，成功后转移到目标 scope，返回重建 leases；失败仅回滚本次新增引用。                                               |
| `inspect()`                                               | 返回存活条目、pending/loaded、引用数、scope 数、在途加载/释放、字节估计与累计计数的独立视图。                                                  |
| `getEvents()` / `getDiagnostics()`                        | 取有界历史的副本；默认各保留最近 256 条，可通过构造参数 `historyLimit` 调整。                                                                  |
| `subscribe(callback)`                                     | 同步事件回调，返回取消订阅函数。回调抛错会被隔离并移除，不影响资源处理。回调不要返回异步任务。                                                 |
| `dispose()`                                               | 幂等终止 manager；立即失效所有拥有关系，并等待当前已开始的 disposal，包括之前 lease.release 启动的释放。之后不可注册、获取、恢复或创建 scope。 |
| `whenIdle()`                                              | 等所有已调度加载及释放完成，包括忽略 abort 的旧加载；需由调用方对不可靠 provider 设置超时。                                                    |

句柄 `{ manager, index, generation, type }` 是运行态值，只在相应资源代际存活时有效。多个 lease 可以共享同一 handle；释放一个 lease 不会使其他 lease 的资源失效。最后释放即删除，不使用隐藏常驻缓存，重新 acquire 可更换 descriptor，并产生新代际。重复 dispose 不重复调用 loader.dispose。

## 取消与失败

1. signal 已中止：acquire 拒绝，不增加引用或调用 loader。
2. 一名等待者取消：只移除该等待者，其他引用及共享 loader 的 signal 不受影响。
3. 所有引用释放/取消：从身份表删除，AbortController 中止旧任务，槽位可以立即进入新代际。
4. 旧任务忽略 abort 并迟到返回：旧值仍调用旧 loader.dispose，不进入新条目，也不会更改新代际数据。
5. load 同步抛错或异步拒绝：所有仍在等待的引用失败，身份删除；后续 acquire 可重试。
6. load 成功交付 lease 后，acquire signal 的监听被移除；此后使用 lease/scope 释放，不将 acquisition signal 作为已交付资源的生命周期控制器。
7. loader.dispose 同步抛错或异步拒绝：记录诊断，其他资源照常清理。管理器无法保证失败的底层清理实际成功，也不会擅自重试可能已部分执行的 destructor。

`dispose()` 不等待忽略 abort 的 load，避免关闭永远卡住；该任务仍在 `inFlightLoads` 中计数，迟到结果自动释放。需要证明所有任务结束时，在 provider 能终止的条件下另 await `whenIdle()`。

Loader 在成功返回后把值的所有权交给管理器。如果 loader 在内部已经分配资源，但返回前自行抛错，则必须在 loader 内清理；管理器不能释放未交付的隐藏值。原生 dynamic import 不可真正取消，其模块缓存也不能由 manager 卸载；manager 能取消消费者、隔离迟到结果和释放约定由 loader 管理的派生资源，不承诺清除 JS 引擎模块缓存。模块与 IR 不同用途应使用不同 type。

## 身份与序列化

Descriptor 必须为有限、无环、无访问器的普通 JSON 数据。拒绝 undefined、函数、symbol、bigint、NaN、Infinity、Date、typed array、稀疏/附加属性数组、自定义对象原型、非枚举字段和循环引用。不会执行 getter 或 toJSON，也不会把 GPU 对象转换为 `{}` 后假装可恢复。

接收 descriptor 时深拷贝；向 loader 交付冻结后的副本。对象字段按规范化次序处理，嵌套键序差异不构成冲突，数组顺序保留，`-0` 按 JSON 语义归一化为 `0`。相同 type/key 使用不同 descriptor 会返回 `TC_RESOURCE_DESCRIPTOR_CONFLICT`，不触碰有效状态。身份表使用嵌套 Map，避免拼接字符串导致 type/key 分隔符碰撞。

```json
{
  "format": "pelican.resources",
  "version": 1,
  "resources": [
    {
      "type": "json",
      "key": "scene",
      "descriptor": { "url": "/compiled/scene.ir.json" },
      "state": "pending"
    }
  ]
}
```

快照按 type/key 排序，每身份只出现一次，不保存句柄、refcount、scope 树、函数、CPU/GPU 值。pending/loaded 表示捕获瞬间的真实状态；恢复时两者均重新 acquire，成功后才是 loaded，不通过快照伪造就绪状态。多份引用合并为身份是有意行为：恢复每身份一个 lease，需要更多拥有者时显式 acquire。

恢复为**增量重建**，不先清空 manager：校验格式、版本、精确字段、描述符合法性、唯一身份、loader 注册及现有 descriptor 冲突，再开始加载。成功不删除目标 scope 已有引用；失败/取消回滚临时 scope，原有有效状态保持可用。返回顺序与输入 resources 顺序一致，返回值类型是资源类型的联合；调用方已知具体类型时应以 handle.type 或实际数据验证收窄。

快照是显式持久化内容，可能包含应用自身放入 descriptor 的凭据。不要把它当成已脱敏日志；推荐 descriptor 使用无凭据的逻辑地址/资产 ID，鉴权在内部 provider 注入。

## 诊断、事件与计量边界

诊断固定包含 `code/severity/message/key/type/mode`，不输出 descriptor、异常 message/cause/stack 或原始 provider 错误。URL 身份中的 userinfo、query、fragment 会脱敏/移除，控制字符清理、长度限制；普通 logical key/type 不应包含秘密，任意无标识字符串中的秘密无法自动识别。事件同样使用清理后的身份，具有递增 sequence。

主要错误码：`TC_RESOURCE_INVALID_IDENTITY`、`TC_RESOURCE_INVALID_LOADER`、`TC_RESOURCE_LOADER_EXISTS`、`TC_RESOURCE_LOADER_MISSING`、`TC_RESOURCE_INVALID_DESCRIPTOR`、`TC_RESOURCE_DESCRIPTOR_CONFLICT`、`TC_RESOURCE_INVALID_SCOPE`、`TC_RESOURCE_DISPOSED`、`TC_RESOURCE_CANCELLED`、`TC_RESOURCE_LOAD_FAILED`、`TC_RESOURCE_DISPOSE_FAILED`、`TC_RESOURCE_STALE_HANDLE`、`TC_RESOURCE_NOT_READY`、`TC_RESOURCE_INVALID_SNAPSHOT`、`TC_RESOURCE_ESTIMATE_FAILED`、`TC_RESOURCE_OBSERVER_FAILED`。

事件包括 `TC_RESOURCE_LOAD_STARTED`、`TC_RESOURCE_LOADED`、`TC_RESOURCE_LOAD_ABORTED`、`TC_RESOURCE_LOAD_FAILED`、`TC_RESOURCE_RELEASED`、`TC_RESOURCE_DISPOSED`、`TC_RESOURCE_DISPOSE_FAILED`、`TC_RESOURCE_RESTORED`。它们描述管理器操作，不表示完整游戏场景已通过语义验收。

`inspect.bytes` 只估计当前条目的 owned payload。pending、无 estimator、estimator 抛错或返回非法数值时明确 unknown，并分别提供已知部分 `knownBytes` 与 `unknownEntries`；合法 0 是 known 0。未知值不是 0。已经失效但仍在加载/释放的操作单独列在 `inFlightLoads/inFlightDisposals`，不把无条目理解为所有异步任务都结束，更不将 owned bytes 当成进程/驱动全部内存。

累计计数包含加载、取消、释放成功/失败、迟到值释放及 peakEntries。`loadsStarted` 统计已调度的加载任务，同步取消可能令任务在调用 provider 前结束；真实 provider 调用次数由集成测试单独记录。管理器不判断多个不同身份是否返回同一个底层对象；provider 若自行跨身份共享对象，必须自己管理该共享所有权。

## 实测与测试

```powershell
node --import tsx --test tests/runtime-resources.test.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node packages/runtime/src/resources.ts tests/runtime-resources.test.ts
```

对应测试使用真实 deferred Promise、AbortController 和临时二进制文件，不只断言调用了同一个函数。包含共享加载、不同 scope、全部取消、忽略 abort 的迟到结果、代际复用、失败重试、释放异常、事务回滚、pending 恢复及 JSON IR/原生 dynamic import/二进制组合接入。

循环测试读取 8192 字节临时文件：200 次双 scope 获取/释放，加一次快照重建，共 201 次实际读取、201 次 disposal；期末 entries/references/scopes/inFlightLoads/inFlightDisposals 均为 0，peakEntries 为 1。墙钟耗时每次实测通过测试诊断输出，不作为固定性能保证。**这些是 owned counts 与小负载文件 I/O 证据，不是 OS、JS heap、GPU 或驱动泄漏审计，也不代表浏览器 GPU 集成已经验收。**
