# 图形与运行时使用指引

本文说明当前源码中的图形与运行时接口，不宣称完整高级渲染已完成或验收。实际版本见项目清单，当前状态见 [能力边界](CAPABILITIES.md)。历史阶段名称、实验结果和旧标签仅适用于各自记录的源码，不代表当前版本通过。功能应通过相应的类型、数值与浏览器测试确认；未执行内容不能视为通过。

## 高质量默认值

默认是 `raster`；显式高档 `path` 启用时域历史与空间降噪，4 samples/frame、8 bounces；原生 DPR、默认 studio IBL 与作者曝光保留。IBL 可用 `lighting: "none"` 关闭，提供 lightingTexture 时使用作者纹理。阴影图 4096 与各向异性过滤服务于光栅路径，不是路径追踪采样参数。

`renderQuality()` / `"low"` / `"realtime"` 选择默认光栅；显式 `"high"` 选择 path；`"medium"` / `"preview"` 为 hybrid、2 samples/frame、4 bounces 与降噪；`"low"` 为 raster、关闭追踪降噪；`"capture"` 为 path、4 samples/frame、12 bounces、不做降噪。HYBRID 使用光栅首命中和完整首命中直接光技术评估，降低多灯随机选择的方差，间接传输使用独立预算。作者可覆盖参数；不自动降低分辨率、削减模型或以模糊掩盖噪点。高/中/低不保证所有场景的耗时排序。路径与混合必须实际支持 WebGPU，软件 BVH 不调用硬件 RT。

玩家可在启动前显式选择 `?quality=high|medium|low`，仅覆盖质量参数，保留曝光与光照开关。没有该参数时尊重游戏 render 声明，省略 render 使用默认 raster，WebGL2 可直接运行。显式 path/hybrid 不支持时报告诊断，不静默降级。游戏内通过 `ctx.render.configure(renderQuality("medium"))` 切完整档；单独 `configure({mode:"raster"})` 会在未指定 denoise 时将其关闭。

首次显示一个追踪档位时，在作者分辨率下先累积至少 64 样本，再替换当前画面；显示进度且不推进游戏仿真。它减少首次出现的粗噪声，不保证任意场景已完全收敛，低性能设备也会等待更久。开发 automation 明确跳过这个展示阶段，使逐样本测试与捕获预算保持可控。动态照明使用重投影、邻域裁剪和有界历史；纹理、材质结构与模式变化仍清除不兼容历史。不要通过减少分辨率或抹平材质细节冒充更高画质。

启动选档不改变作者默认值的存档契约。存档仍保存当前渲染状态，恢复可回到保存时的档位；若保存状态需要当前后端不支持的 path/hybrid，则预检失败并保留旧世界，不伪装成功或偷偷改存档。

在加载阶段或游戏系统调用 `ctx.render.prepare("path")`，请求将在帧边界准备共享追踪管线、场景和运动历史资源；`ctx.render.preparation("path")` 返回 idle/queued/preparing/ready/failed、耗时或错误。它不切档、不推进玩法，不是预渲染高采样图，也不保证驱动永不回收缓存。高/中档共用追踪资源，首次准备仍有成本；视口、内容所有者或设备重建会失效，失败可以再次请求。切回低档保留缓存以便切回高档，可能继续占用显存。异步准备放帧边界，系统回调仍同步。

离线积累样本通过 render 命令显式指定。镜头/物体移动会使渐进积累重置，时域滤波使用有效重投影的历史，不承诺无拖影或所有高模场景实时达标；真实预算、分辨率、动态画面和内存都需实测。正常游戏不再初始化历史 M0 GPU 追踪侧车，静态几何的运动数据按当前/上一已渲染版本复用，变形、拓扑和所有权变化保持失效检查。

## 模型材质槽

模型可用 `materialSlots: { Paint: replacement }` 按加载后的材质名称精确替换该名称的全部材质槽，其余槽保留原材质；与整体 `material` 覆盖互斥。同名槽会一起替换，不能区分同名或无名槽。未知名称返回 `TC_MODEL_MATERIAL_SLOT_MISSING`，诊断包含部分可用的已加载材质名；名称或数量过多时会截断。未知目标材质也会明确报错，替换材质的生命周期仍由引擎管理。仓库示例 `examples/material-slots` 展示此接口；它不代表所有 glTF 扩展均受支持。

