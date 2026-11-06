# M3 后端恢复证据切片

状态：开发验证，不是完整 M3 接受或发布。`tools/backend-probe.ts` 记录 WebGPU API 缺失、空 adapter 和 adapter 拒绝三种 WebGL2 回退，完整模式命令回复、恢复前后状态、逐次资源重载和清理；WebGPU 恢复探针记录 path/hybrid/raster 重建设备前后状态、适配器、资源和恢复后 path 画面。

`evidence/m3/development/backend-evidence-1793908865106/` 是历史 NVIDIA 非回退 WebGPU 和 ANGLE WebGL2 本机浏览器结果，探针起止源码指纹均为 `11ea58aa0aebd2ac3ce08c6d3492610e01e74e7de177efb9901d813605e279a4`。当时的 verifier 只接受 missing-api WebGL 和 WebGPU 恢复一致性切片；现行规则要求更多观测，旧报告不能直接通过。

当前 verifier 分别核验 missing-api、null-adapter、rejected-adapter 的状态、截图、恢复和清理，并检查 adapter 请求计数；两后端不可用时要求记录实际启动错误、未就绪状态及 WebGL2 请求次数。真实 NVIDIA WebGPU 与 ANGLE WebGL2 执行记录在 `evidence/m3/development/backend-matrix-1793936208480/`，起止源码指纹 `2ed77e0d7c5dc874fa512fdb4cd1d76aba8d7b29dfbf33bda7351fd35ff91ac7`，离线一致性检查通过。报告和注入计数本身不能独立认证执行来源或全部 compute 拒绝细节；`formalMilestoneAccepted` 和 `releaseAllowed` 仍固定为 false，不能视为完整 M3 验收。

首次独立核验因同一适配器 `features` 枚举顺序变化而拒绝，原始尝试保存在 `backend-evidence-order-failure-1793908538862/`。验证规则现按集合比较，并继续拒绝缺项、重复项和回退适配器；新一轮真实设备结果通过。CPU 正负例覆盖旧报告缺失、状态/截图/错误码篡改、适配器及源码漂移。

验证器随后增加报告和截图的文件大小、路径与有界解压检查；再次执行的真实设备结果 `evidence/m3/development/backend-evidence-1793909160098/` 及离线切片核验通过，探针前后源码指纹均为 `42446a06ba2ada140372b76b149f1528da451ac9d61486ecfc11459ddfcb9f52`。该结果仍不认证 GPU 来源，不授权完整里程碑或发布。
