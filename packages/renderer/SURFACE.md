# M3 Surface 前置实验

状态：独立 worktree 数据契约与 CPU reference，未集成主线，不代表 M3 完成或 GPU tracing 支持。仅新增 `src/surface.ts`、本文件和 `../../tests/surface.test.ts`；不改 geometry/pathtrace、SDK、依赖、根配置或版本，不提交。后续必须等待 M2 发布后再审查集成。

## 私有 API

```ts
extractSurfaceScene(scene: THREE.Scene, options?: SurfaceExtractionOptions): SurfaceScene;
sampleSurfaceMaterial(snapshot: SurfaceScene,
  triangle: number | SurfaceTriangle, barycentric: SurfaceVec3,
  options?: SurfaceSampleOptions): SurfaceMaterialSample;
```

仅从 renderer 私有模块导入，不经 SDK 暴露 Three。同步提取当前 pose，不推进 AnimationMixer、不修改源场景/矩阵/骨骼 palette/纹理矩阵。调用者先推进动画；当前 TRS 根据 matrixAutoUpdate 计算，matrixWorldAutoUpdate=false 时尊重已有 matrixWorld。Scene 外祖先仅用于坐标计算，不参与遍历/可见性剪枝。

`SurfaceScene.version=1`，包含 triangles/materials/textures/diagnostics。普通对象与数组（包括所有像素）递归冻结，无源 Three 对象或 TypedArray 的可变引用。相同 material/texture 对象只入表一次；记录 material.uuid、texture.uuid 和 texture.source.uuid，不用文件名或像素去重。新调用生成新快照，不是资源缓存或内容版本追踪器。

三角形保存 objectUuid/geometryUuid/instanceId/instanceColor、materialUuid、原 materialIndex/groupIndex、elementOffset、vertexIndices、三个 world-space 顶点和组合 normalMatrix。单 mesh 的 instanceId 为 0，单 material 的 groupIndex 为 -1。材质引用以 uuid 关联，不以数组位置隐式关联。单位完全沿用输入，没有米/厘米换算；矩阵为 Three column-major。无固定 float32 GPU binary layout、上传器或加速结构。

## 提取范围

| 输入                      | 确实实现的行为                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh indexed / nonindexed | 根据 position/index、drawRange 与 groups 分三角形；multiMaterial 每组选择真实材质。单 material 忽略 groups。multiMaterial 无 groups 不绘制。交叠组保留重复绘制，不擅自去重。                                                                               |
| 边界与非法数据            | 有效组与 drawRange 交集必须为完整且对齐的三角形；缺 position/geometry/material index、非法索引、attribute count/itemSize、不支持 CPU attribute、NaN/Infinity、退化三角形、奇异/非 affine 矩阵均 throw。                                                    |
| World / normal / tangent  | 当前 local/ancestor/instance 矩阵合成；位置 world-space，normal inverse transpose 后归一化，tangent 方向变换并保留 w。支持非均匀缩放、负缩放和 affine shear。保留的是属性法线方向，不因负 determinant 擅自反转；frontFacing 由调用者按命中朝向提供。       |
| UV / color                | UV0=`uv`、UV1=`uv1`、RGB/RGBA color、tangent 如存在即保留；normalized/interleaved 属性经 Three accessor 读取。无 normal 或 flatShading 使用几何面法线。                                                                                                    |
| Morph                     | 当前 position/normal/color 权重；relative 与 absolute，先 morph 后 skin。保持源 buffer/weights 不变。非法 target shape、未知 morph 属性拒绝。                                                                                                              |
| SkinnedMesh               | 当前 bone world × bone inverse、bind matrix 与 attached/detached bind mode；4 权重需非负且和为 1。position 和 normal/tangent 实际变形。skin normal 使用锁定 Three 的加权 skin matrix 方向变换，再 world inverse transpose，不假称对 skin matrix 求逆转置。 |
| 原生 InstancedMesh        | 每个 instance matrix、instanceColor 和 instance identity 单独展开；普通 Mesh 的 extractor 不能替代这个路径。实例 morph 明确拒绝。                                                                                                                          |
| 可见性与 layers           | visible=false 剪枝；默认所有 layer，options.layersMask 逐对象筛选，layer 不剪枝 children；noTrace 与 material.visible 只过滤自身。只遍历传入 Scene 子树，不采 sibling，不做 camera/frustum/LOD 决策。                                                      |

## 材质与纹理