模型实际包含 `KHR_animation_pointer` 动画通道时当前明确拒绝并报告 `TC_MODEL_EXTENSION_UNSUPPORTED`；不要将其材质动画当作已经播放。只声明可选扩展而没有使用该通道的模型不因此被拒绝。普通 glTF 平移、旋转、缩放与 morph 动画仍按现有接口使用。

## 不透射介质折射率

`defineMaterial({ id, ior, transmission: 0, ... })` 可为不透射的物理材质指定有限正数折射率，默认值为 1.5。介质法线入射反射率由 `((ior - 1) / (ior + 1))²` 决定；光栅、hybrid 和 path 共享该输入，路径采样与 PDF 也使用对应反射率。金属部分仍使用 baseColor 的 F0。`attenuationColor` 和 `attenuationDistance` 仍要求正的 transmission，不能用不透射 IOR 伪装体积吸收。

仓库中的 `examples/opaque-ior` 以三个黑色平面展示差异；相关 probe 是历史开发验证入口。该例不代表完整物理材质扩展或当前版本验收；npm 渠道使用同一公开接口。

不透射物理材质还可设置 `specularIntensity`（0 到 1，默认 1）和 `specularColor`（sRGB `#rgb`、`#rrggbb` 或颜色名称，默认白色）。这两个因子参与介质高光、掠射和 path/hybrid 采样；金属部分仍由 baseColor 决定。非默认高光与正 `transmission` 的组合目前返回 `TC_MATERIAL_SPECULAR_TRANSMISSION`，不会悄悄使用默认值。

自包含 GLB 可使用 `KHR_materials_specular`／`KHR_materials_ior` 的常数材质因子；不透射材质还支持 specular 强度纹理 alpha 与 sRGB 颜色纹理 RGB，资产仅接受 TEXCOORD_0，`optimize` 保留并复核因子、图像和采样配置。高光颜色 PNG 支持 1/2/4-bit 灰度和调色板 Adam7、无色彩元数据的 16-bit，以及 gAMA 45455/100000、标准 sRGB cHRM、sRGB intent 0、cICP [1,13,0,1]；其他 16-bit 色彩块值和 ICC 仍明确拒绝。正透射结合高光纹理及其他未实现扩展仍不支持。示例 `examples/specular-material`、`examples/specular-textures` 和 `examples/specular-textures-16` 对照导入材质；探针属于历史开发记录。完整材质矩阵仍需覆盖更多资产与后端；公开 registry 安装与当前源码 tarball 安装是不同检查。

## 计算到渲染的缓冲绑定

`defineGame({ computeBuffers: [...] })` 可在首帧前建立受管理缓冲。材质以 `buffers: [{ name, type, buffer?, count? }]` 声明槽，顶点图和片元 `graph`/`graphs` 的 `readBuffer` 引用槽名；初始 `buffer` 必须引用已声明的逻辑 ID。游戏通过 `ctx.render.buffers.bind(materialId, slot, handle)` 改绑，`unbind` 解除引用，`state(materialId)` 查询已绑定的逻辑名称/类型/数量，不能取得底层对象。活跃未绑定槽、类型/数量不符和失效句柄明确报错。

计算任务先产生候选 GPU 输出，完成着色器/越界/非有限值及 CPU 结果校验后才发布新 revision。渲染器对已提交原生缓冲做 GPU→GPU 复制到自己持有的稳定 Three storage 属性，不把 CPU 镜像重新上传当作 GPU 绑定。首次值、显式 CPU 写和恢复检查点可以上传；`inspect` 中 `computeGpu` 区分上传、候选、提交和版本，`bufferBindings` 区分 GPU 复制与渲染属性资源。当前不是零复制，也不是完全无读回：CPU 镜像仍用于任务校验、快照、动态 bounds/BVH 和查询。

被渲染槽引用的缓冲不能 release，先解除所有引用。检查点只保存逻辑绑定；跨插件预检确保 compute 快照包含匹配的 ID/类型/count，失败不改变旧世界。恢复后原缓冲句柄失效，游戏应按名称 resolve；物理 GPU 资源重新建立。WebGL2 上活跃 storage 槽返回 `TC_RENDER_BUFFER_CAPABILITY`，不会上传 CPU 镜像伪装 WebGPU 功能。

