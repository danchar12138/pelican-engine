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

当前 1.1.0 的发布 CI 曾因注册表传播延迟失败，之后公开安装已确认；该历史失败不会因后续修改被改写成成功。新版本检查必须针对新源码与新 tarball。
