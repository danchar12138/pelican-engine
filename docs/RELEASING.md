# threecat 里程碑发布规范

本文描述仓库内已实现的发布检查与打包工具，以及由主线执行的发布流程。工具本身不执行 Git、gh、网络上传或云端构建，不生成验收结论，也不启动 GPU 测试。

用户已授权每个里程碑在验收后提交、推送并发布 Release。提交、推送、标签与 Release 必须位于同一个里程碑交付节点，不提前零散推送；提交消息采用 Conventional Commits 结构和中文描述，例如 `feat(m1): 完成核心契约与编译运行基础`。仅承担工具开发的任务不因此获得发布其他未验收代码的授权。

## 当前阶段选择

`engine.manifest.json` 是当前阶段与版本的入口，不读取 main 分支版本、Git 标签或最新 Release 来猜测目标。

| 输入           | 规则                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| `milestone`    | 识别 M0–M8；当前已实现 M0、M1、M2 三个发布 profile                              |
| `version`      | 合法版本号，匹配 package.json、package-lock.json 顶层和 packages[""] 的版本     |
| `releaseScope` | M1 起必须显式声明；已实现 profile 要求精确匹配                                  |
| 验收路径       | `evidence/<milestone 小写>/acceptance.json`，例如 `evidence/m1/acceptance.json` |
| 构建目录       | 固定为引擎根目录 `dist/`，不使用嵌套游戏目录中的 dist 替代                      |

当前 profile：

| 阶段 | scope                 | 必需检查 ID                                                                                                                                                        | 发布状态   |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| M0   | `risk-prototypes`     | environment、compiler、render、simulation、ai-workflow、typecheck、unit-tests、deploy                                                                              | prerelease |
| M1   | `runtime-foundation`  | environment、typecheck、unit-tests、compiler、runtime、resources、scheduler、protocol、unattended、render、deploy、ai-workflow                                     | prerelease |
| M2   | `playable-game-slice` | environment、typecheck、unit-tests、compiler、assets、physics、runtime、ui-prototype、dev-server、protocol、unattended、render、deploy、ai-workflow、source-freeze | prerelease |

M0 manifest 可省略 `releaseScope`，兼容已有源码包；提供时必须为 `risk-prototypes`。旧导出 `REQUIRED_CHECKS` 仍只表示 M0 的八项门禁，`M0_VERSION` 仍是独立 legacy fixture 常量 `0.0.1-m0.0`，不控制当前仓库版本。M1、M2 检查分别由 `M1_REQUIRED_CHECKS`、`M2_REQUIRED_CHECKS` 定义，`RELEASE_PROFILES` 集中记录已实现阶段的规则。M2 的 15 项检查来自 `tools/verify-m2.ts`，测试核对两者一致。所有阶段都使用 manifest 的实际版本生成文件名。

M3–M8 必须显式声明 `releaseScope`，但当前没有对应验收 profile，返回 `TCREL_PROFILE`，不能复用 M0/M1/M2 门禁通过。以后随阶段 verifier 和测试一起实现 profile，再启用该阶段。未知阶段返回 `TCREL_MILESTONE`。当前 manifest 为 M2 时，即使 M0/M1 的验收完全通过，也不能替代缺失的 M2 验收。

M2 是可玩游戏切片和资产管线 prerelease，不是 M1 runtime foundation，也不是完整引擎。带纹理 GLB 当前走 raster；完整 glTF 材质 hybrid/path tracing 属于 M3，M3–M8 尚未完成。发布说明明确这些边界，并逐条保留当前 acceptance 的 `limitations`，不把已通过的切片门禁扩写为完整能力或普遍性能承诺。

M2 构建可生成 `.br/.gz` 传输压缩文件。dist ZIP 保留这些已声明的运行资源；若存在 `compression-manifest.json`，发布检查核对原始文件与压缩文件的字节数、哈希，并验证解压内容相同。缺失、损坏或陈旧压缩文件均拒绝打包。源码归档继续排除无关压缩归档和缓存。

旧候选的缺失报告与 kinematic 接触失败记录保留在 `evidence/m2/attempts/`。最终候选经过修复、重新冻结和独立 AI 复验后，695 项测试与 15 项门禁全部通过。修改源码或资产后仍须重做受影响验证，不能手动改为 passed 或刷新生产证据哈希绕过门禁。

## 命令与库接口

```powershell
npm run release:check
npm run release:pack
node --import tsx tools/release.ts check --root "D:\游戏开发\threecat"
node --import tsx tools/release.ts pack --root "D:\游戏开发\threecat"
```

```ts
import { checkRelease, packRelease } from "./tools/release.ts";

await checkRelease({ projectRoot: engineDirectory });
await packRelease({ projectRoot: engineDirectory });
```

