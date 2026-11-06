# Fox Journey：M2 公开 SDK 游戏切片

运行引擎根目录的 `npm run dev`；默认加载此工程。新游戏使用 `pelican.ps1 create --project <新目录>` 复制模板和素材，所有玩法代码位于 `game.ts`，只导入公开 SDK。

WASD/方向键移动，Space 跳跃，E 收集，F5 保存，F9 读取，R 重开，Q/T 旋转相机。B 生成刚体箱子，N 生成模型角色。通关需收集三件遗物并进入北门，巡逻球体会造成伤害；存档可在通关场景或浏览器刷新后恢复。

普通页自动运行，不需要点击或回车。外部工具使用 `?automation=1` 的确定性测试页；使用控制桥查询、输入、单步和截图。浏览器的音频自动播放策略可能只暂停音频输出，不阻塞玩法、GPU 就绪或测试。

素材来源和哈希见 `assets/sources.json` 与原始 metadata。Fox 模型 CC0，动画和 glTF 转换 CC-BY-4.0，作者归属在源码资产定义和构建 notices 中保留；WaterBottle 为 Microsoft 的 CC0 资产。`chime.wav` 为 pelican 生成的 PCM 声音。请保留素材声明，不把引擎 MIT 许可视为任意素材的许可。

版本状态见根 `engine.manifest.json` 与 `evidence/m2/acceptance.json`。这是通过 M2 验收的游戏切片预发布，不代表 M3–M8 正式能力完成；带纹理 GLB 当前使用 raster，完整材质路径追踪仍待 M3。
