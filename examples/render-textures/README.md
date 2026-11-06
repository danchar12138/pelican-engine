# 计算纹理直接渲染

本例只导入 `pelican-engine`：计算纹理驱动材质颜色、顶点变形和后处理；
第二个纹理由随项目提供的 MIT 测试 PNG 导入并转换为线性 rgba32float。

源码渠道运行 `npm run dev -- --project examples/render-textures`；独占 GPU 的
自动验证为 `npm run probe:render-textures`。游戏代码和公开接口同样适用于 npm 渠道。

| 按键 | 行为 |
| --- | --- |
| e / i | 启用 / 关闭直接纹理后处理 |
| a / p | 将材质和后处理槽绑定到导入纹理 / 原动态纹理 |
| q | 尝试释放仍被引用纹理，记录确定错误码 |

每个固定 tick 在 GPU 更新当前纹理。纹理经 GPU 复制进入呈现资源；顶点位置
同时由 CPU 镜像计算供 bounds/BVH 使用，任务结果仍读回校验，不是零复制。
