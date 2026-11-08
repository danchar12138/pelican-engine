# npm 发布

游戏使用 npm 分发；此仓库是引擎开发项目。发布内容由 `tools/npm/build.ts` 从实际依赖图构建，公开声明、API 索引、配方均从源码生成。源码仓库不提交 `dist/`、tarball、截图或测试日志。

## 版本与检查

显式更新 `package.json`、`package-lock.json`、SDK 的 `SDK_VERSION`、`engine.manifest.json` 和 CHANGELOG，遵守 SemVer。不要覆盖已存在的 npm 版本。发布前执行：

```sh
npm ci
npm run verify
npm run distribution:pack
npm run distribution:smoke -- --online-install
```

按改动范围补充浏览器、GPU、资源生命周期和功能组合回归。未执行的设备或平台不得声称通过。输出留 `.pelican/`，CI 证据留 artifacts；失败也保留原始日志。历史证据由既有 Git 提交、标签、GitHub Release 附件追溯，不用复制到新版本源码树。

## 主线发布

主线推送触发 CI，Windows、Linux、macOS 都执行类型、功能、打包和独立 npm 安装检查。任一检查失败均不发布。通过后使用已配置 npm trusted publisher 的 OIDC 权限发布同一显式版本，单独的 Node 发布工具按参数数组调用 npm，不依赖 PowerShell。

发布后检查注册表元数据与完整 tarball 字节。npm 元数据及 tarball 传播允许最多 16 次请求，指数退避上限 30 秒；传播失败不自动再次 publish，先核对是否已经发布。正式版本是否可安装以实际 registry 为准，GitHub 标签不替代 npm 状态。

## GitHub Release 同步

同一发布任务在 registry 字节核验成功后执行 `npm run release:github`，使用 Actions 的短期 `github.token`（publish job 的 contents: write）创建或更新相同版本的 GitHub Release。版本来自仓库实际 package.json，变更说明从 CHANGELOG 对应章节生成，标签固定到 `GITHUB_SHA`；已有标签若指向其他提交则停止，不移动标签、不强推。

README 是项目与 npm 首页的单一文案来源；npm 构建只去掉贡献者维护段落并调整图片地址。版本徽章读取公开 npm；Latest Release 由发布流程同步，不维护另一份手写“最新版本”页面。构建产物仍只通过 npm 交付，不将 GitHub 自动源码 ZIP 推荐为游戏开发安装方式。

补齐历史发行时显式提供 `--version <version> --commit <full-sha> --tarball <exact-tested.tgz> --historical`，工具仍先对公开 registry 做完整字节核验，且不会把历史版本设成 Latest。没有已核对的源提交或 tarball 时，不猜测历史版本归属。

若 npm 已发布但 Release 同步失败，只重试 GitHub 同步步骤，不重新 publish、不自动增加版本。registry 的精确版本端点、版本列表与 latest 标签可能短暂不同步；独立安装失败保留日志，使用刷新元数据重试，不能拿 tarball 可下载代替游戏真实安装通过。历史失败不被后续成功改写。