材质只接受真实原生 MeshStandardMaterial / 无活跃扩展的 MeshPhysicalMaterial；读取 color、opacity、roughness、metalness、emissive/intensity、normalScale/type、aoMapIntensity、side、vertexColors、flatShading、transparent 与 alphaTest。不将 arbitrary material 强制 cast 后冒称 PBR。baseColor/emissive 已是 Three working-linear RGB，不重复 sRGB 解码；只接受 working LinearSRGBColorSpace。

| 槽                                  | CPU reference                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| map                                 | 线性 RGB × material color × vertex RGB × instance RGB；alpha × opacity × vertex alpha。                                                                          |
| alphaMap                            | green × alpha，与 map alpha 共同参与 cutoff/透明。                                                                                                               |
| metalnessMap / roughnessMap / aoMap | 分别 B/G/R 通道；metalness/roughness 乘 material factor；occlusion = 1 + (R - 1) × intensity。支持同一 texture identity 共享 ORM。                               |
| emissiveMap                         | linear RGB × emissive × emissiveIntensity。                                                                                                                      |
| normalMap                           | tangent/object-space；normalScale、side、normalMatrix；有 tangent 使用切线与 w。无 tangent 的 CPU reference 用该槽 transformed UV 推导三角形 TBN，退化 UV 抛错。 |

每个 texture 保存 uuid/sourceUuid、width/height、format/type/mapping、channel/colorspace、flipY、wrapS/T、mag/min filter、anisotropy、generateMipmaps、offset/repeat/center/rotation 和实际 UV matrix。matrixAutoUpdate=false 尊重显式 matrix；非 affine UV matrix 拒绝。各槽独立选择 UV0/UV1，不把 ORM/normal 偷换成 baseColor 的 UV。

CPU pixels 支持 unsigned-byte/float32 的二维 Red/RG/RGB/RGBA DataTexture；直接复制其 TypedArray，按实际 WebGPU upload flipY 处理行顺序，缺通道为 `(0,0,0,1)` 的对应默认分量，不把 RedTexture 扩为灰色。unorm8 转 [0,1]，pixels 是冻结的 RGBA number[]；sRGB RGB 仍按 encoded texel 保存，直到采样前逐 texel 解码，随后 nearest/bilinear 过滤，alpha 不解码。color map 允许 NoColorSpace/LinearSRGB/SRGB；数据槽要求 NoColorSpace。

`SurfaceSampleOptions` 的 uv0/uv1 可覆盖重心插值，frontFacing 默认 true；footprint 默认 magnification，可选 minification，均只采 base mip 的 nearest/linear。Repeat、MirroredRepeat、ClampToEdge 均实现。自定义 mip-chain 显式诊断并拒绝采样；自动 mip-chain/anisotropy/LOD derivatives 只保留元数据，不计算真实 footprint，也不将 LOD0 假称完整 GPU sampler。

alphaMode：transparent=true 为 blend，否则 alphaTest>0 为 mask，否则 opaque；alphaTest 独立保留，所以 blend 也可 cutoff。alpha 保留输入乘积；discarded 包含 side/cutoff，coverage 被 discard 为 0，blend 为 alpha，opaque/mask 通过时为 1。不实现透明排序、混合合成、透射或 shadow。

## 外部解码边界

`SurfaceExtractionOptions.decodedTextureProvider(texture)` 为可选同步函数，返回下列数据或 undefined：

```ts
{
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray | Float32Array;
  channels: 1 | 2 | 3 | 4;
  encoding: "unorm8" | "float32";
  origin: "texture" | "image";
}
```

origin=image 表示原图片行序，core 应用 texture.flipY；origin=texture 表示已经是 GPU texel 行序，不再翻转。编码说明数值存储，不替代 texture.colorSpace；浏览器 provider 必须维持原始通道/color encoding，并处理 ImageBitmap 解码方向、premultiply 和必要 readback，不可让 canvas 偷做颜色转换后仍标原始 sRGB。provider 对每个 texture identity 仅调用一次；core 复制结果。

普通 ImageBitmap/HTMLImageElement 不在 node core 读取，不引入 DOM/canvas/browser global。缺 provider、provider 返回 undefined、half/integer/compressed/array/video/render-target/premultiplied texture 等无法 CPU 解释的像素：保留 texture identity 与 sampler metadata，给 diagnostic，真正采样时显式 `SURFACE_TEXTURE_PIXELS_UNAVAILABLE`。非法 pixel 长度/尺寸/编码或非 finite 值直接 throw；不 invent pixel，不用白色占位冒称读取成功。provider 抛错会传播，调用者需将解码失败显式处理。

