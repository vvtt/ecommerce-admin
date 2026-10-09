# extension/ — 浏览器插件目录

本目录是**插件根目录**，每个子目录是一个独立的未打包 MV3 插件：

| 插件 | 目录 | 用途 | 上报目标 |
|---|---|---|---|
| Cross-Border Sourcing | `1688-sourcing/` | 1688 商品页手动采集货源（标题/价格/SKU/图片） | `/api/sourcing/collect`（需 X-Collect-Token） |
| Shopee 采集助手 | `shopee-collector/` | Shopee 前台商品页采集（详情/评论/分类） | `/api/competitor/ingest`（免鉴权） |

## 安装方式

`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选对应插件的子目录（不是本目录）。

## 在内嵌浏览器中挂载

编辑 `server/browser/extensions.json`（参考同目录 `extensions.example.json`），
把插件子目录的相对路径加进 `extensions` 数组，然后重开内嵌浏览器即生效。
