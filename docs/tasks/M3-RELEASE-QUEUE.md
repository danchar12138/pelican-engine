# M3 发布收敛清单

> 当前说明：本文件下方包含历史阶段和当时的旧发布记录，不是当前操作步骤。当前只使用 `main` 单工作树；最近公开版本是 `0.3.35`，后续本地改动尚未发布。npm 通过 main 推送的 OIDC 工作流尝试发布，已存在的版本不能覆盖；小改动在本地积累，较大批次再推送。稀疏 GLB 现有交错底座展开，并在本地增加不需要列填充的整数矩阵展开；需要列填充的矩阵仍不支持，新增行为尚未运行验证。旧本机快照目录已删除，未完整证明其中所有候选均已合入；不要再依赖这些路径。D50/D58 禁止运行或编写测试，历史验证记录不证明当前源码通过。

> 本机历史 Git 引用现收拢为 `refs/pelican-archive/consolidated`；下文旧引用路径仅反映当时状态。原始提交和未合并范围见 [开发状态](../STATUS.md)。该归档不随普通推送自动发布。

## 2026-11-06 单线收敛接续

用户要求发布 M3 后只保留单线串行开发。GitHub 已创建 `v0.3.0-m3.0` compile-only/unverified 预发布，提交 `629e880a9ab4664ee799e94293ab4dea1df11645`；这不是 M3 正式验收或完整首发。npm Actions 工作流 `42230390535` 三次直接发布均失败：首次因 2FA 权限，第二次因令牌仅允许 staging 而返回 `E_STAGE_REQUIRED`，第三次返回 `EOTP`，要求一次性双重验证。npm 公开发布未成功。

用户要求自动提交 staged package、本人手动审核（D52）。工作流已切换为 `npm stage publish`，支持按已有标签手动触发。Actions 运行 `42237844464` 将 `pelican-engine@0.3.0-m3.0` 提交到 `next`，stage ID `6fe20eb8-97f4-48d7-9419-bea962e213c8`；等待用户以 2FA 审核。Staged 不等于 npm 公开发布；此前运行 `42237428010` 因 PowerShell 单引号导致路径未展开而失败，已修正。

现仅登记 `main` 主工作树和开发分支。原有工作树已移除或作为本机快照注销，独有提交以 `refs/pelican-archive/worktrees/` 保留；未合入差异及原始快照保存在 `.pelican/consolidated-worktrees/` 和 `.pelican/worktree-snapshots/`。它们未全部归类或合入，不代表功能完成；不得跟随 junction 删除或丢弃独有成果。主树中历史 `evidence/m3/` 至 `evidence/m6/` 仍未跟踪，保留在本机，未随本次提交上传。归档路径是本机辅助记录，其他环境可能不存在。

本轮 `npm run typecheck`、M3 示例构建和 npm 分发构建打包成功；未运行测试、浏览器、GPU、性能、smoke 或其他行为验证。本记录不表明 npm 或 GitHub Release 已发布，实际状态以远端结果为准。D50 覆盖下文任何要求执行验证的历史步骤；仅允许运行编译/构建及其必要步骤。

状态：开发中，未正式验收。D50 允许明确标为未验证的 M3 预发布，不能称为完整 M3 验收或完整首发。此清单按 `DECISIONS.md`、`M3.md` 和 `M3-ACCEPTANCE-CONTRACT.md` 组织已有要求，不减少首发范围。旧报告仅证明其记录的源码和场景，不能直接转记为当前源码通过。

## 当前优先顺序

收敛约束：M3 GitHub 预发布已创建，但 npm 发布和完整 M3 能力仍有缺口；当前按 D50 只编译/构建，按 D51 在主线串行推进。历史候选保留在本机归档，按依赖逐项整合，不创建新的隔离工作树。

历史候选：`m4-rope-public-codex` 的双向法向冲量候选尚未接入 Host 和事务；`m5-world-sdk-codex-20261106` 的受限 CPU terrain 尚未接入实际渲染、物理或导航，命令批次也非原子事务；`m5-nav-batch-codex-20261106` 有导航批量更新候选。三者位于本机原样快照，不是活动工作树；合入前核对独有文件与当前主树。M5 world 原始 `.git` 指向另一候选，恢复时须参考归档说明。

