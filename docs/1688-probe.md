# 1688 商品页字段探针结果

> **状态：字段映射已完成（2026-09-20）。** 探针 A / C / D / E / F 全部跑完。
> **§9 的字段映射表即为 extractor 的唯一依据**，可用它开始写扩展。
> §10 列出三处仍未验证的地方 —— 都不是首版阻塞项，但写 extractor 时
> **必须对未知分支告警而不是猜**（详见 §9.2 的端点/阶梯混淆）。
>
> ⚠️ 探针已**证伪计划里的三条假设**，详见 §3 与 §9.2：
> `skuPriceScale` 不是阶梯（是区间字符串）、`onePiecePrice` 不是价格（是布尔）、
> 数量阶梯价在这类商品上**根本不存在**（价格按 SKU 变而非按量变）。
>
> ⚠️ **探针 C 首次运行报「window.context 不存在」是假阴性。** 原因是广告落地页
> （URL 带 `src=zhanwai` / `sk=sem`）先渲染一屏再跳转，跑太快时数据还没挂上 ——
> 这种失败与「1688 改版」在输出上完全一样。探针 C/E 现已内置最多 10 秒等待，
> 并在段 0 打印 `window.context` 的准确状态（`ok`/`absent`/`empty`/`threw`）。
> 再遇到类似情况先跑 `docs/probe-1688-diag.js`，不要直接下"改版"的结论。

采集页样本：`https://detail.1688.com/offer/1031250827028.html`（已登录）
探针脚本：`docs/probe-1688.js`（结构扫描 A）、`docs/probe-1688-fields.js`（定向导出 C）、
`docs/probe-1688-diag.js`（上下文诊断 D）、`docs/probe-1688-gaps.js`（补齐 E）、
`docs/probe-1688-network.js`（接口录制，备用）

---

## 1. 数据源：`window.context` ✅ 已确认

商品数据挂在 `window.context` 上。整体形状：

```
window.context
  .result
    .endpoint                     # 走的是哪个 mtop 接口（待探针 C 打印）
    .data                         # 按模块分组，每个模块形如 { id, meta: { scriptFileName }, fields: {...} }
      .<模块名>.fields.<字段>
      .Root.fields.dataJson.*     # ← mtop 原始响应，商品主体数据在这里
    .global.globalData.model.*    # 另一份归并后的数据（tradeModel / offerDetail / promotionModel …）
  .module["@ali/od-main-price"]   # 前端模块注册表，键名带斜杠，只能方括号取
  .panelConfig.module[...]
```

**两层要分开看**：
- `result.data.<模块>.fields` 是**服务端渲染时拆好的模块数据**，字段名偏前端（如 `mainPrice`、`gallery`）。
- `result.data.Root.fields.dataJson` 是**接口原始响应**，字段名偏后端（`skuModel`、`tradeModel`、`offerSign`）。
  重采时更稳的是读 `dataJson` —— 它是接口契约，比渲染层模块名稳定。

`result.data` 下已见到的模块：
`productPackInfo`、`screen`、`description`、`consign`、`shippingServices`、
`submitOrder`、`Root`、`shopProductRecommend`（探针 A 在此处被行数预算截断，
`mainPrice` 等更靠后的模块未展开 —— 这是探针 C 要补的）。

---

## 2. `window.FE_GLOBALS` ✅ 已确认（字段少但好用）

| 路径 | 实测值 | 用途 |
|---|---|---|
| `FE_GLOBALS.offerId` | `1031250827028`（number） | **offerId**，注意是数字不是字符串 |
| `FE_GLOBALS.offerLoginId` | `"广州胜丰玩具有限公司"` | **供应商公司名** |
| `FE_GLOBALS.loginId` | `"amusement11"` | ⛔ **采集者本人**的登录名 —— 见下方更正，**不是**供应商 |
| `FE_GLOBALS.clientDeviceId` | `""` | 无关 |
| `FE_GLOBALS.clientIP` | `"38.46.220.45"` | ⛔ **禁止采集** —— 这是用户自己的出口 IP，属个人信息 |
| `FE_GLOBALS.timestamp` | `Object{0}`（空对象） | 无关 |