后处理以 `definePostProcess({ id, buffers: [...], graph })` 声明相同的类型化槽，通过 `ctx.render.effects.buffers.bind(passId, slot, handle)`、`unbind`、`state` 管理。材质 ID 与 pass ID 是独立命名空间，可以同名。两类槽联合保护逻辑源缓冲，取消其中一个引用不会移除另一类引用的 pin。快照同时预检两类绑定与 compute peer，失败不部分恢复。

片元和后处理允许从 `uv` 等逐像素输入计算动态索引，使用 `floor` 得到整数。负数、非整数、非有限或超过元素数的渲染读取明确返回该类型的零值，不取相邻元素；bool 为 false。compute 越界仍使任务失败，顶点域仍由 CPU 几何镜像执行索引检查，不能把渲染 gather 的零边界语义套到计算任务。

path/hybrid 将常驻 GPU 数据复制进原生材料表的附加 vec4 区域；CPU 表只写材质、参数和零占位。`rendering.surface.materialGraphs.bufferSlots` 记录原生槽的复制、字节、版本和零 CPU 结果上传；资源版本变化使积分/时域失效，未变化帧跳过复制。渲染复制不等于零复制，计算仍逐任务读回验证镜像。

顶点反馈例子为贡献者测试 `examples/compute-render`，片元/后处理为 `examples/fragment-buffers`。游戏作者使用 npm 包内同样的公开声明与 `render.effects.buffers`，无需引擎源码。贡献者可运行 `npm run probe:fragment-buffers` 复测；结果仅覆盖实际执行的组合。

## 受控顶点图

`defineMaterial({ vertex: { position?, normal? } })` 接受 vec3 输出图。输入可用 `positionLocal`、`normalLocal`、`vertexIndex`、`instanceIndex`、uv/uv1、固定时间、参数及声明纹理的 base-LOD 采样；材质域、计算域和后处理域不能冒用这些输入。至少定义一个通道。

这里的 local 明确指内置 morph、骨骼和实例变换之后、对象世界矩阵之前。position 返回绝对位置，不是位移增量；normal 输入已归一化，输出零向量时保留它。GPU 光栅节点和 f32 CPU 镜像读取同一原始输入快照。未提供法线图时不会自动推导变形微分，也不会自动修正切线或所有法线贴图组合。

使用 `model: { asset, material }` 可显式整模替换导入材质，把顶点图用于带骨骼/morph 的模型；不传 material 保留原资产材质。覆盖材质由游戏内容所有者持有，模型实例与模板不会销毁借用材质。当前是整模替换，不是按源材质槽合并。

引擎从同一变形几何维护对象包围体和渲染射线查询，剔除保持开启，路径/混合 BVH 会更新或 refit。Transform 和显式物理 collider 不被 shader 改写；本功能不等于自动 Rapier 形变或物理系统耦合。

最小例子：`npm run dev -- --project examples/vertex`。数据纹理和小型带骨骼/morph GLB 是可离线重建的 MIT 夹具；`node --import tsx tools/prepare-vertex-assets.ts` 可重新生成。历史开发入口为 `npm run probe:vertex` 和 `npm run probe:postprocess:occlusion`；它们不构成当前版本完整验收。

## 受控 HDR 后处理

通过 `definePostProcess({ id, graph, enabled? })` 声明 vec4 输出图，并在 `defineGame({ postProcesses: [...] })` 中显式排序。系统使用 `ctx.render.effects.configure/state/setParameter/resetHistory`。受管后处理不接收任意 Three.js 或原始 GPU 对象；周围的玩法与算法仍可组合普通 npm 模块。

图支持 `uv`、`screenSize`、`texelSize`、固定时间和已有类型化参数/算术。`sampleFrame` 的 channel 可为 `scene.color`（未曝光/未色调映射的线性 HDR）、`scene.normal`（世界空间着色法线 RGB，命中 alpha=1）或 `scene.depth`（R 为相机到首表面的世界单位距离，未命中 0），也可为更早 pass 的 ID。`sampleHistory` 读取已声明 pass 的上一个成功提交呈现帧；不允许当前帧的前向依赖。

