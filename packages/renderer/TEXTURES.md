# M3 私有图片像素、surface 缓存与 RGBA8 打包

本模块供引擎内部 CPU surface / GPU 准备链路使用，不新增游戏 SDK API。
`three` 与 `three/webgpu` 必须复用同一 Three core；浏览器测试实际验证两者的
Texture / MeshStandardMaterial 构造器身份。

## 固定接口与接入

```ts
import { createTexturePixelProvider } from "./src/texture-pixels.ts";
import {
  createSurfaceTextureCache,
  extractSurfaceScene,
  packSurfaceTextureRGBA8,
} from "./src/surface.ts";

// 由内容所有者持有，不使用全局缓存。逐帧复用同一 provider / cache / decode。
const provider = createTexturePixelProvider();
const textureCache = createSurfaceTextureCache();
const options = {
  decodedTextureProvider: provider.decode,
  textureCache,
  materialAdapter: engineKnownMaterialAdapter,
};
const first = extractSurfaceScene(scene, options);
const next = extractSurfaceScene(scene, options);
// 未改变的纹理：first.textures[i] === next.textures[i]。

// GPU 内容所有者按冻结记录身份管理上传 buffer，仅新增/失效记录才打包上传。
const uploads = new Map();
for (const texture of next.textures) {
  if (!uploads.has(texture)) {
    uploads.set(texture, packSurfaceTextureRGBA8(texture));
  }
}

// 内容卸载或批次结束。两种缓存均不拥有外部 texture/material/bitmap。
uploads.clear();
textureCache.clear();
provider.clear();
// 最终销毁时调用 dispose()：释放引用，并禁止继续 decode / extraction。
textureCache.dispose();
provider.dispose();
```

`createTexturePixelProvider()` 返回可直接作为回调传递的
`decode(texture: THREE.Texture): SurfacePixelData | undefined`、`inspect()`、
`clear(): void`、`dispose(): void`。`inspect()` 是独立、可 JSON 序列化的状态对象，
包含 requests、canvasReads、cacheHits、nativeDelegations、textures、sources、
capacity 和带 textureUuid 的稳定诊断。clear 可复用，dispose 幂等且不可恢复。

## 图片读取、编码与所有权

同步 decode 仅接受当前 realm 的已解码 HTMLImageElement / 未关闭 ImageBitmap，
使用私有 OffscreenCanvas 2D，缺少 OffscreenCanvas 时使用私有 HTMLCanvasElement。
导入模块、构造 provider、native DataTexture extraction 均不访问 DOM；仅图片
decode 时检测实际 Canvas2D 能力。不会读取任意带 width/height/data 的对象作为图片。

getImageData 显式使用 sRGB Canvas2D，产物固定为 RGBA / unorm8 / origin: "image"。
没有在 provider 根据纹理的 flipY 或 colorSpace 翻行、做额外 sRGB 解码；surface
保持源像素编码，CPU 采样时按纹理元数据进行 flip、颜色转换与过滤。Canvas 自身
会执行浏览器的图片色彩管理；本接口不保留原压缩文件的 ICC profile 或 HDR 数据。
创建 ImageBitmap 时的 orientation / premultiplication 是图片所有者的责任，已经
烘焙进 bitmap 的变换无法从 bitmap 反推。透明像素经过 Canvas 的预乘/反预乘可能
发生浏览器量化；全透明 texel 的隐藏 RGB 不承诺无损。

共享 source 的纹理即使 flipY / colorSpace 不同，也复用同一次图片读取。
provider 缓存检查 source identity/version、image identity、实际尺寸和 HTML URL；
同一已见纹理的 texture.version 改变也使共享读取失效。每次返回独立 typed array，
调用者修改不会污染 provider 缓存。surface 将其复制为冻结的数值数组。原生
DataTexture 的字节/float32 数据由 surface 本身读取，provider 直接委托而不碰 DOM。

provider 从不调用外部 ImageBitmap.close()、texture.dispose() 或材质 dispose()。
clear/dispose 清空所有强引用、私有画布尺寸和读取缓存；外部图片与纹理由内容所有者
在 surface 捕获结束后释放。已交付的 immutable surface 不依赖这些外部资源的寿命。
缓存保留已遇到的资源身份，直到 clear/dispose；长生命周期内容热更时应在批次边界清理。

## 跨 extraction 复用与失效

`SurfaceExtractionOptions.textureCache?: SurfaceTextureCache` 由
`createSurfaceTextureCache()` 创建。缓存命中直接返回相同的冻结 SurfaceTexture，
跳过 provider 调用、像素展开和像素递归 freeze。首次构造直接 Object.freeze 数值数组，
避免对数百万元素额外分配 Object.values 临时数组。纹理之外的材质/几何仍按当前场景捕获。

签名包含 texture uuid/version、source identity/uuid/version、image identity、图片尺寸/
HTML 加载状态和 URL、format/type/mapping/channel/colorSpace/flipY、wrapS/T、filters、
anisotropy、generateMipmaps、premultiplyAlpha、特殊纹理 flags、custom mip 数量以及
offset/repeat/center/rotation/有效 UV matrix，且包含 provider 回调身份。失败/缺失像素
不会成为永久缓存，图片异步就绪后可重试。缓存不绕过材质/扩展校验。旧快照不随失效改变。

输入 DataTexture.data 原地编辑但未设置 needsUpdate 不承诺检测；修改后应设置
texture.needsUpdate 或 source.needsUpdate。替换 image/source 身份无需等版本递增即可失效。
外部 provider 改变内部数据也须按同样版本协议通知，或清除 surface cache。
`inspect()` 报告 entries/hits/texels 与 host 容量策略。clear 释放资源引用但不改变已交付快照；
dispose 后 extraction 抛 `SURFACE_TEXTURE_CACHE_DISPOSED`。