`clientIP` 是探针 C 新发现的（探针 A 那次只有 4 个键）。**extractor 里绝不能读它**，
载荷也绝不能带 —— 采集商品信息不需要知道采集者的 IP。
探针 E/F 起已把它列入 PII 规则，逐键列表和 JSON 全文 dump 两条路径都会拦。

### ⚠️ 更正：`loginId` 是采集者本人，不是供应商（探针 E 实测）

探针 A 把 `FE_GLOBALS.loginId` 记为「供应商登录账号」—— **错了**。对照
`dataJson.offerBaseInfo` 里成对的 seller/buyer 字段可以确认：

| 值 | FE_GLOBALS | offerBaseInfo | 是谁 |
|---|---|---|---|
| `"广州胜丰玩具有限公司"` | `offerLoginId` | `sellerLoginId` | ✅ 供应商 |
| `"amusement11"` | `loginId` | `buyerLoginId` | ⛔ **采集者本人** |

`amusement11` 是**你登录 1688 的账号**。照旧文档写 extractor，会把采集者自己的
账号名当成供应商名写进库 —— 而且很难发现（供应商列里出现自己的账号，只有在
多个人用同一个后台采集时才会显形）。

**供应商一律取 `FE_GLOBALS.offerLoginId`（或 `shopInfo.companyName` / `sellerLoginId`），
永不取 `loginId`。**

这三个是**扁平直取**的，不需要在模块树里挖，比从 `dataJson` 里找 sellerModel 可靠。
注意 `offerId` 是 number，上报前要 `String()` 化 —— 我们在 `CollectedOffer.offerId`
里定的是 string。

---

## 3. 价格 ⚠️ 计划里的假设已被证伪（三条：§3.1、§3.2、§9.2）

### 3.1 `skuPriceScale` 是区间字符串，不是阶梯数组 ❌

计划把它列为「最可能的阶梯价」，探针 A 也猜它是 `[{beginAmount, endAmount, price}]`。
**实测（探针 C，2026-09-20）与此不符：**

| 路径 | 实测值 | 性质 |
|---|---|---|
| `dataJson.skuModel.skuPriceScale` | `"2.21-5.37"` | **区间字符串** |
| `dataJson.skuModel.skuPriceScaleOriginal` | `"2.80-6.80"` | 同上 |

它是给前端直接显示的文本，没有结构化。按计划里的假设取 `.price` / `[0]` 会拿到
`undefined`；对字符串取 `[0]` 更糟 —— 会得到字符 `"2"`，**静默写进库一条错价格**。

### 3.2 `onePiecePrice` 是布尔值，不是价格 ❌

`dataJson.onePiecePrice : false`。名字像价格，实际是「是否支持一件代发」的开关。
**当价格采会把 `false` 写进库。**

同批被确认的兄弟字段（都是开关，不是数值）：
`isSkuOffer: true`、`isPricePrivate: false`、`needSkuHide: false`、`isPicPrivate: false`。

### 3.3 阶梯价的真正位置 ⏳ 探针 E 确认中

探针 A 曾命中 `mainPrice.fields.originalPricesWithoutPromotion[N].price` 与 `.beginAmount`，
但没打出全文。**探针 E 改为递归搜索「形如价格阶梯的数组」，不再猜路径** —— 判据是
数组第 0 项为对象且命中 ≥2 个价格类键名。

**决策（待 E 的结果定稿）：** 不能按原计划「优先读 `skuPriceScale`」。
方向改为读 `result.data.mainPrice.fields` 下的数组，具体哪个键由 E 的搜索结果决定。

---

### 3.4 探针 A 的旧路径表（保留备查，形状部分已作废）

