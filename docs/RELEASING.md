# M0 打包与里程碑 Release 规则

本页描述已实现的本地检查与打包，以及由主线研发 AI 执行的发布步骤。**打包器不调用 Git、GitHub API 或 `gh`，不创建远程仓库、提交、标签或 Release。**

用户已授权每个里程碑验收后自动发布 GitHub Release。主线研发 AI 在证据门禁通过后直接执行既有授权，不增加人工审批步骤。公开仓库为 `danchar12138/threecat`。

## 提交、推送和 Release 使用同一交付节点

用户补充确认：每个里程碑在验收通过后，统一执行 **提交 → 推送 → 标记对应版本 → 发布 Release → 核对远程产物**。不在研发过程中提前零散提交/推送，也不把本地完成、远程提交和 Release 当作三个不一致的交付节点。发布标签必须指向本节点已经推送的验收源码提交。

提交消息采用 Conventional Commits 结构，类型和 scope 使用通用标识，描述、正文与重大变更说明采用准确中文：

```text
feat(m0): 完成首个里程碑风险原型与自动验收

- 实现声明编译、公开 SDK 和可定位诊断
- 验证真实 WebGPU 动态渲染、交互模拟及世界修改
- 完成独立 AI 使用、静态部署和可重复发布打包
- 记录原型限制，未将后续完整能力声明为完成
```

按变更实际含义选择 `feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci` 或 `chore`；不要把所有工作都写成 update。需要破坏性变更时使用 `!` 和明确的 `BREAKING CHANGE:` 中文说明，不捏造关联 issue。

外部服务失败时记录当前阶段，检查提交/推送/Release 是否已成功，再从未完成阶段恢复；不要重复创建、强推、重写已发布提交或覆盖既有标签。只有远程 Release 及附件验证结束，才报告该节点完整交付。

## 当前版本与范围

- 引擎版本：`0.0.1-m0.0`；标签：`v0.0.1-m0.0`。
- 里程碑：`M0`；验收范围：`risk-prototypes`。
- JSON 协议统一使用 `protocolVersion: "0.1.0"`，与引擎版本分别管理。
- 本版本必须标记 **prerelease**，标题和说明明确它是四条高风险技术原型，**不是完整引擎、完整首发或所有后续能力已完成**。
- 软件 BVH 在真实 GPU 上运行不等于调用硬件专用光追单元；不据 M0 小场景宣称所有主流显卡原生 1080p/60 达标。
- 后续里程碑沿用“先验收、再打包、自动发布”的规则，但需按当时版本与退出条件更新检查实现；当前工具只接受 M0，不自动替未来里程碑背书。

与 [ROADMAP.md](ROADMAP.md) 的 M0 退出条件一致：四条原型、实际环境与测量、可重跑证据、风险和技术决策。阶段性可用不等于 M1—M8 完成。

## 实际入口

Windows 开发环境使用 Node 24、仓库锁定的 TypeScript 6.0.3 和本地依赖。先在引擎根目录按仓库工作流准备依赖，再执行：

```powershell
npm run release:check
npm run release:pack
```

两个脚本分别执行 `tsx tools/release.ts check` 与 `tsx tools/release.ts pack`。可在任意工作目录指定完整的本地引擎路径；参数直接传递，不拼接 shell 命令：

```powershell
node --import tsx "C:\项目 空格\threecat\tools\release.ts" check --root "C:\项目 空格\threecat"
node --import tsx "C:\项目 空格\threecat\tools\release.ts" pack --root "C:\项目 空格\threecat"
```

未指定 `--root` 时，根目录按工具文件位置解析，不依赖当前终端目录。没有 `.git` 的 ZIP 解压目录也能运行。首次获取依赖允许联网；Git/GitHub 只在主线实际发布时需要，不是打包前提。

成功退出码为 `0`，失败为 `1`。标准输出为一个 JSON envelope：`protocolVersion`、`taskId: "M0-release"`、`status`、`diagnostics`、`artifacts`、`data`。`diagnostics` 包含稳定 `code`、`severity`、`message` 和 `remediation`；不输出原始系统异常或绝对路径。库接口为：

```ts
import { checkRelease, packRelease } from './tools/release.ts';
await checkRelease({ projectRoot: engineDirectory });
await packRelease({ projectRoot: engineDirectory });
```

记录了 sourceIdentity 的验收还必须与当前可执行源码和锁文件哈希相符，源码变化后需要重新验收，不能复用旧报告。`check` 只读；`pack` 在重新通过同一门禁后写入 `release/`。它们不运行构建或伪造证据；主线必须先完成真实验证与构建。