`projectRoot` 缺省为工具所属的引擎根目录。没有 `.git`、通过 ZIP 解压、中文空格路径和本地目录均可使用。依赖准备完成后检查与打包不需要联网，不引入额外在线服务。

成功退出码为 0，失败为 1。标准输出为 JSON envelope：

- `protocolVersion: "0.1.0"`。
- 成功的 `taskId` 为当前阶段，例如 `M1-release`；无法完成检查的错误使用通用 `release`。
- `status`、`diagnostics`、`artifacts`、`data`；失败时 data 为 null。
- 每条诊断包含稳定的 code、severity、message 和 remediation，不回显原始系统异常或本机绝对路径。

`check` 只读；`pack` 重新执行同一套检查，通过后才创建发布目录。它们不自动构建、不补造缺失证据、不把 CPU CI 结果当作 GPU 证明。

## 验收输入契约

验收文件由主线在真实执行完成后汇总。M1 形状示意如下，**不是可以直接提交的成功证据**：示意哈希需要替换为源码指纹函数的真实输出，证据路径需要指向对应实测产物。

```json
{
  "protocolVersion": "0.1.0",
  "milestone": "M1",
  "engineVersion": "0.1.0-m1.0",
  "scope": "runtime-foundation",
  "status": "passed",
  "sourceIdentity": {
    "sha256": "<当前源码指纹：64 位小写十六进制>"
  },
  "checks": [
    {
      "id": "environment",
      "status": "passed",
      "evidence": ["evidence/m1/environment.json"]
    },
    {
      "id": "typecheck",
      "status": "passed",
      "evidence": ["evidence/m1/typecheck.json"]
    },
    {
      "id": "unit-tests",
      "status": "passed",
      "evidence": ["evidence/m1/unit-tests.json"]
    },
    {
      "id": "compiler",
      "status": "passed",
      "evidence": ["evidence/m1/compiler.json"]
    },
    {
      "id": "runtime",
      "status": "passed",
      "evidence": ["evidence/m1/runtime.json"]
    },
    {
      "id": "resources",
      "status": "passed",
      "evidence": ["evidence/m1/resources.json"]
    },
    {
      "id": "scheduler",
      "status": "passed",
      "evidence": ["evidence/m1/scheduler.json"]
    },
    {
      "id": "protocol",
      "status": "passed",
      "evidence": ["evidence/m1/protocol.json"]
    },
    {
      "id": "render",
      "status": "passed",
      "evidence": ["evidence/m1/render.json"]
    },
    {
      "id": "deploy",
      "status": "passed",
      "evidence": ["evidence/m1/deploy.json"]
    },
    {
      "id": "ai-workflow",
      "status": "passed",
      "evidence": ["evidence/m1/ai-workflow.json"]
    }
  ],
  "limitations": ["记录本阶段实际限制、未覆盖范围和测量边界。"]
}
```

M0 兼容既有最小结构：milestone、scope、status、checks 和非空 limitations；engineVersion、protocolVersion、sourceIdentity 可省略。存在时必须有效且匹配，不能忽略旧报告中已经记录的过期指纹。M0 完整八项门禁和 GPU 检查不降低。

M1、M2 必须显式记录匹配的 `engineVersion` 和有效的 `sourceIdentity.sha256`。若同时存在 `version`，也必须匹配。engine 或 acceptance 提供 `protocolVersion` 时必须为 `0.1.0`。所有阶段要求 MIT LICENSE、匹配的许可声明、第三方许可通知、README.md、AGENTS.md 及非空根 `dist/index.html`。

M2 使用 `milestone: "M2"`、`scope: "playable-game-slice"` 和 manifest 的实际版本；证据路径遵循 `verify-m2.ts` 的真实输出，不要求每个 gate 都有同名 JSON：

| gate                       | 实际引用                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| environment                | `evidence/m2/environment.json`                                                      |
| typecheck / unit-tests     | `typecheck.txt` / `unit-tests.txt`                                                  |
| compiler                   | `compiler.json` 及 `docs/api/index.json`                                            |
| assets                     | `assets.json`、`asset-tests.txt`                                                    |
| physics / runtime          | `physics-tests.txt` / `runtime-tests.txt`                                           |
| dev-server / source-freeze | 两者均引用 `compiler.json`，不是独立同名报告                                        |
| protocol                   | `protocol.json`、`control.png`                                                      |
| unattended                 | `unattended.json`                                                                   |
| render                     | `render.json`、`journey.json`、`first-relic.png`、`all-relics.png`、`sanctuary.png` |
| deploy                     | `deploy.json`、`dist.png`                                                           |
| ai-workflow                | `ai-workflow.json` 以及各 flow 的 artifacts                                         |

表中未写前缀的文件均位于 `evidence/m2/`。render 的 GPU 信息可嵌套在 `initial.backend`、`initial.adapter`；部署报告使用 `passed/base/hooks/score/errors`，编译报告使用 `success/engineVersion`，不虚构统一的 `status: passed` 报告结构。发布检查继续校验证据存在、非空和 GPU 信息，不替代 verifier 对报告内容和真实流程的断言。