| 路径 | 备注 |
|---|---|
| `context.result.data.Root.fields.dataJson.skuModel.skuPriceScale` | **最可能的阶梯价**，名字直译就是「SKU 价格阶梯」 |
| `...dataJson.skuModel.skuPriceScaleOriginal` | 原价版阶梯 |
| `...dataJson.onePiecePrice` | 一件代发价 |
| `...dataJson.offerSign.hasBusinessPrice` | 是否有批发价 |
| `...dataJson.tradeModel.beginAmount` / `minPrice` / `maxPrice` | 起订量 + 价格区间 |
| `...dataJson.tradeModel.tradeWithoutPromotion.offerMinPrice / offerMaxPrice / offerBeginAmount` | 去促销后的区间 |
| `context.result.data.mainPrice.fields.originalPricesWithoutPromotion[N].price` | **已见到 `price` 和 `beginAmount` 两个字段名** |
| `context.result.data.mainPrice.fields.originalPricesWithoutPromotion[N].beginAmount` | 同上 |
| `context.result.data.mainPrice.fields.priceModel.currentPrices / originalPrices` | 当前价 / 原价数组 |
| `context.result.data.mainPrice.fields.finalPriceModel.onHandPrice / onHandPriceNum` | 到手价 |
| `context.result.global.globalData.model.tradeModel.{minPrice,maxPrice,beginAmount}` | 归并后的交易模型 |
| `context.result.globalData.globalData.model.promotionModel.onHandPriceBO.*` | 促销到手价（噪声多） |

`originalPricesWithoutPromotion` 是**数组且元素带 `price` + `beginAmount`** —— 这是
目前证据最硬的一条，形状最接近我们 `PriceTier` 的 `{ beginAmount, price }`。

---

## 4. 图片 ✅ 主图已确认，详情长图待验

探针 A 的图片扫描只在深度 6 以内捞到 **58 条，但全是店铺 logo**
（`cbu01.alicdn.com/cms/upload/...` 和 `img.alicdn.com/imgextra/...` 的
`bigLogo`/`logo`/`middleLogo`）。

**探针 C 已找到商品主图** —— 它不在探针 A 扫的那一层，而在 `dataJson.images`：

| 路径 | 实测 |
|---|---|
| `dataJson.images` | `Array(17)` |
| `dataJson.images[N].fullPathImageURI` | `"https://cbu01.alicdn.com/img/ibank/O1CN019fDM8p22anqkDlEEF_!!2222134207137-0-cib.jpg"` —— **完整 URL，取这个** |
| `dataJson.images[N].imageURI` | `"img/ibank/O1CN019fDM8p22anqkDlEEF_!!2222134207137-0-cib.jpg"` —— **相对路径，缺 host** |
| `dataJson.images[N].size220x220ImageURI` / `size310x310ImageURI` | 同图的缩略尺寸 |
| `dataJson.images[N].searchImageURI` / `summImageURI` | 同图的其它变体 |

⚠️ 一个元素 = **同一张图的多种尺寸**，不是多张不同的图。取缩略图字段会把
一张主图算成六张，图片计数和去重都会错。固定取 `fullPathImageURI`。

若将来回退到 `imageURI`，必须自己补 `https://cbu01.alicdn.com/` ——
它连 `//` 都没有，是最容易漏的一种相对形式。

已确认的事实：
- 图片地址**同时存在 `//` 协议相对形式和完整 `https://` 形式**（同一属性名如 `bigLogo`
  两种都有）——收敛到 `normalizeImageUrl()` 里补协议这一步是必要的。
- 域名有两种：`cbu01.alicdn.com`（店铺/商品图）和 `img.alicdn.com`（阿里资源）。
- 详情长图的入口是 `context.result.data.description.fields.detailUrl`，实测值是
  `https://itemcdn.tmall.com/1688offer/icoss4215174499ad61b0bf0f0b3425` ——
  **注意是 `itemcdn.tmall.com`，不是 alicdn**。
  ⚠️ **更正（2026-09-20 联调实测）：该接口返回的不是 HTML，是一段 JS。**
  见 §9.4 的更正，那里有原文样例和踩坑经过。

---