## 验收输入契约

必需文件 `evidence/m0/acceptance.json` 由**主线**汇总真实执行结果后写入。最小结构如下，文件名仅演示记录方式，必须替换为实际产出的证据路径：

```json
{
  "milestone": "M0",
  "status": "passed",
  "scope": "risk-prototypes",
  "checks": [
    { "id": "environment", "status": "passed", "evidence": ["evidence/m0/environment.json"] },
    { "id": "compiler", "status": "passed", "evidence": ["evidence/m0/compiler.json"] },
    { "id": "render", "status": "passed", "evidence": ["evidence/m0/render.json"] },
    { "id": "simulation", "status": "passed", "evidence": ["evidence/m0/simulation.json"] },
    { "id": "ai-workflow", "status": "passed", "evidence": ["evidence/m0/ai-workflow.json"] },
    { "id": "typecheck", "status": "passed", "evidence": ["evidence/m0/typecheck.json"] },
    { "id": "unit-tests", "status": "passed", "evidence": ["evidence/m0/unit-tests.json"] },
    { "id": "deploy", "status": "passed", "evidence": ["evidence/m0/deploy.json"] }
  ],
  "limitations": ["写入本次实际限制、未覆盖组合、画质与性能测量边界。"]
}
```

推荐增加 `protocolVersion: "0.1.0"` 与 `engineVersion: "0.0.1-m0.0"`；为兼容主线最小结构，它们允许省略，但出现时必须匹配。`package.json`、`engine.manifest.json`、`package-lock.json` 及锁文件根包的版本必须一致；引擎标识必须属于 M0，MIT 声明必须匹配。

标准字段为 `checks[].evidence`；兼容早期约定的 `checks[].files`，两者同时存在时必须一致。输出摘要统一使用 `evidence`。每项 `evidence` 必须为非空数组，引用真实存在、非空、会被收集到源码或 dist 包的文件。路径相对于引擎根目录，支持中文与空格，禁止绝对路径、盘符相对路径、UNC、`..`、空路径段、链接外逃与自引验收文件。八个必需 ID 缺一不可，不接受重复 ID；附加项也必须通过。缺失、`failed`、`skipped`、`pending` 均失败，不能把跳过当通过。

渲染项还必须引用至少一个 JSON 报告，在**同一份报告**内记录：

- `backend: "WebGPUBackend"` 或 `backend: "webgpu"`；字段可以嵌套。
- 非空的 adapter 身份信息，例如 `adapter.vendor` / `description` / `device` / `architecture`。
- 明确的 `isFallbackAdapter: false`。

这是报告字段形状说明，不是可以复制作为实测证据的样本。报告必须来自真实浏览器执行，包含具体测试、像素/场景变化检查、错误与测量上下文，主线负责判断这些测试是否满足 M0。打包器检查声明及文件完整性，不能证明任意手写报告的真实性。

没有实际 GPU 时可以继续 CPU 开发，**不能发布声称 M0 通过的版本**。仅有 `status: passed`、截图或硬件清单不够；SwiftShader、WARP、llvmpipe 等软件适配器证据不算硬件验收。`hardwareRT: false` 或软件 BVH 算法说明与真实 GPU 执行不矛盾，不会单独导致拒绝。渲染证据发现 fallback/software adapter 时拒绝。

`limitations` 必须为非空字符串数组。不得删除实际限制后把原型宣传为完整功能。发布摘要仅采用规范化字段；主线也须确保原始证据不含密钥、原始用户目录或其他不应公开的数据。

## 许可证与第三方通知

根目录必须有 MIT `LICENSE`，以及已有的、非空第三方通知文件之一：

- `THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_NOTICES.txt` 或 `THIRD_PARTY_NOTICES`；
- `docs/THIRD_PARTY_NOTICES.md` 或 `docs/THIRD-PARTY-NOTICES.md`。

通知内容由负责依赖与许可审计的主线生成和审查，包含实际捆绑组件的许可要求。打包器只检查，不下载、猜测或创建许可内容，也不把依赖元数据自动等同于完整许可义务已履行。缺失时以 `TCREL_NOTICE` 失败。

源码包保留原始通知。dist 包另外嵌入 MIT `LICENSE` 与规范名称 `THIRD_PARTY_NOTICES.md`，不修改工作区 `dist/`。如果 dist 已有同名文件，内容必须与已核对的根目录文件一致。

## 工作区收集与 ZIP 规则

源码从显式根目录递归收集，不调用 `git ls-files`，因此包含工作区当前的源码、文档、测试、锁文件、必要配置，以及完整 `evidence/m0/`。未提交文件也会进入包；发布主线必须确保工作区就是要发布的版本。