1. **候选修复**：当前零底座 sparse GLB 已通过 CPU、优化器、WebGL2 软件浏览器及真实 WebGPU 光栅开发验证（`evidence/m3/development/sparse-raster-05824294635f/`）。同机临时项目的 `dist` 在静态子路径完成真实 WebGPU 冷启动、刷新和开发控制剔除检查，见 `evidence/m3/development/sparse-static-1793937726355/`；其截图无法单独证明外观相同的两模型已通过按键切换，且探针指纹不是构建输入证明。交错底座和 sparse 矩阵在 Three.js 加载器正确处理前明确拒绝。完成 M3 当前已知阻塞，避免继续增加与发布无关的特性。
2. **冻结前检查**：整理当前未提交改动及来源，确认许可证、版本、公开 API、包内容与仓库/ZIP/npm 行为一致。执行 `npm run typecheck`、`npm test` 及默认跳过的硬件项；记录跳过、失败、命令、版本和源码指纹。局部修改只重跑受影响部分；冻结时再完整复验。
3. **真实渲染与回退**：使用冻结源码按 `M3-ACCEPTANCE-CONTRACT.md` 验证静态/动态场景的 raster、hybrid、path，图像、材质、变形、时域、资源和设备恢复；单独完成 WebGL2 后端/错误码/上下文丢失矩阵。性能记录实际负载和可用计时，不设固定 FPS 拦截。
4. **分发与 AI**：在无仓库的 Windows 环境验证 npm 包、离线开发、构建、静态部署、许可证和版本错误；验证 ZIP 相同公开接口；由无研发上下文的独立 AI 完成新渲染任务与诊断修复。发布前本地 tarball 不等于公开 registry，正式发布后再验证 registry 的实际内容和安装。
5. **正式验收与发布**：实现语义 verifier 与对应负例，补齐 M3 release profile 和负例；不能只靠报告自称 passed 或结构预检解锁。全部证据绑定同一冻结源码后，按同一节点中文 Conventional Commit、推送、标签、GitHub Release 和 CI npm 发布；失败保留原因，不提前发布。

## 已有基础与未闭合边界