## 5. 接口 ✅ 已确认（来自 DevTools Sources 面板）

```
h5api.m.1688.com  →  h5/mtop.1688.mmga.offerDetail.service/1.0
```

`mmga.offerDetail` 就是商品详情接口。这与 `window.context` 里出现 `Root.fields.dataJson`
是自洽的 —— `dataJson` 就是它的响应体。

**但首版不打算 hook 它。** 理由：`window.context` 已经直接给了同一份数据，读全局对象
比 hook 请求简单得多，也不用管 mtop 签名与 `_m_h5_tk` 过期。hook 作为兜底留在
`main-world.js` 里，只在全局对象取不到时才启用。

---

## 6. 图片防盗链 A/B 实测 ✅ 已完成

用探针 A 抓到的**真实 URL** 实测（`curl`，2026-09-20）：

| CDN | 无 Referer | `Referer: https://detail.1688.com/` | `Referer: https://evil.example.com/` |
|---|---|---|---|
| `cbu01.alicdn.com` | **200 `image/png`** 18281B | **200 `image/png`** 18281B | **403 `text/html`** 304B |
| `img.alicdn.com` | 200 `image/png` 1344B | 200 `image/png` 1344B | 200 `image/png` 1344B |

**结论：`cbu01` 的防盗链是黑名单式的 —— 它拦的是「Referer 不对」，空 Referer 放行。**

### ⚠️ 这条实测推翻了计划里的一条论证（结论不变）

计划（Phase 1.2）写的理由是：

> 「浏览器不允许扩展伪造 `Referer`，扩展发起的跨域请求 Referer 为空或不含
> `detail.1688.com`，大概率被防盗链拒绝。」

**后半句是错的**：空 Referer 恰恰是放行的。但「图片由服务端下载」这个**决策仍然成立**，
理由换成了下面这些：

1. 扩展要自己下，就得把 `*://*.alicdn.com/*` 加进 `host_permissions` ——
   扩大权限面，与本项目「只申请两个 origin」的最小化取向直接冲突。
2. 页面一关扩展就没法补下，重试要另起一套机制；服务端 `ingestStuckPending()`
   在启动时补跑的能力就没了。
3. 服务端下载天然落盘成一个内容哈希命名的本地副本，原图失效后仍可查看。

**服务端仍带 `Referer: https://detail.1688.com/`** —— 实测它在白名单内，与空 Referer
效果一致，但比空 Referer 更明确地表明来源。

### 403 返回的是 HTML，不是图片

`403` 的响应体是 `text/html; charset=utf-8`。这印证了 `server/sourcing/images.ts`
里 `downloadImage()` 必须校验 `content-type` 以 `image/` 开头 —— 只看 `res.ok`
会把 HTML 错误页当图片存成 `.jpg` 并标记成功。当前实现已有这道防线。

---

## 7. 未登录对照 ⏳ 待做

调研阶段证据冲突（一方称详情页无需登录，一方称必须登录）。需要：
用**隐身窗口**打开同一链接重跑**探针 C**（不要重跑 A —— A 的图片扫描已知只能扫到店铺 logo），
对比价格部分（第 3 节）是「路径消失」还是「存在但值为空」。

这一项决定浮层要不要做降级提示（计划风险 #5）。

---

## 8. 探针 C 新确认的结构

### 8.1 SKU 在 `skuModel.skuInfoMap` —— 按规格名索引的 map，不是数组

| 路径 | 实测 |
|---|---|
| `dataJson.skuModel.skuInfoMap` | `Object{12}`，键是**中文规格名**（如 `【小花--粉色】USB充电款`） |
| `dataJson.skuModel.skuInfoMap[规格名]` | `Object{10}` —— 单个 SKU，10 个字段名待探针 E 展开 |
| `dataJson.skuModel.skuInfoMapOriginal` | `Object{12}`，键相同但每项 `Object{9}` —— **原价版 SKU** |

⚠️ **是 map 不是数组**，且**键是中文规格名**。取值时规格名里有 `【】--` 等字符，
当对象键用没问题，但若被用作文件名或 URL 片段必须转义。

