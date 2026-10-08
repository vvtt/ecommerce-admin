# Cross-Border Sourcing（跨境电商货源采集）

把跨境电商商品详情页（当前支持 1688）上的公开商品信息，**由你手动点一下**，采集到本项目自建的货源库。

仿照「跨境ERP助手」（妙手）那类插件的架构（content script 就地读页面已有数据 → 上报自己的后端），
但**没有复制它的任何代码**，也不上报给任何第三方 —— 数据只去你自己的 `localhost`。

---

## 装上

1. `chrome://extensions` → 右上角打开**开发者模式**
2. 「加载已解压的扩展程序」→ 选这个 `extension/` 目录
3. 先启动后端：在项目根目录 `npm run dev`
4. 点扩展图标 → 打开设置页 → 填入 **后端地址**（默认 `http://localhost:3000`）和 **采集 token**
5. 点「测试连接」，看到「连接正常」即可

### 采集 token 从哪来

后端第一次启动时会生成一个随机 token 并**打印在控制台**，同时也写进
`server/sourcing/collect-token.txt`。复制它填进设置页。

想固定下来就设环境变量 `SOURCING_COLLECT_TOKEN`，后端会优先用它。

---

## 用

打开任意 `https://detail.1688.com/offer/<offerId>.html`，页面右下角会出现浮层：

- 绿色的「已解析」= 字段齐了；黄色的「部分字段缺失」= 有字段没取到，浮层里会写是哪几个
- 浮层里先**核对一遍**标题、价格、起批量、SKU 数、图片数，确认没错
- 点**【采集到货源库】**。已采集过的商品按钮会变成**【更新已有记录】**
- 去后台 `/sourcing` 看结果

价格的「明细」在后台详情页；图片由**服务端**转存到本地，所以要等几秒才从 pending 变 ok。

---

## 合规边界

- **只处理你当前正在浏览的那一个页面**。不做批量遍历、不翻列表页、不自动跑。
- **必须你点按钮**才会上报。没有任何自动触发。
- **不修改页面行为**：不篡改请求、不改响应、不注入任何东西到页面功能里。
- **不碰 cookie**。不申请 `cookies` 权限，也不读 `document.cookie`。
- **只取公开可见信息**：商品标题/价格/SKU/图片/属性。

### 权限对比

| | 本扩展 | 妙手那类插件 |
|---|---|---|
| `host_permissions` | `*.1688.com` + 本地后端 | `<all_urls>` |
| `cookies` | ❌ 不申请 | ✅ |
| `webRequest` | ❌ 不申请 | ✅ |
| `scripting` | ❌ 不申请 | ✅ |

不申请 `cookies` 权限意味着扩展**在权限层面就调不到 `chrome.cookies`** ——
这是结构性保证，不是靠自己记得别去读。

### 不采集的东西

以下字段在 1688 页面上确实存在，但它们是**采集者本人**的标识，与所采商品无关，
因此 extractor 一律不读，后端也会在载荷里拒绝它们（400）：

| 字段 | 实际是什么 |
|---|---|
| `FE_GLOBALS.clientIP` | 你的出口 IP |
| `FE_GLOBALS.loginId` | **你**登录 1688 的账号名 —— 名字很像供应商，其实不是 |
| `offerBaseInfo.buyerUserId` / `buyerLoginId` / `buyerMemberId` | 你的账号标识 |

最后这条特别容易踩：`FE_GLOBALS.loginId` 与 `offerLoginId`（真正的供应商公司名）并排放在一起，
照名字字面理解就会把你自己的账号写进「供应商」列。详见 `docs/1688-probe.md` 第 2 节。

---

## 文件

```
manifest.json    MV3 清单。world:"MAIN" 需要 Chrome 111+
main-world.js    跑在页面自己的 JS 上下文里：解析 window.context → 归一化 → 发事件
isolated.js      跑在扩展的隔离世界：浮层 UI + 桥接 + 调 background
background.js    service worker：查重、上报后端、存配置。唯一碰后端的地方
options.html/js  设置页
types.d.ts       共享的 JSDoc 类型（content script 不支持 import，只能这样共享）
test/            冒烟测试
```

### 为什么是两个 content script

MAIN world 能读到页面的 `window.context`，但**拿不到任何 `chrome.*` API**；
ISOLATED world 反过来。所以两边各一个，用 DOM 事件通信。

事件名由 ISOLATED 侧生成随机 token 后传给 MAIN 侧，数据通道用 `__sc_data_<token>__`。

> ⚠️ 说清楚它**不是硬边界**：页面脚本与我们同处一个 JS 环境，能监听 `document` 上
> 的任何事件，也就能从握手事件里读到 token。它挡的是「随手写段脚本往后台灌数据」。
> 真正兜底的是后端那两道：`X-Collect-Token` 鉴权 + 载荷敏感字段校验。

### 为什么不用 `<script>` 注入

传统 `<script src>` 注入有两个缺陷：src 加载是异步的，实际执行会**晚于**页面自身脚本；
而且受页面 CSP 约束。`world: "MAIN"` 是官方支持的正道，不受页面 CSP 限制，
也不需要 `web_accessible_resources`。

---

## 1688 改版了怎么办

字段映射的唯一依据是 **`docs/1688-probe.md` 的 §9 表**，全部经过真机实测。

改版时的流程：

1. 在商品页 F12 控制台跑 `docs/probe-1688-fields.js`（探针 C），看哪些路径空了
   - 如果 `window.context` 直接是 `false`，**先跑 `docs/probe-1688-diag.js` 别急着下结论** ——
     广告落地页（URL 带 `src=zhanwai`/`sk=sem`）会先渲染一屏再跳转，跑太早会得到一份
     和「改版」长得一模一样的报告
