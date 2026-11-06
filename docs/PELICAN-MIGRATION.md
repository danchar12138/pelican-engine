# Pelican Engine 命名与迁移

本次名称由用户确定：**Pelican Engine（鹈鹕游戏引擎）**。引擎仍处于 M3 开发，不因更名重启里程碑，也不把已有开发探针提升为正式验收。

| 对象 | 唯一正式名称 |
| --- | --- |
| 产品 | Pelican Engine（鹈鹕游戏引擎） |
| GitHub 所有者 / 仓库 | `danchar12138/pelican-engine`（所有者保持不变） |
| npm 单包 | `pelican-engine` |
| 命令 / bin | `pelican` |
| 游戏侧公开导入 | `pelican-engine` |
| 源码目录启动脚本 | `pelican.ps1` |
| 项目清单 | `pelican.project.json` |
| 本地缓存 / 开发控制路由 | `.pelican/` / `/__pelican/` |
| 部署版本清单 | `pelican-build.json` |

SDK、runtime、renderer、编译器和 CLI 位于同一个 npm 包中。内部模块不成为额外公开导入入口；游戏不导入 renderer、Three.js、TSL 或 GPU 对象。仓库开发通过路径解析到同一 SDK，npm 通过导出解析到生成的 JavaScript 与声明，接口与开发能力相同。

目标最短使用流程为：

```powershell
npm i -D pelican-engine
npx pelican dev
```

首次 `dev` 在没有游戏文件的新目录创建最小可运行项目；已有项目必须保留原文件，错误给明确诊断，不能覆盖游戏。安装依赖后日常开发、构建和运行不依赖网络；自动化截图需要提前准备浏览器。

## 历史与迁移边界

M0–M2 的原名称、标签、提交、Release 附件与 `evidence/` 是历史事实，内容及哈希原样保留。历史证据中的旧名称、旧协议、旧命令只适用于对应历史标签，不是当前 SDK 的别名。原始 MIT 版权声明继续保留，新开发声明 Pelican Engine。

既有稳定错误码 `TC_*`、`TCENV_*`、`TCREL_*` 是诊断协议标识，不是旧 SDK 的入口或品牌别名，本次不为改名破坏它们。旧缓存目录仅在忽略/归档排除规则中保留，以免把历史缓存当作当前源码或发布物；当前生成的项目、协议格式、控制路由和产物统一使用 Pelican 名称。磁盘上已有工作目录名称不影响包身份，无需强制移动用户目录。

从旧工作树的游戏迁移时，在游戏副本中将公开导入统一为 `pelican-engine`，清单改名为 `pelican.project.json` 并锁定当前精确引擎版本，使用当前 CLI 重新检查和构建。重新生成 `.pelican/` 与 `dist/`，不复用旧编译缓存。旧存档/回放/快照的品牌格式标识不自动当作当前格式；无明确迁移器时保留原文件并提示不兼容，不静默改写历史数据。原里程碑复测继续从原标签进行。

## 远端实际状态

用户后续明确 GitHub 只改仓库名，不改组织。远端现已改名为 `danchar12138/pelican-engine`，本地 origin 同步更新，公开仓库、历史标签与 Release 保留。npm 身份已通过授权 Automation Token 验证，令牌仅配置为该仓库 Actions 的 `NPM_TOKEN` secret，未写源码或证据。npm `pelican-engine` 查询仍返回 404；本轮只完成更名和开发分发验证，不在里程碑验收前提前推送、创建标签或发布包。
