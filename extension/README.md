# extension/ — 浏览器插件目录

本目录是**插件根目录**，每个子目录是一个独立的未打包 MV3 插件。

## ✅ 当前插件（请只加载这一个）

| 插件 | 目录 | 用途 | 上报目标 |
|---|---|---|---|
| 跨境电商工具箱（三合一） | `cross-border-toolkit/` | ① 1688 货源采集 ② Shopee 商品/评论采集 ③ 全网图片搜 1688 同款（悬停角标 / Alt+点图 / 右键菜单；淘宝/天猫商品页另有主图悬浮按钮）。工具栏 popup 按当前网站高亮对应模块，可逐模块开关 | 1688 采集 → `/api/sourcing/collect`（需 X-Collect-Token）；Shopee → `/api/competitor/ingest`（免鉴权）；图搜不上报 |

三合一说明：
- **模块路由**：按访问的网站自动启用——1688 商品页出采集浮层、Shopee 出采集浮窗、其余网站只有图搜角标。
- **开关**：popup 里三个开关存 `toolkitToggles`；图搜实时生效，采集模块刷新页面生效。
- **配置**：统一存 `toolkitSettings`（后端地址 + 采集 token），首次安装自动从两个旧插件迁移。

## 🗄️ 已并入的历史插件（目录保留供参考，Chrome 里不要再加载）

| 原插件 | 目录 | 并入 |
|---|---|---|
| Cross-Border Sourcing | `1688-sourcing/` | → `cross-border-toolkit/`（extractor/bridge 冒烟测试仍指向本目录，逻辑未变） |
| Shopee 采集助手 | `shopee-collector/` | → `cross-border-toolkit/` |
| 淘宝→1688 找同款 | `taobao-1688-search/` | → `cross-border-toolkit/modules/image-search.js` |

## 安装方式

`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `cross-border-toolkit` 子目录（不是本目录）。
若之前加载过旧插件，先移除，避免浮层重复出现。

## 在内嵌浏览器中挂载

编辑 `server/browser/extensions.json`（参考同目录 `extensions.example.json`），
把 `cross-border-toolkit` 的相对路径加进 `extensions` 数组（旧的三条删掉），然后重开内嵌浏览器即生效。