pass 输出为全尺寸 rgba16float，捕获保持场景原 MSAA，最终曝光/色调映射和颜色转换只执行一次。无启用效果时仍走原直出链路。后端缺少所需 HDR/MSAA/MRT 能力则明确报 `TC_POSTPROCESS_CAPABILITY`，不会自动降尺寸、采样或精度。颜色、法线和距离不是透明多层 G-buffer；半精度范围、复杂透明与逐像素算术溢出的完整诊断矩阵尚未验收。

效果开关及参数参与 CPU 检查点；反馈纹理不序列化，恢复/内容/模式/设备变化明确重置历史。开关变化会防御性重置所有历史；关闭的 pass 不再推进历史，当前帧输出为上游直通。参数改变默认保留历史，需要时显式 `resetHistory(id?)`。反馈按呈现帧推进，不是游戏物理时间或存档状态。

最小三段例子在 `examples/postprocess`：`npm run dev -- --project examples/postprocess`。`npm run probe:postprocess` 是历史开发验证入口；它不构成当前版本完整画质或性能验收。

## 受管理计算

声明 `defineCompute({ id, count, outputType, buffers, graph })`，其中 `buffers` 为具名只读绑定及其 GraphType。计算图用 `input/index`、`readBuffer`、参数和既有算术节点表达计算，不接收原始 shader 或 GPU 对象。系统通过 `ctx.compute` 创建/查询/读写/释放缓冲，派发任务并查询或取消任务；类型、维度、绑定、越界和非有限输出均有明确诊断。

引擎在每个固定 tick 后等待 GPU 任务结算；`readBuffer` 返回上次完整成功结果的 CPU 镜像，失败或取消不覆盖输出。输出可同时作为输入，读取的是派发前快照。枚举 `tasks()` 并释放终态任务，避免无限保留历史；恢复后按缓冲名称 `resolve()`，不复用旧句柄。快照/回放/设备重建已接入，WebGL2 不执行计算。

仓库最小反馈游戏：`npm run dev -- --project examples/compute`。`npm run probe:compute:numeric` 和 `npm run probe:compute` 是历史 GPU 开发验证入口，不构成当前源码的完整能力验收。

显式依赖使用 `bindings: { name: { task: predecessor } }`：读取该任务的确切成功输出，即使同一源缓冲已经被后续任务覆盖。`after: [predecessor]` 只约束执行顺序，普通缓冲句柄绑定仍读取派发时快照；参数与 time 也在派发时固定。只能引用同一运行时已有的未释放任务，不支持前向/跨 owner 引用。

失败或取消的前置任务使消费者以 `TC_COMPUTE_DEPENDENCY_*` 失败，不运行其 GPU 计算、不发布输出；独立任务继续执行。仍被未完成消费者引用的任务不能释放（`TC_COMPUTE_TASK_IN_USE`）。未释放成功任务会保留其 CPU/GPU 结果版本，及时 `releaseTask` 才能回收历史。已排队的任务结果绑定保护源缓冲；已释放的源资源不能通过旧任务复活。

任务不序列化进快照。游戏不要把临时任务句柄作为持久状态：恢复或设备重建后重新派发链路；源缓冲按名称 resolve。公开示例 `examples/compute-dependencies` 演示分支、覆盖、纯顺序依赖及失败隔离；小型串行硬件验证为 `npm run probe:compute-dependencies`。

当前任务仍顺序执行且每节点读回 CPU 镜像，不是一次批量 GPU-only DAG。GPU 常驻顶点/片元/后处理的缓冲和纹理绑定、顶点图、HDR 后处理及计算纹理核心已接入；完整高级图形矩阵仍待完成。现有链路不等于完整能力已验收。

## 计算纹理

使用 `defineGame({ computeTextures: [{ id, width, height, data? }] })` 或 `ctx.compute.createTexture(...)` 创建受管理二维纹理。格式固定为线性 `rgba32float`，data 为行优先 Vec4 数组；宽高必须是正整数，总 texel 数最多 2^24，实际 GPU 限制另行校验。纹理与缓冲共用唯一 ID 空间，但句柄不同，不能混用两类 API。