## Nonclaims 与拒绝策略

- 不是 GPU shader、BSDF、光照、tracer、GPU packing、BVH、refit、cache/version invalidation、性能或图像质量验收。opaque 数值采样不是完整渲染器。
- NodeMaterial/graph、未知/custom Material/Mesh、getVertexPosition override、onBeforeCompile/onBeforeRender、BatchedMesh、InstancedBufferGeometry、instanced attributes、实例 morph、不支持的 deformation/map/extension 显式 throw，带稳定错误码与相关 uuid。不要删除这些诊断后宣称支持。
- 开发主线已接入正 transmission、IOR 与线性体积衰减，见 `VOLUME.md`；不透射材质接入高光强度及颜色和对应纹理，正透射结合非默认高光或高光纹理仍拒绝。其余活跃 Physical 扩展仍拒绝，包括 clearcoat/sheen/iridescence/thickness/anisotropy/dispersion，以及锁定 r187 的 diffuseRoughness/retroreflectivity。bump/displacement/lightMap/envMap、wireframe、alphaHash/alphaToCoverage/premultipliedAlpha/custom blending/clipping、scene.overrideMaterial 拒绝。正透射要求非金属；有效闭合介质的额外约束由目录检查，不把 alpha 视为折射。
- gltfExtensions 中仅允许已落在真实 Three 属性中的 KHR_texture_transform / KHR_materials_emissive_strength；不解析原 glTF extension 数据。其他 retained extension 拒绝。已经在 loader 阶段丢失的 extension 无法从 Scene 还原，不宣称能检测丢失信息。
- Lights、scene environment/background/fog、非三角形 renderables 不属于 surface，给 diagnostic；不序列化这些内容。不做相机/renderer 层的 LOD、frustum 或 draw-hook 决策。
- 无 tangent 时产生 `SURFACE_NORMAL_FRAME_REFERENCE_ONLY` diagnostic：三角形 transformed-UV 正交基只是明确定义的 CPU reference，不是锁定 Three WebGPU 的屏幕导数 TBN 逐像素等价实现。shear/nonuniform instance 使用精确逆转置，也不假称等价于 Three 所有 backend 的近似 instance normal 路径。无任何 raster pixel parity 声明。
- 未下载或运行 Fox/WaterBottle 浏览器纹理解码/readback。本实验用真实 Three material/DataTexture 与外部 provider fixtures 测契约，不将 fixture 结果当作 GLB/GPU 验收。

## Primary 依据与验证

只读本机锁定 Three **0.187.0**（不修改 junction 指向的依赖）：`objects/Mesh.js`、`objects/SkinnedMesh.js`、`objects/InstancedMesh.js`；`nodes/accessors/Skinning.js`、`Morph.js`、`Normal.js`、`Tangent.js`、`Bitangent.js`、`TangentUtils.js`、`nodes/display/NormalMapNode.js`、`FrontFacingNode.js`；`renderers/common/RenderObject.js` / `Renderer.js` / `RenderList.js`；`textures/Texture.js` / `DataTexture.js`；`renderers/webgpu/utils/WebGPUTextureUtils.js`；`materials/MeshPhysicalMaterial.js`；map/alpha/color/ORM/emissive/normal shader chunks。数学 reference 与 backend 差异如上明示。

2026-11-04 执行：

- `npx tsc --noEmit --pretty false`：全仓检查通过，无需修改根 tsconfig。
- `npx tsx --test tests/surface.test.ts`：29 项专项测试通过；包含旧 extractTriangles 的真实反例：双材质组退化成首材质、UV/颜色被忽略、原生 InstancedMesh 丢实例；其余为 sRGB/filter/ORM/normal/animated skin+morph/immutability/provider/边界负例。
- `npx tsx --test tests/surface.test.ts tests/render.test.ts`：29 项新测试加 5 项既有 render 回归，共 34 项通过。
- `npx prettier --check packages/renderer/src/surface.ts packages/renderer/SURFACE.md tests/surface.test.ts`：仅检查这三个新增文件。

这只是 M3 前置实验；主线集成仍需 M2 发布、独立代码审查与后续 shader/资源同步/真实资产/浏览器 GPU 验收。

允许路径之外的 1090 个原有文件按路径排序、逐路径与文件内容累计 SHA-256，开工/完工相同：`1c0246224f7f75aeff32bd242a3a0709813e567a527a888ce34b8ee091de5389`。没有安装依赖或提交；预先存在的 M2 工作树修改均保留。