`skuProps`（规格维度）的形状已确认，与我们的 `CollectedSku.specValues` 直接对上：

```
skuProps[i] = {
  fid: 404,                        // 维度 id（数值）
  prop: "颜色",                     // ← 维度名
  value: [
    { imageUrl: "https://cbu01...", name: "充电款风扇【随机1个】" },   // ← 选项名 + 选项图
    …                              // 共 12 个选项
  ]
}
```

`value[].imageUrl` **就是 SKU 图**，不必再去 `skuInfoMap` 里找。

### 8.2 标题在 `result.data.productTitle.fields.title`

**不在 `dataJson` 下。** 同一处还有 `saleNum` / `newSaleCount` / `unit` / `shopInfo`。

### 8.3 `result.endpoint` 是**对象**不是字符串

探针 A 曾把它当字符串读过。探针 E 会打印它的键。

### 8.4 `result.data` 的完整模块表（38 个）

`productPackInfo, screen, description, consign, shippingServices, widgets, cart,
chromePlugin, shopProductCombine, shopProductRecommend, userRights, customMade,
mainServices, sizeChart, submitOrder, navTabs, promotionBanner, gallery, headers,
product, shopNavigation, productPromotion, Root, mainPrice, bottom, productWarning,
productAttributes, officialInspection, orderPanel, productTitle, skuSelection,
productEvaluation, sameProduct, Row, orderGallery, discountCoupon`

**取数时注意**：这张表里大多数模块的 `fields` 只有 `uiType` / `label`（纯布局占位），
**没有数据**。真正有数据的是少数几个：`Root`（含 `dataJson` 全量接口响应）、
`mainPrice`、`productTitle`、`gallery`、`description`、`productPackInfo`、
`shippingServices`。别看到 38 个模块就以为有 38 份数据源 —— 逐个试只会浪费时间。

---

## 9. 已确认字段映射表 ⭐ **extractor 以此为准**

> 全部来自探针 E 在真实商品页的实测输出。凡标 ⚠️ 的都是会静默写错数据的地方。

### 9.1 商品主体

| 目标 | 路径 | 实测值 | 备注 |
|---|---|---|---|
| offerId | `FE_GLOBALS.offerId` | `1031250827028` | **number**，上报前 `String()` |
| 标题 | `result.data.productTitle.fields.title` | `"跨境爆款手持小风扇…"` | **不在 `dataJson` 下** |
| 销量 | `result.data.productTitle.fields.saleNum` | `"10万+"` | ⚠️ **展示文本，不是数字** |
| 销量(数值) | `dataJson.orderParamModel.orderParam.saledCount` | `239397` | ✅ **number，用这个**（见 §9.9） |
| 单位 | `result.data.productTitle.fields.unit` | `"件"` | |
| 供应商 | `FE_GLOBALS.offerLoginId` | `"广州胜丰玩具有限公司"` | 备选 `shopInfo.companyName` |
| 供应商(备选) | `result.data.productTitle.fields.shopInfo.companyName` | 同上 | `authCompanyName` 亦同值 |
| 店铺 URL | `dataJson.offerBaseInfo.sellerWinportUrl` | `https://shop9073486o761a2.1688.com` | |
| 分类 id | `dataJson.offerBaseInfo.catId` | `1047889` | |

### 9.2 价格 ⚠️ **必须先判断模式，再决定怎么解析**

```
result.data.mainPrice.fields.priceModel.priceDisplayType
```

| 取值 | 含义 | 数组的含义 |
|---|---|---|
| `"skuPrice"` | **按规格定价** | `currentPrices` 只有 2 项 = `[最低价, 最高价]`，`beginAmount` 恒为 1，**不是阶梯** |
| （其它值） | 可能是数量阶梯 | ⏳ 尚未采到实例，**不要凭猜测写分支** |

实测本商品是 `skuPrice`：

