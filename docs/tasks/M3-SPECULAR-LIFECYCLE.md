# M3 高光纹理生命周期与恢复增量

状态：开发增量，非完整 M3 验收。`tools/specular-textures-game-probe.ts` 的生命周期版本记录初始 raster 的 surface tracer 懒初始化、path 激活、三模式像素/资源观察、快照→step→restore、非法恢复原子拒绝和设备丢失重建。

真实 NVIDIA 非回退 WebGPU 证据：`evidence/m3/development/specular-textures-lifecycle-1793904000/`，源码指纹 `5e3c72b3680d12d03221cbd87779e05185c94d894cdb3f6ebe8fe88e0edbde5e`，所有阶段完成。它只覆盖一个小型公开 GLB 场景，不能替代完整动态场景、资源压力、质量矩阵或正式 M3 门禁。

后续证据 `evidence/m3/development/specular-lifecycle-semantic-1793905600/` 的 12 张截图由 `tools/m3-specular-image-verifier.ts` 独立解码并重新计算像素区域，与报告和源码指纹 `ae8bd025b394bfc7cfc2b0dbbcdf555d4817f2e652612159914d34f16fa06678` 核对通过。验证器的篡改、黑图、错误模式、路径逃逸及有界解压负例共 6 项通过；离线像素一致性不能证明 GPU 来源、生命周期行为或正式验收。后续测试源改动使该指纹不再代表当前源码。

`tools/m3-specular-lifecycle-verifier.ts` 进一步核查快照 tick、拒绝诊断、设备恢复计数／事件、资源及模型记录，并重用截图语义检查。其在 `specular-adam7-semantic-1793908500/` 上通过；报告未记录每张截图对应的实际 tick/mode/runtime records，因此无法证明这些同阶段关系，离线工具也不能证明硬件来源。两项输出始终为 `formalMilestoneAccepted:false`、`releaseAllowed:false`。

后续探针为每张截图记录并断言采样前后的实际 tick、mode、runtime records，也记录快照恢复及非法恢复前后的这些状态；离线验证器对此交叉核对并新增伪造状态负例。真实 NVIDIA 非回退 WebGPU 结果与离线核验分别保存在 `evidence/m3/development/specular-adam7-state-1793910000/specular-textures-game.json` 和 `lifecycle-verification.json`，源码指纹 `e8454e8e65fdd646225b3da139f0bd78cf2380deab2f619b33302393793bf1d1`。报告数据仍未独立认证执行源或硬件，不能替代正式 M3 验收。