## materialAdapter

`SurfaceExtractionOptions.materialAdapter?: (material: THREE.Material) =>
THREE.Material | null | undefined` 在 snapshotMaterial 前调用；每次 extraction 对同一
原材质仅调用一次，所有 mesh / instance / triangle 复用结果。null/undefined 回退原材质。

主线提供已知引擎 MeshStandardNodeMaterial 的安全转换策略；这里不猜测或遍历任意 NodeGraph。
默认以及 adapter 未转换的 NodeMaterial 继续抛 `SURFACE_NODE_GRAPH_UNSUPPORTED`，替代材质仍
接受原有的标准 PBR/自定义 shader/扩展检查。adapter 对其转换的视觉忠实性负责。

原材质 UUID 是 surface 身份。extract 直接校验替代材质，在生成的 surface 记录上复制原材质
UUID；不会修改原 mesh、原材质或调用方替代材质，也不通过 clone 丢失应拒绝的 shader hook /
Node 字段。每个原材质分别缓存，即使 adapter 对多个原材质返回相同替代对象也保留各自 UUID。
原材质可见性仍决定是否进入 extraction。

## GPU 数据与当前边界

`packSurfaceTextureRGBA8(texture: SurfaceTexture): Uint32Array` 每 texel 一个 uint32，
R 位于 0..7、G 8..15、B 16..23、A 24..31；保留编码后的 RGB 和原始 image/texture 行顺序。
GPU 端按位解包，按 SurfaceTexture 的 colorSpace/flipY/UV/filter 元数据采样。
没有 Float32Array 全量暂存。返回 buffer 归上传者所有，修改不会影响冻结 CPU 像素；
应按 surface 记录身份缓存并随内容清理，避免每帧显式重新调用 pack。这里提供真实打包结果，
最终 GPU buffer 上传和 shader 采样由主线接入，本任务不修改其他 GPU 模块。

CPU reference 保留现有 normalized RGBA 数值、sRGB/ORM/normal 语义；float32 DataTexture
仍保留包括大于 1 的数值。RGBA8 pack 不支持 float32/HDR，抛
`SURFACE_TEXTURE_PACK_UNSUPPORTED`，不会截断 HDR。显式 custom mip chains、视频、数组、
压缩纹理、render target、premultiplied texture 与其他图片 type/format 不伪造像素。
当前只读取基础 level，不生成 CPU/GPU mip 链；HDR/宽色域、mip/LOD 正式支持留后续实现。

未设玩家图片大小或数量限制。capacity.policy 为 host、maxBytes 为 null；provider 报告
retainedBytes 和 canvasBytes（RGBA 逻辑字节，不含浏览器内部存储/JS 对象开销）。
unknownResources 是当前仍有解码诊断的纹理数量，具体身份和原因在 diagnostics；不把未知资源
当作零像素成功。宿主无法分配/读取时显式失败，已分配缓存由生命周期所有者清理。

| 稳定诊断                      | 含义 / 修复                                                                |
| ----------------------------- | -------------------------------------------------------------------------- |
| TC_TEXTURE_DOM_UNAVAILABLE    | 图片解码时没有 Canvas2D 环境；在浏览器解码或提供 native DataTexture        |
| TC_TEXTURE_IMAGE_UNSUPPORTED  | 图片不是当前 realm 的 HTMLImageElement/ImageBitmap；提供已解码的受支持对象 |
| TC_TEXTURE_IMAGE_NOT_DECODED  | HTML 图片未就绪或加载失败；await image.decode()                            |
| TC_TEXTURE_BITMAP_CLOSED      | 借用的 bitmap 已关闭；捕获前保留所有权                                     |
| TC_TEXTURE_CROSS_ORIGIN       | Canvas 受污染；服务器允许 CORS，并在 src 前设置 crossOrigin                |
| TC_TEXTURE_TYPE_UNSUPPORTED   | 不支持的 type/format/特殊纹理；提供受支持的基础 RGBA8 图片                 |
| TC_TEXTURE_CANVAS_UNAVAILABLE | 宿主无法创建 2D context                                                    |
| TC_TEXTURE_CAPACITY           | 维度不可寻址或宿主分配失败；检查实际资源/宿主内存                          |
| TC_TEXTURE_READ_FAILED        | 其他真实绘制/读取失败；检查图片寿命、解码和画布能力                        |
| TC_TEXTURE_PROVIDER_DISPOSED  | provider 已终止；为新内容创建新实例                                        |

失败返回 undefined，surface 保留纹理身份并产生 `SURFACE_TEXTURE_PIXELS_UNAVAILABLE`，
具体 TC 原因通过 provider.inspect() 读取，不合成纹理颜色。

## 测试入口

无需安装依赖，默认运行共享缓存中的 Chromium headless（随机端口，真实图片/GLB parse）：

```sh
node node_modules/tsx/dist/cli.mjs --test tests/texture-pixels.test.ts tests/surface.test.ts
```

纯 Node 路径，不启动浏览器：

```sh
node tools/run-with-env.mjs PELICAN_TEXTURE_BROWSER=0 -- node node_modules/tsx/dist/cli.mjs --test tests/texture-pixels.test.ts tests/surface.test.ts
```

浏览器测试只读取当前 worktree 的 examples/m2/assets/Fox.glb、WaterBottle.glb 及共享
node_modules；不打开主 worktree。测试有 Node deadline，browser 与两个随机端口 server
在 finally 清理；外部 GLB ImageBitmap 由测试作为所有者关闭。真实采样结果必须包含纹理
颜色差异，WaterBottle 必须存在 ORM 差异，重复 extraction 必须复用冻结纹理记录。