M2 的根 dist 还必须已有非空的 `THREE-LICENSE.txt`、`RAPIER-LICENSE.txt`、`THIRDPARTY-NOTICES.txt` 和 `generated/asset-notices.json`。前两者由构建器复制依赖完整许可，后两者保存运行时及资产声明；发布工具不补造缺失文件。资产 JSON 必须采用编译器的 `{ format: "threecat.asset-notices", version: 1, assets: [...] }`，每项保留字符串 `id/path`、非空字符串或 null 的 `license`，以及可选字符串 `source/attribution`；null 与编译器对未声明许可的警告语义兼容，不被改写为 MIT。无资产项目允许空数组。此校验确认文件和声明结构，不认证用户资产权属，也不证明许可证文本完整合法；主线须审查完整许可及归属。M0/M1 不新增这些 dist 要求。

检查记录规则：

- 标准引用字段是 `checks[].evidence`；兼容旧 `files`，两者同时存在时必须一致。输出统一使用 evidence。
- ID 必须稳定、唯一，阶段必需项缺一不可；额外项也必须 passed。
- failed、skipped、pending、缺失状态均不能通过。
- 每项引用非空文件列表，文件必须存在、非空，并能收集进源码包或 dist 包。
- 路径相对引擎根目录，支持中文与空格；沿用已有路径、链接、敏感文件检查，不增加防篡改机制。
- 验收不能引用自身充当证据。limitations 必须是非空字符串数组。

## 源码身份与真实 GPU

继续复用 `tools/source-fingerprint.ts` 的 `sourceFingerprint(root)`，不修改其算法、排序、文本处理或 source-map 行为。该函数覆盖可执行源码、锁定配置与 packages 下的共享包，按自身排除规则处理文档、报告和生成产物。

M1、M2 对验收记录中的 SHA-256 与当前源码指纹进行比较。共享包、工具、测试、项目配置或锁文件变化后，需要重新完成受影响的真实验证并生成新的验收记录；工具不会替主线刷新哈希。当前指纹也纳入 GLB、WAV 等二进制资产，M2 的测试逐字节改动 GLB/WAV 后必须报 `TCREL_EVIDENCE_STALE`。源码身份用于避免错误复用旧证据，不是防篡改措施。发布摘要保留已验证的 `sourceIdentity.sha256`。

M0、M1、M2 的 render 检查都需要引用 JSON 报告；至少同一份报告中包含：

- `backend: "WebGPUBackend"` 或 `backend: "webgpu"`，可嵌套。
- 非空 adapter 身份，例如 vendor、description、device、architecture。
- `isFallbackAdapter: false`。

出现 SwiftShader、llvmpipe、lavapipe、WARP 等软件设备、fallback adapter 或 `hardware: false` 时拒绝通过。只有 passed 文案、截图或 WebGL 后端不能替代 WebGPU 证据。真实 GPU 上运行的软件 BVH 算法可以验收为软件光追原型，但不能声称使用了专用硬件光追单元。

发布工具只校验既有记录，不自行证明记录真实性。主线必须实际执行并保存 GPU、部署和外部开发流程的证据；合成单元测试不属于这些证据。

## 打包产物

对版本 `<version>` 输出到 `release/v<version>/`，六个附件为：

1. `threecat-<version>-source.zip`：顶层目录 `threecat-<version>/`，包含源码、引导脚本、文档、资产、锁文件、许可与证据，不依赖 Git。
2. `threecat-<version>-dist.zip`：直接以根 dist 内容为归档根，解压后可部署到 Web 服务器，补入经过检查的 LICENSE 和第三方通知。
3. `threecat-<version>-evidence.json`：当前阶段、scope、prerelease、检查、限制、源码身份及当前阶段 evidence 目录的文件摘要。
4. `threecat-<version>-manifest.json`：两个 ZIP 的摘要、内部逐文件 SHA-256/字节数，以及其他附件的摘要。
5. `RELEASE_NOTES.md`：按当前阶段和 scope 生成，列出通过项及真实限制，不复用 M0 文案声称 M1 或未来阶段已完成。
6. `SHA256SUMS`：上述五个附件的 SHA-256。

源码包可以保留历史阶段的证据，但当前 evidence 摘要只索引当前阶段目录。本次维护的工具、测试、文档及生成的 JSON 和说明文件使用 LF；源码与 dist 归档保留文件原始字节，不做换行归一化。ZIP 使用已有的 UTF-8 名称、固定时间和压缩实现。

沿用依赖、缓存、Git、临时目录与敏感文件排除规则。检测到凭据内容则失败，不泄露到发布包。已有发布目录不覆盖；打包采用临时目录生成并完成后移动，不覆盖源文件。打包时保持工作区稳定，避免在收集、检查与归档之间并行修改源码或构建产物。