2. 用 `docs/probe-1688-gaps.js`（探针 E）递归找新位置
3. 改 `main-world.js` 里对应的取数函数，**把 `EXTRACTOR_VERSION` 加一**
4. 跑 `npm run test:extension`，改 `test/extractor.smoke.mjs` 的 fixture 跟上新结构
5. `npm run lint:extension`

`EXTRACTOR_VERSION` 会跟着每条记录存进库，所以加一之后能筛出「用旧版解析的、
可能需要重采」的记录。库里的 `raw_json` 保留了采集时的原始载荷，可以离线重解析。

### ⚠️ 表里那几条「会静默写错数据」的坑

改 extractor 前**务必先读 `docs/1688-probe.md` §9.2 / §9.4 / §9.6**。这几条都验证过：

- `skuPriceScale` 是**区间字符串** `"2.21-5.37"`，不是阶梯数组。当数组取 `[0]` 会得到字符 `"2"`
- `onePiecePrice` 是**布尔**（是否支持一件代发），不是价格
- `priceDisplayType: "skuPrice"` 时，`currentPrices` 是 **[最低价, 最高价] 两个端点**，
  `beginAmount` 恒为 1 —— **不是数量阶梯**。当成两档批发价存进去，列表页看不出问题，
  只有详情页会凭空多出两档
- 库存字段是 `canBookCount`，不是 `amount`
- 起批量是 `orderParam.beginNum`，不是隔壁的 `limitParam.limitNum`（那是限购）
- 所有价格字段都是**字符串**，`beginAmount` 在不同路径下字符串/数字混用。
  忘了 `Number()` 会得到 `NaN`，而 **`NaN` 写进 SQLite 的 REAL 列会变成 NULL，不报错**
- 详情长图接口（`itemcdn.tmall.com`）**返回的不是 HTML，是一段 JS**：
  `var offer_details={"content":"<img src=\"https://…\"/>"}`。
  图片 HTML 在 JSON 的 `content` 里，且引号是**被 JS 转义过的** `\"`。
  直接喂 `DOMParser` 会得到 `\"https://…\"` 这样的属性值，再被补 host 那一步拼成
  `https://cbu01.alicdn.com/\"https://…\"` —— **形似而必然 404**。
  首版就栽在这，15 张详情图全挂却毫无报错（浮层和后端都沉默）。详见 §9.4 的更正

遇到**没实测过的** `priceDisplayType` 取值时，extractor 会发空阶梯价 **+ 明确告警**，
而不是猜着解析。这是有意的 —— 见 `main-world.js` 里 `extractPriceLadder` 的注释。

---

## 开发

```bash
npm run lint:extension    # tsc -p extension --noEmit（checkJs，类型对齐 src/types.ts）
npm run test:extension    # 两个冒烟测试，共 105 项断言
```

两个测试各有分工：

**`test/extractor.smoke.mjs`（65 项）** —— 拿一份 fixture 喂 `main-world.js`，
断言解析出的 `CollectedOffer` 每个字段都对。fixture 是**照 §9 的表手工搭的**，
不是从 extractor 反推的 —— 它验的是「extractor 有没有按表去读」，
**不验「表本身对不对」**。表对不对只能靠真机页面。

其中包含 §9.7 的守卫断言：载荷里**不得出现**采集者的登录名、IP、buyer\* 字段。

详情长图的 fixture（`DETAIL_BODY`）是**照实测响应逐字节抄的**，`\"` 必须原样保留
—— 把它改写成普通引号，就等于把那个「详情图全 404」的坑从测试里抹掉。
同理，测试里的 `DOMParser` 桩**不做任何 JS 反转义**：真浏览器就是这样，
桩比真浏览器善良的话，这个坑就永远测不出来。

**`test/bridge.smoke.mjs`（40 项）** —— 把 `chrome.*` 用最小桩接起来，
让 `isolated.js → background.js` 真的跑一遍：推一个解析结果进去 → 断言浮层渲染出的
HTML → 点「采集」→ 断言 `background` 发出的 POST（URL / 方法 / token 头 / 载荷）。
另外覆盖后端挂掉、没配 token、401 三种失败的提示文案。

> 这两个测试都不验真实 Chrome 行为与网络 —— 那部分只能在浏览器里联调。

改完代码在 `chrome://extensions` 点一下刷新，**再刷新 1688 页面**（content script 不会热更新）。

---

## 与计划的一处偏离

计划里写的是 `permissions: ["storage", "activeTab"]`，实际**只申请了 `storage`**。

`activeTab` 是为「用户主动调用扩展时临时获得当前标签页访问权」设计的，
而这个扩展的 content script 是**静态声明**的，靠 `host_permissions` 就够注入了，
设置页也是普通扩展页面 —— 两处都用不到 `activeTab`。既然用不到就申请，
与这个项目「数据最小化」的取向冲突。

另外 `host_permissions` 里本地后端写的是 `http://localhost/*` 而不是
`http://localhost:3000/*`：Chrome 的匹配模式**不支持写端口，端口是通配的**，
所以 `http://localhost/*` 覆盖 3000 和任何其它端口。后端换端口不用改 manifest。

> 部署到真实域名时，要把那个域名加进 `host_permissions` 并重新加载扩展 ——
> 否则 service worker 的 fetch 会被跨域拦掉。设置页里也写了这条提醒。