```
currentPrices  : [{ price: "2.21", beginAmount: 1 }, { price: "5.37", beginAmount: 1 }]
originalPrices : [{ price: "2.80", beginAmount: 1 }, { price: "6.80", beginAmount: 1 }]
```

⚠️ **把这两项当成「两档批发价」是错的。** 它们是最低价和最高价两个端点。
在 `priceDisplayType === "skuPrice"` 时，`price_min` / `price_max` 应取
`currentPrices[0].price` 和 `currentPrices[last].price`，**而不是生成两条 `PriceTier`**。

另有纯文本形式可作交叉校验：
`dataJson.skuModel.skuPriceScale` = `"2.21-5.37"`（`-` 分隔的最低价-最高价）。

原始接口的同一份数据还能在
`dataJson.orderParamModel.orderParam.skuParam.skuRangePrices` 找到（`Array(2)`，同形状）。

### 9.3 SKU ⚠️ **是 map 不是数组，键是中文规格名**

`dataJson.skuModel.skuInfoMap["【水果-菠萝】USB充电款"]`：

| 字段 | 实测 | 类型 | 含义 |
|---|---|---|---|
| `skuId` | `6046825856964` | number | SKU id |
| `specAttrs` | `"【水果-菠萝】USB充电款"` | string | 规格名（= map 的键） |
| `price` | `"2.90"` | **string** | 原价 |
| `discountPrice` | `"2.29"` | **string** | 促销价 |
| `canBookCount` | `9873019` | number | ⚠️ **库存 —— 不是 `amount`** |
| `saleCount` | `0` | number | 销量（这里恒为 0，别用） |
| `specId` | `"d8bcba46…"` | string | 规格 id |
| `retailPrice` | `""` | string | 零售价，**可能是空串** |
| `priceAmount` | `1` | number | 价格对应的数量 |
| `isPromotionSku` | `true` | boolean | |

原价版同结构在 `dataJson.skuModel.skuInfoMapOriginal`（键相同）。

规格维度在 `dataJson.skuModel.skuProps`：

```
[{ fid: 404, prop: "颜色", value: [{ name: "充电款风扇【随机1个】", imageUrl: "https://cbu01…" }] }]
```

`prop` = 维度名，`value[].name` = 选项名，`value[].imageUrl` = **该选项的 SKU 图**。
这直接对上 `CollectedSku.specValues` 的 `{ 维度名: 选项名 }`。

⚠️ 本商品 `skuProps` 是 `Array(1)`（**1 个维度**）但有 **12 个 SKU** —— 别假设
维度数等于 SKU 数。

### 9.4 图片

主图：`dataJson.images`，`Array(17)`。每项 6 个字段，**是同一张图的多种尺寸**：

| 字段 | 用途 |
|---|---|
| `fullPathImageURI` | ✅ **取这个** —— 完整 https URL |
| `imageURI` | ⚠️ 相对路径 `img/ibank/…`，**缺 host**，回退到它必须补 `https://cbu01.alicdn.com/` |
| `size220x220ImageURI` / `size310x310ImageURI` / `searchImageURI` / `summImageURI` | 缩略/检索变体，不用 |

17 个元素 = **17 张主图**（不是 17×6 张）。

详情长图：`result.data.description.fields.detailUrl`
→ `https://itemcdn.tmall.com/1688offer/icoss4215174499ad61b0bf0f0b3425`
域名是 `itemcdn.tmall.com`（不是 alicdn）。同一处还有 `detailVideoId`。

#### ⚠️ 更正（2026-09-20 首次端到端联调实测）

**上面「是一段 HTML 片段」的说法是错的。** 该接口返回的是**一段 JS**，原文形如：

```
var offer_details={"content":"<div id=\"offer-template-0\"></div><img style=\"display: block;…\" src=\"https://cbu01.alicdn.com/img/ibank/O1CN…jpg\" usemap=\"#_sdmap_0\"/> …"}
```

四条要点：