- 独立 AI 从同一 `17efc417...` 源码构建的本地 npm 包创建新游戏，自行修复静态声明和类型错误；主线在真实 NVIDIA WebGPU 验证开发与静态构建各一次得分和重开，并反馈状态栏与游戏 UI 重叠，游戏 AI 修复后实测通过。证据见 `evidence/m3/development/independent-signal-catcher-31839e51/`。首次 npm 安装误选 `C:\Users\60459` 父项目并报告改动一个包，原状态未知，未回滚；此真实问题及 AI 闭环反馈必须保留。任务未执行 OS 级隔离、全新系统、公开 registry 或完整玩法矩阵，不能单凭它授权发布。
- 使用 `execute:m3` 在中文路径的隔离 ZIP 解压副本上串行执行测试、分发测试、完整 M3 开发探针、后端探针、npm 打包与 GPU smoke；源码前后指纹均为 `17efc417dfbb6756611feb7815501e7c6f8d1fb30ff3fe0140274191bd25cac8`。测试 1770 通过、4 跳过；M3 探针 17 项通过；后端和本地 tarball 安装的 NVIDIA WebGPU 三模式、WebGL2 回退 smoke 通过。简要报告与命令日志在 `.pelican/m3-execution-results/zip-17efc417-1793967439548/`，原始像素和截图在系统临时目录，可能被清理。此执行不覆盖无辅助独立 AI、完整独立质量矩阵或公开 registry，不能授权正式发布。
- 首次隔离执行因三个测试文件依赖 ZIP 排除的历史 evidence 而失败（1733 通过、37 失败、4 跳过）；现改用小型专用或合成 fixtures，不依赖历史目录。失败日志保存在 `.pelican/m3-execution-failures/zip-missing-fixtures-1793966033849/`；修复后完整 ZIP 中相关 41 项测试及上述执行通过。合成测试输入不是 GPU 证据。
- 发布打包现将已采集的可执行源码字节与验收指纹对照，并在检查结束及打包提交前重新核对源码，避免采集过程中混入不同版本；`tests/release.test.ts` 44 项及类型检查通过。这不是 M3 verifier，也未开放 M3 profile。
- 当前源码 `e59d9d0ef6b998331f511426eb9a1c9c464fd2b867b34f7283740674686efec3` 的完整 `npm run probe:m3` 17 项开发检查在 `.pelican/m3-probes/1793964206959/` 通过，包含新像素检查，源码前后指纹一致；它不是完整 M3 正式验收或发布授权。
- 静态降噪线性像素现与显式源码指纹绑定并在独立校验前后重算；当前源码 `e59d9d0ef6b998331f511426eb9a1c9c464fd2b867b34f7283740674686efec3` 的真实 GPU 结果在 `.pelican/m3-probes/1793962528978/`。这只证明该静态场景的数值与源码一致，不证明 GPU 来源或完整质量，不能开放发布。
- 静态 gallery 降噪探针现保存 320×180 原始、滤波、参考线性浮点像素，再由独立检查器重新计算全部像素的压缩辐射 MSE。真实 GPU 成功记录在 `.pelican/m3-probes/1793962009772/`：原始 MSE 约 0.002927，滤波后约 0.002132，源码指纹 `31501621898ada83dd65f136fbad0afa47e66dd1891fe9c889aadd948cf6fb6a`；六项合成反例与四项选择测试通过。第一次 `.pelican/m3-probes/1793961901853/` 因浏览器回调 `__name` 未定义失败，已保留且随后修复。256 样本参考仍来自同一积分器，不是独立物理真值或完整质量矩阵；离线检查不能证明 GPU 执行来源。
- 真实 GLB 平移、旋转、缩放和 morph 动画及公开动画服务通过 CPU 检查；现有合成 mixer 材质轨道问题尚未证明可由支持的 GLB 加载路径触发。实际使用 `KHR_animation_pointer` 动画通道的模型现在明确返回 `TC_MODEL_EXTENSION_UNSUPPORTED`，避免可选通道被 loader 静默忽略；仅声明未使用的可选扩展不因此拒绝。相关模型测试 61 通过、5 跳过，类型检查通过；四项合成材质轨道缺陷仍保留，不能宣称材质指针动画受支持。
- 材质图数值组件已接入 `npm run probe:m3 -- --checks material-graph-numeric`，先保存原始 GPU 读回，再独立核对两轮数据和源码指纹；主树真实 NVIDIA 非回退 WebGPU 结果在 `.pelican/m3-probes/1793961082179/`，源码 `d288629e3d318196a60175116688fb91981ef143e637d5f01a9d81a9277214ae`。相关组件测试 14 项通过；该单项不证明完整渲染、硬件来源或正式 M3 验收。
- 模型恢复的暂存 mixer 可能写入共享材质；异常回滚现先释放未提交实例，再恢复保存的属性值。新增模型/材质/浏览器契约测试 81 通过、5 跳过，类型检查通过。四个跳过项是明确的未修复 CPU 复现：注入 Three.js 材质属性动画轨道时，多个 mixer 的原始值与 stop 语义互相覆盖，显式启用 `MODEL_RESTORE_REPRO=1` 后 4 项均失败。该复现并未证明当前 glTF 加载路径支持材质动画扩展；解决前不得声称共享材质动画已正确。另一个跳过项为需启用浏览器的模型测试。
- 当前开发源码 `8cbf65f2b06814bd9e65c4f777eb88c9eab90bc87dfed3ac04b2b28aebfea252` 的 ZIP 解压副本在中文路径离线安装依赖、打包 npm，并在无仓库的临时游戏目录通过实际 NVIDIA WebGPU 三模式、WebGL2 回退、构建、错误码和静态部署 smoke；报告和截图见 `evidence/m3/development/zip-npm-webgpu-179395/`。这是同机本地缓存与 tarball，不是全新 Windows、公开 registry 或完整验收。
- 模型恢复现会暂存新增实例、保存活动动画快照和轨道姿态，普通动画异常下尝试回滚并清理未提交实例；同定义恢复保留外层和骨骼引用。主树模型/材质/浏览器契约/Host 测试 117 通过、1 项默认跳过，类型检查通过。回滚再次失败时明确报 `TC_MODEL_RESTORE_ROLLBACK_FAILED`，提交阶段失败报 `TC_MODEL_RESTORE_COMMIT_FAILED` 且可能部分更新；清理自身异常和全部轨道类型未全面验证，不能宣称任何异常均原子回滚。
- 恢复改动后的同 ID 模型 A/B 三模式 WebGPU 探针见 `.pelican/prefab-model-webgpu-1793959248333/report.json`，执行前后源码指纹 `8cbf65f2b06814bd9e65c4f777eb88c9eab90bc87dfed3ac04b2b28aebfea252` 一致；同一 GLB 材质槽替换及 A/B 快照恢复通过，不代表全部模型类型或正式验收。
- 模型 A/B 同 ID 替换及快照恢复的三模式 WebGPU 场景已纳入 `examples/prefab-model-probe` 和 `tools/prefab-model-webgpu-probe.ts`。主树 `.pelican/prefab-model-webgpu-1793958946985/report.json` 三模式通过，执行前后源码指纹 `1816c5b098bac7ec032db4528d2720d45a23772435b69231de0aca637392fa3a` 一致；前一次 `.pelican/prefab-model-webgpu-1793958717403/` raster 页面启动超时，整体失败并保留。更早独立工作树的截图、快照、报告和两次失败保存在 `evidence/m3/development/prefab-model-webgpu-1793957474879/`。该场景仅覆盖同一 GLB 的材质槽替换，不是所有模型类型或正式验收。
- 同 ID 实体切换模型的 `TC_MODEL_DEFINITION_CONFLICT` 已修复：模型实例先暂存，快照预检使用候选定义而不改活动登记。真实 GLB 的 CPU 回归覆盖 A/B 切换、旧快照恢复、无效快照与 World 不匹配不改变活动实例及共享几何；浏览器契约、模型和 Host 测试 91 通过、1 项默认跳过，单独启用模型浏览器文件 30 项通过、零跳过，类型检查通过。尚未实测三模式下 A/B 切换画面，也未对提交阶段所有底层异常做故障注入，不能视为完整 M3 验收。
- 父子实体同时删除时原先会对孩子几何调用两次 dispose；已在浏览器视图同步时先分离被移除视图的受跟踪后代，新增 CPU 反例修复前复现 `2 !== 1`，修复后相关浏览器契约与世界测试 102 项、类型检查通过。当前源码的完整 GPU 矩阵仍需复验。
- 同帧替换父 prefab 时，浏览器同步现先分离仍存活子节点，避免释放其几何；主树浏览器契约与世界状态测试 101 项通过，类型检查通过。独立工作树的公开 SDK 父子替换场景在 NVIDIA WebGPU 的三模式运行，原始状态和截图保存在 `evidence/m3/development/parent-child-webgpu-1793955267277/`。图像全帧差异可能包含噪声、光照和计数器变化，资源释放断言来自 CPU 回归；此工作树与主树指纹不同，不能当作当前源码完整验收。
- 开发源码 `80a6b67838ee91c43a6424445b63bcb7649c8d5933a54752541faaa9de826141` 的 `npm run probe:m3` 16 项于本机通过，报告在 `.pelican/m3-probes/1793952264824/development-report.json`；源码前后指纹一致。范围包括真实渲染数值、时域、设备恢复、1080p 观察和静态部署，但报告明确不是正式验收，不能替代完整矩阵、独立 AI、分发及发布 profile。
- 同一源码执行开启 GPU 和浏览器选项的 `npm test`，1733 通过、0 失败、0 跳过，见 `.pelican/m3-probes/development-all-1793951813273/`；与上面的探针属于不同执行，不应将数量相加解释为验收覆盖。
- 同一源码的后端开发探针见 `.pelican/backend-probes/1793952872296/report.json`：三个 WebGPU 不可用分支在 NVIDIA WebGL2 下通过恢复与错误检查，WebGPU 设备恢复通过，执行前后指纹一致；不替代完整正式后端验收。
- 基于该源码的本机临时快照离线打包与空目录 smoke 已通过，并用相同游戏输入在 npm 包与仓库分别 check/build；原始 smoke 位于系统临时目录 `pelican-ai-audit-c473016bc2074523b07df6d9486ec173/.pelican/npm/artifacts/smoke.json`，候选包 SHA-256 为 `a34c7bee67a26dab158c487a8f7dd72887e1b07b5b3f1e4ff6678fe63509cf73`。临时目录可能被清理，且本次没有 GPU、全新 Windows 或公开 registry 验证，不能作为正式验收。
- 一次独立 AI 使用同一本地包编写新游戏并修复 `TC_STATIC_SIDE_EFFECT`，主线在 NVIDIA WebGPU 实测开发模式收集全部目标、胜利和重开；静态 dist 冷启动、收集一个目标和重开且无开发控制。记录见 `evidence/m3/development/independent-npm-beacon-179395/`。期间主线提供了 Windows 补丁工具提示，未验证生产模式完整胜利、全新系统或公开 registry，不能作为无辅助正式独立验收。
- 已有三模式、小型材质、纹理、计算和设备恢复开发证据；它们不覆盖完整矩阵或当前冻结源码。
- 历史源码 `3448131cf2ad18cedbc2226924b37d4494382078ac1645e944550a958eaf3498` 的 16 项完整开发探针已通过，见 `evidence/m3/development/full-probe-1793936704266/`；源码之后已有修改，这不是当前源码验证、冻结验收或正式发布授权。
- 后续公开 SDK 动态游戏在真实非回退 NVIDIA WebGPU 的 raster/path/hybrid 各执行物体、相机、动画、删除、重生、材质及灯光变化，共 21 个场景通过；首次狐狸被遮挡导致的失败及调整场景后的状态/截图保存在 `evidence/m3/development/dynamic-sdk-1793943920267/`，源码指纹 `cf43cec0269a58f497ba6065b20b5cd1eca4a0d38bc6c013d8781d49107bee12`。动画含静止噪声对照和播放时间检查，但整图差异不是物理真值，也不覆盖完整动态矩阵。
- 同一源码的 `npm test` 本轮为 1711 通过、0 失败、5 项默认跳过；随后独占 GPU 启用五项开关，相关五个测试文件合计 74 通过、0 失败、0 跳过（与全量计数重叠，不可相加）。本次终端结果未形成冻结前后完整独立验收日志，不替代正式验证。
- 已有 WebGL2 后端探针及部分生命周期语义 verifier；缺少完整后端故障矩阵与正式验收组合。
- 已有本机离线 npm 安装、构建和真实 WebGPU 游戏；缺少全新 Windows、公开 registry 和独立 AI 的正式验证。
- 当前开发快照 ZIP 在 Windows 中文临时路径解压后，以本机缓存离线安装、类型检查、编译和构建 M3 示例；静态子路径完成三模式键盘切换与刷新，见 `evidence/m3/development/zip-extracted-20863fd593c7/`。这是未提交工作树的开发证据，未独立记录 GPU adapter，也不是全新系统或完整跨渠道验收。
- 一次开发阶段独立 AI 游戏任务使用旧本地候选包 `790d8cbf7f1cd9c7cbcc0d162d499df721a7bac7ef6fbc3974b6e2896483cf80`，以只读公开文档编写游戏并根据主线的真实按键失败反馈修复。主线随后在真实 WebGPU 的开发模式完成收集、胜利、重开，生产静态子路径验证实际移动、刷新和控制接口剔除；记录见 `evidence/m3/development/independent-beacon-1793938993936/`。任务在同机执行，未对代理读取范围做操作系统级隔离，包和当前源码亦已发生变化，因此不是冻结、全新 Windows 或公开 registry 的正式独立验收。
- 上述任务暴露两个 AI 上手问题：npm 在存在祖先项目时可能把安装写到父目录，且包内文档未说明字母绑定使用 `KeyboardEvent.key`。现已补充文档、推荐显式 `npm --prefix .`，并用嵌套目录真实 npm 负例测试验证不会改写父项目。任务首次安装确实改写了本机用户目录的 npm 项目；缺少原始状态，未自动回滚。后续正式验收需使用干净环境和更新后的包。
- `tools/m3-acceptance-audit.ts` 与 `tools/m3-acceptance-contract.ts` 是失败关闭的辅助检查，不是正式 verifier；`tools/release.ts` 当前没有 M3 profile。
- 当前源码指纹检查已扩展至 JS/MJS/CJS/JSX/TSX/MTS/CTS、CSS、WASM 和 YAML，并使用不依赖本机区域设置的路径顺序；语义验证器从自身可信安装导入同一指纹实现，不执行被检查源码目录内的代码。历史报告保留原始指纹，不能改写为新算法结果；源码冻结后需重新采集并绑定证据。指纹仍明确排除文档、证据、本地缓存及生成产物，不是整个目录或任意凭据的完整性证明。
- npm CI 已准备发布后公开 registry 字节对照和精确版本安装，再离线运行开发/构建/部署 smoke；本地 tarball 安装属于发布前检查。两者先后不能倒置，且只有真实发布后才能验证 registry 分支；合成负例不证明 registry 已完成。首次发布若后置验证失败，需保留已发布状态并诊断，不能盲目重复发布。
- M4 Rapier 缺陷由独立工作线处理；不得将其局部实验作为 M3 或 M4 已验收的证据。跨系统功能若属于 M3 当前正式矩阵，仍须按契约验证。

执行顺序以尽快完成 M3 为目标，但具体能力、真实硬件、生命周期及独立使用证据不可用占位或放宽断言替代。所有状态以当前源码、原始报告与远端实际发布为准。