在下降目录前排除依赖、缓存、发布输出与敏感目录，包含 `.git/`、`node_modules/`、`.threecat/`、`release/`、`dist/`、临时目录、测试报告、覆盖率、`.ssh/`、云凭据目录等。源码不包含根目录 `dist/` 与临时 `public/generated/`，dist 单独归档；保留 `threecat.ps1` 引导脚本、`AGENTS.md`、`docs/`、`evidence/`、锁文件与资产。发布打包固定读取引擎根目录 `dist/`，外部游戏自身的 `project/dist/` 不会被误当成本次引擎发布产物。

同时排除 `.env*`、`.npmrc`、私钥和证书容器、凭据/令牌命名文件、日志、编辑器备份、临时文件及已有压缩归档。文件内容发现常见私钥头或真实令牌格式时直接失败，不静默发布。此筛查减少误打包，**不声称检测一切秘密**；主线仍应审查要公开的源码和证据。

所有符号链接、目录 junction 都跳过，不读取目标；关键证据通过链接提供时因缺失而失败。输出目录本身不能是 junction。读取边界是项目目录，绝不搜索全盘或扫描用户主目录寻找文件。

ZIP 使用工具内置的 ZIP32/deflate，UTF-8 文件名、固定时间戳、相对路径，不依赖 PowerShell 压缩工具或额外 npm 库。单文件上限 128 MiB，源码与 dist 原始总量上限 512 MiB，总文件数最多 60,000。超限明确失败，不读取大型 `node_modules`；确需更大产物时由引擎研发调整归档实现与测试，不能截断资源冒充成功。

打包使用同一批已读取字节完成证据校验、文件哈希与归档。主线应在稳定工作区执行，不在打包过程中继续修改文件。对变化检测到的输入明确失败；不承诺对任意并发写入提供文件系统事务。

## 输出与完整性

输出目录固定为 `release/v0.0.1-m0.0/`：

| 文件 | 内容 |
| --- | --- |
| `threecat-0.0.1-m0.0-source.zip` | 顶层 `threecat-0.0.1-m0.0/`，包含源码与 `evidence/m0/` |
| `threecat-0.0.1-m0.0-dist.zip` | 解压根目录直接是 `index.html`、运行资源与许可材料 |
| `threecat-0.0.1-m0.0-evidence.json` | 规范化验收、限制与所有 M0 证据的相对路径/字节数/SHA-256 |
| `threecat-0.0.1-m0.0-manifest.json` | 归档 SHA-256、每个解压文件的相对路径/大小/哈希，以及附属文件哈希 |
| `RELEASE_NOTES.md` | 预发布范围、已通过项目、真实限制和使用提示 |
| `SHA256SUMS` | 前五个文件的 SHA-256，无自引用校验和 |

所有生成 JSON 采用相同 `protocolVersion`、`engineVersion`、`milestone`、`scope` 和 `prerelease` 语义。清单的路径只使用 `/` 分隔的相对路径，不含绝对目录、用户名或本机环境变量。摘要会脱敏已知项目与用户目录；原始证据内容仍由其生成流程负责脱敏。

先写 `release/.staging-<随机标识>/`，全部成功后改名为版本目录。已存在同版本输出时拒绝覆盖；主线应保留已有版本，确需重打包则先将旧目录显式移走，不删除已发布证据后悄悄覆盖。打包失败会清理自己创建的临时目录，不递归删除其他目录。

校验示例：

```powershell
$releaseDirectory = 'release/v0.0.1-m0.0'
Get-Content -LiteralPath "$releaseDirectory/SHA256SUMS" | ForEach-Object {
  $expected, $name = $_ -split '  ', 2
  $actual = (Get-FileHash -LiteralPath (Join-Path $releaseDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA256 mismatch: $name" }
}
```

`dist` ZIP 解压内容部署至 Web 服务器，不能用双击 `file://` 代替部署测试。主线的 `deploy` 验收负责从实际构建的 `dist/` 验证资源和运行行为；打包器不伪造该结论。

## 主线自动发布流程

以下步骤属于主线任务，不由 `tools/release.ts` 或本次 CI 执行：

