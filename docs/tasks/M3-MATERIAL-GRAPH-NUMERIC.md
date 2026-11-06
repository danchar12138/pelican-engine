# M3 图材质多通道 GPU 数值验证

这是针对图材质的开发增量，不是完整 M3 质量或发布验收。

`npm run probe:m3-material-graph` 独占 GPU，使用两个有不同材质参数的平面、共四个三角形，在同一个真实 WebGPU 材质缓冲上执行两次更新与 dispatch。它对图输出的 opacity、roughness、emissive、alpha coverage 和 mask 丢弃，分别用 CPU 计算预期并逐通道验证；参数同时覆盖正常值以及大于 1／小于 0 的 clamp 边界。GPU 是 NVIDIA 非回退适配器，绝对误差门限为 `5e-5`。

硬件记录：`evidence/m3/development/material-graph-1793889732582/material-graph-gpu.json`；源码指纹 `c873da44e47636d59dc7e1f1d4865cc10d2d9bb735ce5249a4c6b51268f9d1e3`。相关 43 项 CPU 测试及类型检查通过。由于后续源码可能改变，该记录仅证明当次指纹，不自动覆盖当前代码。

本探针不覆盖纹理采样、完整渲染画面、所有 PBR 材质通道、动态时域或发布门禁；现有单独的纹理、三模式和生命周期探针与本报告不可叠加冒充完整验收。完整矩阵与独立 AI/npm 渠道检查仍在 M3 稳定候选集中完成。

后续增量增加 `tools/m3-material-graph-semantic-verifier.ts`：不信任报告自报的 `expected` 和 `passed`，独立重算两轮共 64 个通道的理论值、核对实际读回和冻结源码指纹；7 项篡改／负例测试及类型检查通过。本次由 `tools/m3-material-graph-gpu-probe.ts` 串行运行 NVIDIA 非回退 WebGPU 后生成 `evidence/m3/development/material-graph-semantic-current/material-graph-gpu.json`，源码指纹 `20b246fb628543e968e491d3d34e48fdae860562d1deb9892b94d42289b75787`；离线验证器在当时同一源码下通过，报告 SHA-256 为 `b0a682c8ec6d27ae36b7381a9875bd8db89f293309b59a61be4fa8637bf56f1c`，最大绝对误差 `2.3841857821338408e-8`。该验证器本身不能证明 GPU 执行来源、适配器身份或完整 M3 验收；源码改变后须重新运行探针与验证器。

探针随后接入该语义验证器，语义失败时保留原始读回、另外写入失败记录并返回非零退出码。接入后重新运行的报告及验证结果位于 `evidence/m3/development/material-graph-semantic-integrated/`，源码指纹 `66ed890e73e9fc9021557407fdeaecefac61d60192d6e5555c6d7bb90c68b924`，误差同上。该指纹仅适用于生成时的源码，仍不代表完整验收。
