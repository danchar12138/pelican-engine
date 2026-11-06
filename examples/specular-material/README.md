# 介质高光颜色与强度

仅使用 `pelican-engine`。场景对照真实 GLB 导入的红色高光与相同 SDK 材质，
并有零强度、绿色高光两个参照。GLB 是仓库内 MIT 程序化测试夹具，可由
`node --import tsx tools/prepare-specular-glb.ts` 重建。

源码渠道：`npm run dev -- --project examples/specular-material`。
独占 GPU 的小型验证：`npm run probe:specular`；独立数值验证：
`npm run probe:specular:numeric`。两项串行执行。

本例验证不透射介质的常数高光因子及导入／SDK 一致性，不代表透射混合、
高光纹理、所有物理材质扩展或性能验收。