1. 按 ROADMAP 实际完成并复测 M0 四条原型。记录环境、限制与风险，生成八类证据及 `acceptance.json`。
2. 执行类型检查、单元测试、实际 WebGPU 验证、静态构建与 dist 部署验证，修正失败。主线验收器负责证据真实性与时效性。
3. 执行 `npm run release:check`，失败就停止；成功后在稳定工作区执行 `npm run release:pack`，再核对哈希与内容。发布包应与验收所用工作区一致。
4. 主线提交并推送确切的源码和证据到 `danchar12138/threecat`。确认标签指向相同版本提交；不强推、不替换既有标签，不把发布 token 写入文件或日志。
5. 使用已授权的 GitHub 身份自动创建 **prerelease** 并上传六个产物，不新增人手审批。
6. 查询远程 Release，核对标签、目标提交、prerelease 标记、六个附件及下载后的哈希；将发布结果报告给用户。

示意发布命令（主线须先将 `$releaseCommit` 设为实际已推送的发布提交；此文档不会执行它）：

```powershell
$releaseDirectory = 'release/v0.0.1-m0.0'
gh release create v0.0.1-m0.0 `
  --repo danchar12138/threecat `
  --target $releaseCommit `
  --title 'threecat M0 — risk prototypes' `
  --prerelease `
  --notes-file "$releaseDirectory/RELEASE_NOTES.md" `
  "$releaseDirectory/threecat-0.0.1-m0.0-source.zip" `
  "$releaseDirectory/threecat-0.0.1-m0.0-dist.zip" `
  "$releaseDirectory/threecat-0.0.1-m0.0-evidence.json" `
  "$releaseDirectory/threecat-0.0.1-m0.0-manifest.json" `
  "$releaseDirectory/RELEASE_NOTES.md" `
  "$releaseDirectory/SHA256SUMS"
```

若网络中断，先查询远程状态再恢复；不能盲目重复创建或覆盖既有附件。认证缺失则报告阻塞，不更改为无需验收的其他发布路径。

## 后续里程碑版本

每个里程碑都要形成源码、可用构建产物、验收证据和发布说明。当前工具实现 M0 门禁，后续里程碑需要随实现扩展对应验收配置，不能复用 M0 的报告宣布后续完成。

| 里程碑 | 建议首个版本 | 发布定位 |
| --- | --- | --- |
| M0 | `0.0.1-m0.0` | 风险原型 prerelease |
| M1 | `0.1.0-m1.0` | 基础契约 prerelease |
| M2 | `0.2.0-m2.0` | 完整游戏切片 prerelease |
| M3 | `0.3.0-m3.0` | 高级渲染 prerelease |
| M4 | `0.4.0-m4.0` | 完整模拟 prerelease |
| M5 | `0.5.0-m5.0` | 动态世界 prerelease |
| M6 | `0.6.0-m6.0` | 多类型开发 prerelease |
| M7 | `0.7.0-m7.0` | 优化与兼容 prerelease |
| M8 | `1.0.0` | 仅在完整首发退出条件全部满足后发布正式版 |

编号可根据实际兼容需求调整，版本中断或修复不得覆盖既有 Release。未通过完整退出条件就保留 prerelease 标记，不把时间到了当作功能完成。后续任务接手时应默认将发布作为已授权交付步骤，提交描述使用对应 scope 的中文标准消息，例如 `feat(m1): 完成核心契约与编译运行基础`。

## CI 边界与本地验证

`.github/workflows/ci.yml` 在 Windows/Node 24 上执行 `npm ci`、类型检查、CPU 单元测试和静态构建，权限仅 `contents: read`。GitHub hosted runner 的绿色状态**不是 GPU 通过证明**；CI 不运行 `verify:m0`、不生成 `acceptance.json`、不自动发布。发布由获得用户授权的主线在实际硬件验收后执行。

发布规则测试入口：

```powershell
node --import tsx --test tests/release.test.ts
```

测试使用隔离临时目录中的**合成验收记录**，只验证规则与归档实现，不能作为真实 GPU 或 M0 能力证据。覆盖真实失败、路径边界、敏感文件排除、无 Git/中文空格路径、Windows 解压、SHA-256 逐字节与逐文件校验、输出不可覆盖及预发布说明。

常见错误码：`TCREL_ACCEPTANCE_MISSING`、`TCREL_ACCEPTANCE_STATUS`、`TCREL_CHECKS`、`TCREL_CHECK_STATUS`、`TCREL_EVIDENCE_FILES`、`TCREL_EVIDENCE_MISSING`、`TCREL_GPU_EVIDENCE`、`TCREL_GPU_SOFTWARE`、`TCREL_VERSION`、`TCREL_PROTOCOL`、`TCREL_LICENSE`、`TCREL_NOTICE`、`TCREL_PATH`、`TCREL_OUTPUT_LINK`、`TCREL_OUTPUT_EXISTS`、`TCREL_SECRET`、`TCREL_SIZE`。
