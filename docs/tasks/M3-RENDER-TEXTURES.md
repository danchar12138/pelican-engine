# M3 受管理纹理直接渲染与资产导入

完成 CAP-17 已确认的动态纹理使用链，不替代完整 M3 验收。

状态：受影响验证通过，尚未提交或发布。证据 `evidence/m3/development/render-textures-1793886434977/summary.json`，源码指纹 `741a9f44ab1cc10d78a33386fa63736276906ae31985f37549c9cd84ff7f9bb3`。

## 冻结接口与行为

- defineMaterial/definePostProcess 新增 textures: MaterialTextureInput[]；槽为 name/filter?/wrapU?/wrapV?/texture?/width?/height?，过滤和寻址默认沿用 compute（linear/clamp）。texture 是初始受管理纹理 ID，尺寸约束可选。
- render.textures 与 render.effects.textures 提供 bind/unbind/state，材质与后处理 ID 独立；类型化纹理句柄不允许冒充缓冲。四类引用（材质/后处理×缓冲/纹理）共同发布源 pin，任何一类不能释放另一类仍引用的资源。
- sampleTexture 的 texture 字符串可引用声明纹理槽；图 IR.textureSlots 只记录输出可达槽。槽名与静态资产 ID 冲突明确拒绝，避免歧义。原资产采样接口保持原语义。
- 顶点、片元、后处理均可采样管理纹理；非有限渲染 UV 明确返回零，compute 仍以 TC_COMPUTE_TEXTURE_COORD 失败。CPU 顶点镜像与 GPU 使用相同过滤/寻址/行顺序，维护 bounds/BVH，不修改物理 collider。
- Three 侧持有独立 rgba32float 纹理，以 textureLoad 节点显式做过滤/寻址。更新只从 executor.textureResident 做 GPU→GPU texture copy；不能上传 CPU 计算结果。尺寸变化重建目标、绑定和维度 uniform，稳定版本不重复复制。
- native tracer 将纹理 GPU packed mirror 复制到已有材料表的 vec4 范围，生成二维采样 helper；不新增绑定槽、不打包 CPU 计算值。版本变化失效积分/时域。顶点 CPU 采样允许使用镜像进行几何校验，不能当作呈现上传路线。
- 纹理绑定快照单独存逻辑 ID/尺寸/格式；restore 在修改前同时检查 compute peer 的纹理种类/尺寸/值，四类 pin 原子发布。设备/内容重建重新创建渲染目标，释放时不销毁借用 executor 对象。
- ComputeTextureInput 为数据或资产的互斥联合：{id,width,height,data?} 或 {id,asset}。公开 createTexture 同样接受资产 ID/AssetDefinition；只能导入已声明并加载的纹理，不暴露底层纹理对象。浏览器私有 provider 将图片像素按源 colorSpace 解码到线性 rgba32float，保持上传行顺序，CPU 所有者继续验证和分离数据。快照保存纹理值，不依赖恢复时在线资产服务。
- WebGL2 活跃管理纹理槽明确 TC_RENDER_TEXTURE_CAPABILITY，不伪装 compute 或降低画质。静态资产纹理仍按原支持路径运行。

## 并行范围和验证

主线 SDK/IR/private contracts、render-settings 四类 pins/快照、compute 资产导入、Three bridge/TSL、browser、示例与 GPU 集成。runtime worktree 只写新 render-textures owner/测试；compiler worktree 只写 normalize/graph/专属测试；native worktree 只写 material-graphs/surface-tracer/vertex-graphs 和专属测试。CPU sampler由主线提供，签名 sampleManagedTexture(descriptor, uv, sampler) => Vec4，模块 renderer/src/managed-texture-sampling.ts。

按 D49 集中受影响测试和类型检查，一条 320×240 GPU 链路覆盖动态纹理实际像素、顶点几何、三模式、资产导入、版本/重绑/恢复/释放与能力错误。旧分发证据不冒充当前 API 通过，稳定候选再重建 npm/渠道验收。

## 结果与边界

- 455 项受影响测试通过、零跳过，统一类型检查通过。包含独立的纹理槽 owner、编译、native/顶点采样、联合 pin/原子恢复、资产 sRGB 解码、Three 桥分配/尺寸变化/清理和既有计算回归。
- 320×240 NVIDIA 非回退 WebGPU 场景在 raster/path/hybrid 中，分别以 CPU 纹理采样参考验证两个材质像素（容差 4 字节）及两个后处理像素（容差 3 字节）；三模式材质最大观测误差 1 字节。计算纹理更新使顶点包围体中心从约 `[0.013,0.022,0.031]` 变化至 `[0.031,0.034,0.037]`。
- 持续 9 次计算提交时 textureUploads 始终为 1 次初始检查点；Three 两槽与 native 一个槽均报告 CPU 结果上传为零。资产的 sRGB 128/64 灰度分别转换为线性约 0.2158605/0.0512695，重绑后后处理像素也与参考一致。
- 四类槽联合 pin、重绑、非法快照原子拒绝、真实设备销毁重建、异步回放、WebGL2 `TC_RENDER_TEXTURE_CAPABILITY` 和最终零资源通过。保留两次硬件失败报告：动态槽误当静态资产、初始检查点纹理缺 COPY_SRC；修复后复测通过。
- GPU 结果仍复制而非零复制，计算仍逐节点读回。全部高级材质／兼容故障矩阵、当前新接口的 npm 安装和独立 AI 渠道验收留在稳定里程碑候选，不用旧包证据冒充通过。