1. 图片 HTML 在 JSON 的 **`content`** 字段里，外面包着 `var <名字> = …`。
2. `content` 是**被 JS 转义过的 HTML** —— 里面的引号是 `\"`。
3. **不能把原文直接喂 `DOMParser`。** HTML 解析器不认 `\` 是转义符，
   `src=\"https://…\"` 的属性值会**连反斜杠带引号一起**留下来，得到 `\"https://…\"`；
   它不以 `http` 开头，「补 host」那一步便会把它当相对路径拼成

       https://cbu01.alicdn.com/\"https://…jpg\"

   —— **形似而必然 404**。首版 extractor 正是这么写的，结果 15 张详情图在后端
   下载时全部 404，而浮层和后端**都没有任何报错**（主图 17 张、SKU 图 12 张不受影响，
   所以只看列表页完全看不出来）。
4. 实测该响应里**没有任何视频**：`<video>` / `<iframe>` / `mp4` 关键字命中数均为 0，
   15 个 `<img>` 就是它的全部内容。**详情图失败与视频无关。**

正确做法：先按 JSON 解出 `content`，再交给 `DOMParser`；解不出就**一张都不发 + 明确告警**，
不要退回「当 HTML 硬解析」。代码见 `extension/1688-sourcing/main-world.js` 的 `detailHtmlOf()`，
回归测试见 `extension/1688-sourcing/test/extractor.smoke.mjs` 的 fixture `DETAIL_BODY`。

> 这条更正的价值在于它示范了本项目的判断标准：一条能产出**看起来合法**的坏数据的
> 解析路径，比一条会明确报错的路径危险得多。同 §9.2 处理未知 `priceDisplayType` 的
> 方式是同一个道理 —— 宁可空手上报 + 告警，也不猜着解析。

### 9.5 重量 ⚠️ 顶层字段是废的

`result.data.productPackInfo.fields.unitWeight` 实测 **`0`** —— 别用。

真实数据按 SKU 分段，在
`result.data.productPackInfo.fields.pieceWeightScale.pieceWeightScaleInfo`，`Array(12)`：

```
{ volume: 0, sku1: "充电款风扇【随机1个】", length: 0, width: 0, weight: 120, skuId: 6046825856956, height: 0 }
```

| 字段 | 含义 |
|---|---|
| `skuId` | ✅ **用它与 `skuInfoMap[k].skuId` 关联**（同值） |
| `sku1` | 规格名 —— ⚠️ 键名可疑：单维度时叫 `sku1`，**多维度时是否变 `sku1`/`sku2` 未验证** |
| `weight` | **克**（120 = 120g，USB 小风扇合理） |
| `length` / `width` / `height` / `volume` | 本商品**全是 0** —— 不能假设有尺寸数据 |

### 9.6 ⚠️ 字符串/数字混用陷阱

同一份数据里 `beginAmount` 有**两种类型**：

| 路径 | 类型 |
|---|---|
| `priceModel.currentPrices[0].beginAmount` | **number** `1` |
| `priceModel.originalPrices[0].beginAmount` | **number** `1` |
| `mainPrice.fields.originalPricesWithoutPromotion[0].beginAmount` | **string** `"1"` |
| `orderParamModel.orderParam.skuParam.skuRangePrices[0].beginAmount` | **string** `"1"` |

**所有价格字段（`price` / `discountPrice`）也是字符串** —— `"2.90"`。

extractor 必须统一 `Number()` 并做 `Number.isFinite` 检查。直接用字符串做算术会得到
`NaN`，而 `NaN` 写进 SQLite 的 REAL 列会变成 `NULL` —— **静默丢数据，不报错**。

### 9.7 ⛔ 禁止采集字段（数据最小化）

| 路径 | 实际是什么 |
|---|---|
| `FE_GLOBALS.clientIP` | **采集者的出口 IP** |
| `FE_GLOBALS.loginId` | **采集者**的登录名 —— 见第 2 节的更正 |
| `dataJson.offerBaseInfo.buyerUserId` | 采集者用户 id |
| `dataJson.offerBaseInfo.buyerLoginId` | 采集者登录名（`amusement11`） |
| `dataJson.offerBaseInfo.buyerMemberId` | 采集者会员 id |
| `FE_GLOBALS.timestamp` | 空对象，无关 |

