# GPU 计算到材质与后处理

本例仅导入 `pelican-engine`，计算结果通过受控缓冲槽驱动材质颜色和后处理。
材质与后处理都叫 `palette`，各自通过 `render.buffers` 和
`render.effects.buffers` 管理槽，不会互相覆盖命名空间或源保护。

源码渠道运行 `npm run dev -- --project examples/fragment-buffers`。
自动化验证为 `npm run probe:fragment-buffers`，由探针通过标准输入命令触发控制。

| 输入键 | 行为 |
| --- | --- |
| e / i | 启用 / 关闭调色板后处理 |
| o / j / n | 后处理越界 / 非整数 / 负索引，返回零 |
| 0 | 恢复后处理索引 |
| m / b | 材质越界 / 恢复正常索引 |
| a | 同时将材质和后处理重绑到备用缓冲 |
| q | 尝试释放被引用源，记录确定错误码 |

每个固定 tick 对两个颜色元素执行真实 GPU 计算。任务仍读回 CPU 镜像以验证结果，
呈现使用 GPU 复制。该场景验证边界和数据因果，不是美术质量展示或性能基准。