`resolveTexture(id)` 按名称获取句柄，`describeTexture` 返回尺寸/格式/revision，`readTexture` 返回上次完整成功结果的分离 CPU 镜像。`writeTexture(handle, texels)` 写整图，第三参数 `{x,y,width,height}` 可写矩形；全部数据和范围先通过检查，再一次更新 revision。`releaseTexture` 拒绝仍有未结束消费者的源。

计算内声明 `textures: [{ name, filter?, wrapU?, wrapV? }]`，图中 `sampleTexture` 引用该槽名。filter 为 nearest/linear（默认 linear），寻址为 clamp/repeat/mirror（默认 clamp）。dispatch 通过 `textures: { name: textureHandle }` 捕获派发时输入，或 `{ name: { task: predecessor } }` 读取该任务的确切纹理版本；`after` 仍只提供顺序。纹理不能传给普通缓冲 bindings。

dispatch.output 可为纹理句柄，此时 outputType 必须为 vec4，count 必须等于 width×height。计算输入 `pixelCoord` 是输出整数坐标，`outputSize` 是输出宽高，`uv` 是 texel 中心归一化坐标；缓冲输出视为 count×1，index 保持线性索引。非有限采样 UV 使整个任务以 `TC_COMPUTE_TEXTURE_COORD` 失败，有限域外 UV 按声明寻址。

同一 GPU compute shader 写真实 storage texture 和验证用 packed buffer，校验后成对提交；失败/取消不发布其中一半。后续采样重用确切 GPU 版本，不上传 CPU 计算结果。初始化、显式 CPU 写、恢复后的检查点可以上传；`computeGpu.textureUploads/liveTextures/textureResidentHits/storageTextureDispatches` 可观察实际纹理资源与使用。任务仍读回 buffer 验证，不能宣称 GPU-only。

纹理句柄不跨恢复保存，恢复后按名称 resolveTexture，重新派发临时任务链。示例 `examples/compute-textures` 只导入公开 SDK；源码渠道运行 `npm run dev -- --project examples/compute-textures`，小型硬件复测 `npm run probe:compute-textures`。npm 渠道使用同样的类型/接口与随包本文档。

## 动态纹理渲染与资产

材质和后处理各自声明 `textures: [{ name, texture?, width?, height?, filter?, wrapU?, wrapV? }]`；`texture` 是初始的受管理纹理 ID，不是资产对象。图中 `sampleTexture` 的 texture 使用该槽名。槽名不能与静态纹理资产 ID 相同；静态资产采样仍走原来的接口。运行时通过 `ctx.render.textures.bind(materialId, slot, handle)` 或 `ctx.render.effects.textures.bind(passId, slot, handle)` 改绑，两个服务都提供 `unbind` 和 `state`。尺寸约束可省略；已经绑定的尺寸变化须重新 bind。

槽可用于材质片元、顶点位置／法线和后处理。顶点 CPU 镜像使用相同过滤与寻址维护变形 bounds/BVH 和射线查询，不改变物理 collider。渲染采样非有限 UV 明确返回透明零值；计算采样非有限 UV 仍导致 `TC_COMPUTE_TEXTURE_COORD`。材质／后处理与缓冲／纹理四组引用联合 pin；纹理被引用时 `releaseTexture` 保持现有 `TC_COMPUTE_BUFFER_IN_USE` 错误码。

`computeTextures: [{ id, asset }]` 或 `ctx.compute.createTexture({ id, asset })` 可以从声明并加载的普通纹理资产建立独立计算纹理。支持可读的 RGBA8 或 float32 像素；按资产声明的 sRGB／linear 色空间转换为线性数据并保持上传行顺序。计算纹理之后独立更新，快照保存像素而非依赖重新读取资产。资产不可读、未声明或格式不支持时返回 `TC_COMPUTE_TEXTURE_ASSET`。

Three 路径将常驻纹理以 GPU→GPU 复制到自身资源；path/hybrid 将同版本的 GPU packed mirror 复制到已有材料表。两条路径不会把 CPU 计算结果上传作为渲染更新，但也不是零复制。`rendering.textureBindings` 和 `rendering.surface.materialGraphs.textureSlots` 可查看复制计数；活跃槽在 WebGL2 返回 `TC_RENDER_TEXTURE_CAPABILITY`。贡献者示例 `examples/render-textures` 与 `npm run probe:render-textures` 用于复测；发布回归使用实际 npm 包。