## 后续阶段与正式首发

| 阶段 | 建议首版     | 当前发布工具支持                         |
| ---- | ------------ | ---------------------------------------- |
| M0   | `0.0.1-m0.0` | 已实现 profile；风险原型 prerelease      |
| M1   | `0.1.0-m1.0` | 已实现 profile；运行时基础 prerelease    |
| M2   | `0.2.0-m2.0` | 已实现 profile；可玩游戏切片 prerelease  |
| M3   | `0.3.0-m3.0` | 待本阶段 verifier、scope 和 profile 实现 |
| M4   | `0.4.0-m4.0` | 待本阶段 verifier、scope 和 profile 实现 |
| M5   | `0.5.0-m5.0` | 待本阶段 verifier、scope 和 profile 实现 |
| M6   | `0.6.0-m6.0` | 待本阶段 verifier、scope 和 profile 实现 |
| M7   | `0.7.0-m7.0` | 待本阶段 verifier、scope 和 profile 实现 |
| M8   | `1.0.0`      | 尚未启用，不接受正式版成功声明           |

M0、M1、M2 始终返回 `prerelease: true`；manifest 自行写入 `prerelease: false` 不会改变它。M3–M8 当前连打包也不会通过。

未来启用 M8 正式版时，必须同时实现完整 capability gate：明确的必需能力清单、逐项通过状态、证据引用、与当前源码一致的身份，以及整套首发退出条件；只有全部验证通过才可设置 `prerelease: false`。不能仅凭 milestone=M8、version=1.0.0、status=passed 或单个 `allCapabilitiesPassed` 布尔字段推断完成。当前没有接受这些字段即可解锁正式版的协议，具体结构须随 M8 verifier 和完整负例测试一起确定；不提前制造 M8 成功分支。

## 主线交付节点

1. 完成本阶段真实验证，记录环境、限制与证据，生成当前 acceptance。
2. 在稳定源码快照上执行类型检查、CPU 测试、实际 WebGPU 验证、构建、dist 部署及外部开发流程验证。修复后重做受影响验证。
3. 执行 `release:check` 和 `release:pack`，核对源码身份、ZIP 内容、说明及所有哈希。
4. 在同一交付节点提交、推送、打标签和发布 Release，确保提交、标签和附件对应相同源码版本；不提前零散推送、不覆盖已有标签或附件。
5. 根据打包结果设置 prerelease，上传六个附件，查询远程状态并下载核验；网络失败先查询再恢复，避免盲目重复创建。

以上网络操作由主线在已授权范围执行，不是此工具的 API。工具开发任务若明确禁止发布，应只交付这三个文件及测试结果。

## CI 与本地测试边界

CI 统一执行 Windows 下的依赖准备、类型检查、CPU 单元测试及静态构建。它不产生 GPU 通过证明，不生成硬件验收成功记录，也不自动发布。具体脚本由主线维护，此工具任务不修改 `.github/`。

```powershell
node --import tsx --test tests/release.test.ts
```

测试使用临时目录中的合成 M0/M1/M2 记录，仅验证工具行为：兼容 M0/M1、当前阶段选择、错误 scope/版本、旧源码指纹（含共享包及 GLB/WAV 二进制资产）、逐项缺失/失败门禁、重复 ID、软件 adapter 拒绝、缺失或空证据、M2 dist 许可及资产 notices、根 dist、无 Git、中文空格路径、ZIP 与逐文件哈希、不可覆盖，以及 M3–M8 不能误通过。fixture 打包只写临时目录，不运行主仓库 pack。测试结果不得充当真实 GPU 或里程碑验收；本工具开发不生成生产 acceptance、不提交、不推送、不发布。

主要诊断包括：`TCREL_MILESTONE`、`TCREL_RELEASE_SCOPE`、`TCREL_PROFILE`、`TCREL_SOURCE_IDENTITY`、`TCREL_EVIDENCE_STALE`、`TCREL_ACCEPTANCE_MISSING`、`TCREL_ACCEPTANCE_SCOPE`、`TCREL_ACCEPTANCE_STATUS`、`TCREL_CHECKS`、`TCREL_CHECK_STATUS`、`TCREL_EVIDENCE_FILES`、`TCREL_EVIDENCE_MISSING`、`TCREL_GPU_EVIDENCE`、`TCREL_GPU_SOFTWARE`、`TCREL_VERSION`、`TCREL_PROTOCOL`、`TCREL_LICENSE`、`TCREL_NOTICE`、`TCREL_DIST`、`TCREL_PATH`、`TCREL_OUTPUT_LINK`、`TCREL_OUTPUT_EXISTS`、`TCREL_SECRET`、`TCREL_SIZE`。
