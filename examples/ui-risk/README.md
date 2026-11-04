# M0-08 / M2 UI 风险专项

这是公开 SDK 编写的专项场景，验证中文组合输入、选择区间、焦点、世界 UI 投影、遮挡与交互。不是 UI 编辑器，也不是完整 M6 UI 体系。

```powershell
npm run dev -- --project examples/ui-risk --port 4183
```

V 移开或恢复遮挡物。世界按钮被实际几何遮挡时不参与可见、命中或焦点选择；移开后可以点击。输入框内的 W 应输入文字，不触发场景移动；离开输入框后 W 可移动目标并带动锚点。Enter 提交文字，屏幕按钮和世界按钮的激活次数由玩法组件观察。

外部 `tools/ui-risk-probe.ts` 通过 Chromium 文本组合输入通道记录 composition/beforeinput/input，检查提交、选区与玩法隔离；标准 Gamepad 采样注入用于确定性焦点序列，报告明确不等于实物手柄验证。OS 输入法候选窗、物理手柄设备矩阵、复杂布局/字体/可访问性仍属于后续验证。源码不导入 DOM、Three.js 或 GPU 依赖。

验收产物在 `evidence/m2/ui-prototype.json` 和对应图像中。只有实际运行通过才能把此项标为已验收；源码或页面存在本身不是通过证据。