## 场景与公开设置

```sh
npm run dev
```

默认加载 `examples/m3` 的真实 Fox/WaterBottle 画廊。`1/2/3` 切换 raster/hybrid/path；Space 切换刚体运动，N 切换空间降噪，D/I 切换直接/间接光照。游戏只导入 `pelican-engine`。

```ts
export default defineGame({
  id: "render-example",
  scene,
  render: {
    mode: "path",
    samplesPerFrame: 1,
    maxBounces: 6,
    denoise: true,
    denoiseIterations: 3,
    exposure: 1,
    directLighting: true,
    indirectLighting: true,
    debug: "beauty",
  },
  systems,
});
// 在同步玩法系统中：
ctx.render.configure({ mode: "hybrid", denoise: true });
const settings = ctx.render.state();
```

设置是可序列化状态，参加 Host 快照和恢复；未知字段、非法数值或模式明确失败，不公开 GPU 对象。调试视图支持 beauty/albedo/normal/depth/samples。材质支持 emissive/emissiveIntensity/opacity/transparent/alphaTest/side；`transparent: true` 可在 opacity 为 1 时启用纹理 alpha 混合，默认仍由 opacity 决定。显式关闭混合与 opacity 图或无裁剪的部分不透明度冲突时编译拒绝。相关渲染和路径追踪尚无完整的组合覆盖矩阵；opacity 的随机覆盖不是折射。

## 物理透射开发链路

```ts
const glass = defineMaterial({
  id: "glass",
  color: "#ffffff",
  roughness: 0.15,
  metalness: 0,
  transmission: 1,
  ior: 1.5,
  attenuationColor: "#80c0e0",
  attenuationDistance: 2,
});
```

`transmission` 是介电透射与不透明 BSDF 的混合比例；它不修改 opacity。IOR 必须为正，透射要求 metalness 为 0；正衰减距离按世界单位计算 Beer 吸收，颜色先转为线性值，距离为 0 关闭吸收。SDK 不暴露底层材质对象。

path/hybrid 将正透射对象的闭合几何边界编入介质目录，支持平滑/粗糙折射、反射、嵌套介质和相机内部初始状态。每个对象或实例必须是单个闭合、连续、非自交壳体；相交/接触体积、开口和部分不透明边界有明确诊断。目录不是通用自交证明；复杂重叠介质、空腔、多壳体、光谱色散尚未实现。透视相机的近裁剪区域与体积包围盒接近时，使用逐射线近裁剪面介质初始化；如场景含透明度裁剪的透射壳体则报 `TC_TRACE_NEAR_MEDIA_UNSUPPORTED`。此保守检测可能产生额外 GPU 开销，行为和性能未验证。完整规则见 `packages/renderer/MEDIUM.md`。

```sh
npm run dev -- --project examples/refraction
```

该项目仅使用公开 SDK，包含吸收平板、内外相机、嵌套边界、折射/粗糙度、尺度/平移和介质内点光源对照。线性图像、边界错误计数与解析 Beer 断言由历史开发探针检查；不能把可见玻璃球当成完整画质验收。光栅使用物理材质实现，但其屏幕空间透射/厚度与路径体积的一致性仍需补验。

## 已有链路

- 正交相机的普通游戏场景已有 WebGPU hybrid/path 和逐采样初始介质开发实现；透射壳体支持一致的两种整体绕序及镜像变换；使用透明度裁剪时报 `TC_TRACE_ORTHOGRAPHIC_MEDIA_UNSUPPORTED`。壳体须闭合且互不相交或严格嵌套；采样点靠近边界或分类歧义报 `TC_TRACE_MEDIUM_STATE`，不得降级冒充。历史 M0 侧车仍仅支持透视光追，WebGL2 仍仅光栅。分类、射线、重投影及性能需按具体设备与场景覆盖，不能从基础案例推断全部通过。
- 光栅模式使用 WebGPURenderer，WebGPU 初始化不可用时走 Three.js 内置 WebGL2 回退，不主动降画质。`game.render.capabilities()` / `ctx.render.capabilities()` 返回当前后端及可用模式；WebGL2 下切 path/hybrid 返回 `TC_RENDER_MODE_UNAVAILABLE`，降噪/计算返回 `TC_RENDER_COMPUTE_UNAVAILABLE`，原设置保持不变。两后端都不可用返回 `TC_RENDER_BACKEND_UNAVAILABLE`。状态栏同步显示 WebGPU/WebGL2。
- path 使用当前表面/BVH 的实际光线命中，UV、法线、PBR 纹理和多材质组进入 WGSL。
- hybrid 光栅化首命中，再使用同一材质/灯光进行真实阴影与二次光线求值，不透明叠加独立图片。
- 支持点/方向光、环境辐射、发光几何及 MIS；studio PMREM 捕获实际 HDR，不用均值或假背景替代。
- 内容变更、相机、灯光、材质和设置变化使路径累积失效。开启 denoise 后独立主命中通道输出上一帧 UV/预期深度，先做时域历史验证/邻域裁剪，再做空间滤波；静态连续累积不重复计入历史。完整时域画质矩阵仍未验收。
- 设备丢失会暂停并尝试重建设备/管线/环境，保留 CPU 游戏状态；失败保持故障诊断。自动化就绪不依赖点击、焦点或按回车。