这五个都是**采集者本人**的标识，与所采商品无关。载荷里出现任何一个都应视为 bug。

### 9.8 商品属性 ✅ 探针 F 用「按值反查」定位到（三个来源，取最好的）

**来源 1（✅ 推荐）：`result.global.globalData.model.offerDetail.featureAttributes`**

`Array(19)`，每个元素：

```
{
  fid: 21594,
  name: "附加功能",          // ← 属性名
  value: "静音",             // ← 属性值
  values: ["静音"],
  decisionValues: ["静音"],
  vids: [4364278],
  isSpecial: false,
  itemCpvDecision: true,
  lectotype: false,
  outputType: 0
}
```

`name` + `value` 直接就是属性名值对，**用这个**。

**来源 2：`result.data.gallery.fields.CpvEnhance`**

```
{ decisionCpv: [{ name: "附加功能", values: ["静音"] }, …],
  normalCpv:   [{ name: "品牌", … }, { name: "货号", values: ["F001"] }, { name: "是否进口", … }] }
```

拆成 `decisionCpv` / `normalCpv` 两组，用的话要合并。

**来源 3：`result.global.globalData.model.tradeModel.offerIDatacenterSellInfo`**

属性名直接当对象键：`{ "附加功能": "静音", "材质": "塑料", … }`。
同处还有 `sellPointModel`（埋点串），别采。

⚠️ 路径是 `result.global.globalData.model…` —— **不是 `result.data`**，两者容易混。
⚠️ `result.data.productAttributes.fields` 只有 `uiType`/`label`，**是空的**，不要用。
⚠️ 属性挂在 `gallery`（图库）模块下 —— **别被模块名误导**，探针 A/C 都因此漏掉了它。

### 9.9 起批量（MOQ）✅ 探针 F 定位到

```
dataJson.orderParamModel.orderParam.beginNum : 1
```

**`beginNum` 就是起批量。** 同处其它字段：

| 字段 | 实测 | 含义 |
|---|---|---|
| `beginNum` | `1` | ✅ **起批量（MOQ）** |
| `saledCount` | `239397` | ✅ **销量，number** —— 优于 `productTitle.saleNum` 的 `"10万+"` |
| `canBookedAmount` | `55616455` | 可预订总量 |
| `skuParam.skuPriceType` | `"skuPrice"` | 再次确认价格模式（同 `priceDisplayType`） |
| `limitParam` | `{ limitType: "canExc", limitNum: 2 }` | ⚠️ **限购参数，不是 MOQ** |
| `supportOnePieceRetail` | `false` | 是否支持一件代发 |

⚠️ **别把 `limitParam.limitNum` 当成起批量。** 它是「限购 N 件」，
语义与「至少买 N 件」正好相反，而两者都挂在 `orderParam` 下，极易取错。

销量优先取 `orderParam.saledCount`（number `239397`），
`productTitle.saleNum` 的 `"10万+"` 只是展示文本，**无法直接转数字**。

---

## 10. 仍未着落的部分（**都不是首版阻塞项**）

- [x] ~~商品属性~~ → 见 §9.8（`featureAttributes`，19 条）
- [x] ~~MOQ / 起批量~~ → 见 §9.9（`orderParam.beginNum`）
- [ ] **`priceDisplayType` 数量阶梯模式的实际形状** —— 需要一个「按量定价」的商品才能采到。
      当前 `skuPrice` 模式已验证；遇到其它取值时 **extractor 应记 `extractorVersion` 并告警，
      而不是猜着解析**（防止把端点当阶梯，见 §9.2）
- [ ] **多规格维度的 SKU** —— 本商品只有 1 个维度，`skuProps` 长度 1。
      多维度时 `specValues` 怎么拼、重量表的 `sku1` 是否变 `sku1`/`sku2`，均未验证
- [ ] **未登录对照** —— 见 §7
