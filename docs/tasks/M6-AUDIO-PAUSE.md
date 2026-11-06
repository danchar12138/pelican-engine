# M6 音频暂停与恢复增量

状态：开发增量，不代表完整 M6 音频或 1.0 验收。公开 `AudioService.pause(voice)`、`resume(voice)` 操作既有 `play` 返回的 voice ID；重复调用及格式有效但不存在的 ID 为 no-op，无效 ID 报 `TC_AUDIO_VOICE`。暂停期间不累计固定 tick 时间，恢复按逻辑位置重建浏览器播放节点；循环与一次性音频、快照恢复、浏览器未解锁及无 AudioContext 均有明确状态。

后续增加 `audioBuses` 声明、声音默认总线路由及 `play` 覆盖路由，`busVolume` 控制各总线增益，原有 `volume` 控制主增益；voice、bus、master 三者相乘。未声明总线的旧项目与快照维持原形状。未知总线和无效音量返回诊断，快照保留总线及 voice 状态。真实 Chromium 信号测试检查总线隔离、主音量、暂停、恢复和资源清理；不代表总线层级、混响或互动音乐已完成。

相关 CPU 服务与真实 Chromium Web Audio 测试通过，检查暂停、恢复、锁定时钟、多个 voice 和快照；历史物理 v3 夹具也单独通过。测试使用真实浏览器节点但不证明实际扬声器输出、跨设备音画同步或完整 M6。无时长元数据的一次性音频仍遵循已有回收限制；总线层级、混响、互动音乐与完整音频验收仍未完成。

`tests/audio-pause-browser.test.ts` 使用非零 PCM 波形与浏览器 Analyser，检查播放、暂停静音和恢复后波形；不是物理扬声器听感测试。公开 SDK 游戏 `examples/audio-pause` 的完整输入、两音轨、暂停、固定 tick、快照／恢复及资源清理实测记录于 `evidence/m6/development/audio-pause-1793911500/audio-pause-game.json`，源码指纹 `c02e4a3e552b118261a678e4427aa1a361f5264929bc26878a2ec77ffd00f1c4`；该游戏记录原生 Web Audio 节点事件，不自行证明扬声器输出。不同源码、安装渠道与完整 M6 仍须各自验证。

单包安装渠道使用 `tools/audio-pause-game-probe.ts --installed-root <project>` 执行相同公开游戏流程。在同一 Windows 机器的仓库外临时项目离线安装本地 tarball 后，实际播放节点、暂停、恢复、快照、双音轨互不重启和清理检查通过，报告 `evidence/m6/development/audio-pause-npm-1793912500/audio-pause-game.json`；包／SDK／分发版本一致为 `0.3.0-m3.0`，包 SHA-256 `aa16a3bea1000fc0596e9192b92f83b01152ae694fb993ee05c2aebb421a1249`。这不是全新 Windows 或公开 npm registry 安装验收。

后续探针在浏览器中拦截非本地开发服务器 origin 的请求，源码渠道和已安装 npm 渠道均再次通过同样流程；结果分别为 `evidence/m6/development/audio-pause-source-offline-1793913500/` 和 `evidence/m6/development/audio-pause-npm-offline-1793913500/`。源码探针指纹 `fee804abfe75963b18d6e8adbf50864bdc051853a498101d7870fd91256e51ac`；npm 包仍为上一段的 tarball。该检查限制浏览器请求，不声称全新操作系统或公开 registry 验收。

对照两份报告的九个阶段，`tick`、公开游戏组件和音频逻辑状态逐项相同；浏览器节点事件和设备时间作为各自观测，不宣称跨运行逐位一致。

总线版本的同一公开游戏在源码和 npm 安装渠道均运行，包含 music 默认路由、effects 播放覆盖、总线音量修改、暂停及快照恢复；11 个阶段的 tick、游戏组件和音频逻辑状态逐项相同。证据为 `evidence/m6/development/audio-bus-source-1793915000/` 与 `audio-bus-npm-1793915000/`，源码指纹 `50a82bffb06a3f7b81ab8f9c201ce8d7ec491fe4003ee0b749e84ef70d7d0efa`，离线 npm 包 SHA-256 `7ebd60979bc8a025bedb8846958a33ae675d064b95378a77daaf929dd93bfaac`。两次浏览器均限制为本地服务器 origin；npm 项目也成功构建 dist。它们不代表公开 registry、新系统、物理扬声器或完整 M6 验收。

`fadeBus(id, target, duration)` 已接入公开 SDK：固定 tick 线性淡变，可由新淡变或 `busVolume` 覆盖，并随快照恢复。`play` 的 `priority` 范围为 0–255；达到 voice 上限时，只有严格更高优先级才能抢占最早的最低优先级 voice。CPU 与真实 Chromium Web Audio 相关 32 项测试通过；当前仍不代表混响、互动音乐或完整 M6。

本次集中全仓测试的原始日志位于 `evidence/m3/development/verification-1793912500/`：首轮发现生命周期 VM 夹具和旧 IOR 字符串断言不匹配，修复后 1630 项通过、5 项默认跳过；5 项按独占 GPU／浏览器串行补跑，相关 74 项全部通过且无跳过，两个计数有重叠。日志没有在执行前后完整冻结源码，不能当作正式 M3 接受证据；后续源码冻结后仍需完整门禁。