当前 capture/cache、CPU SAH/refit 与 GPU 线程化遍历是不同阶段。它们不等于 GPU refit、BLAS/TLAS 或专用硬件 RT。原生 1080p 的当前高反弹负载仍慢，性能优化和完整质量矩阵未完成。

`examples/temporal` 是只用公开 SDK 的运动/遮挡/动画/资源恢复测试场景。
`denoiseIterations` 仅控制空间迭代次数；`denoise=false` 关闭时域与空间链路。
内部开发读回不是游戏接口。时域历史的权重不是严格独立的光线样本数，
不能据此把低 spp 动态帧宣称为高 spp 物理参考。详见 `packages/renderer/TEMPORAL.md`。

## 开发复验

### 刚体角运动

`ctx.physics.angularVelocity(entity)` 查询世界坐标弧度／秒；`setAngularVelocity(entity, vec3)` 设置动态刚体角速度，`torqueImpulse(entity, vec3)` 施加世界空间力矩冲量，`impulseAtPoint(entity, impulse, worldPoint)` 在指定世界坐标施加冲量，同时影响平动和转动。后三者只支持动态刚体；固定、运动学或角色体返回 `TC_PHYSICS_BODY_TYPE`。写操作参与物理历史、快照和回放，旧快照仍兼容。

示例 `examples/angular-physics` 只使用公开 SDK；源码渠道运行 `npm run dev -- --project examples/angular-physics`。首次移除、即刻查询、回放与恢复由专项回归覆盖；旧缺陷及修复可在 Git 历史追溯，不能把单个案例推广为全部模拟组合通过。游戏作者通过 npm 使用同一公开 SDK。

```sh
npm run typecheck
npm run probe:backends
npm run build
```

历史开发 probe 会生成带源码指纹的记录和图像；失败不覆盖成成功。探针结果仅对应实际执行的源码、设备与场景。

构建仍为 `dist/`，可在普通静态服务器子路径部署；默认生产不暴露开发控制 hook。`tools/m3-static-probe.ts` 使用真实按键测试模式切换和冷启动。直接浏览器自动化是外部测试职责，游戏源码不得调用内部开发 hook。

当前公开图语言仍是有限子集。后处理、多通道、变形和计算接口的完整表达矩阵、完整物理材质图像矩阵、时域重建、性能及独立使用验收仍有缺口。普通版本发布不代表这些能力已验证或完整首发已完成。

## 光栅环境遮蔽

WebGPU 内置光栅使用全分辨率法线/深度预通道、32 样本 GTAO 与深度/法线约束过滤，只调制间接光，避免把直接光和高光一起乘黑。固定空间采样不积累运动历史；它增加预通道与像素开销，需要按场景实测。`ctx.render.configure({rasterAmbientOcclusion:false})` 可关闭，保留高质量标准 PBR 光栅。

WebGL2 使用标准光栅；作者声明自定义后处理时，自行负责呈现，内置 GTAO 不叠加。`inspect.rendering.rasterPresentation` 报告实际路径。屏幕空间遮蔽不提供离屏全局光照、真实反射或硬件 RT；高模资产、灯光、阴影范围和纹理决定最终质量，不能据此宣称所有场景达到 AAA。
