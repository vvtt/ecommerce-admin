/**
 * 扩展内部共享的 JSDoc 类型。
 *
 * 为什么要有这个文件：content script **不支持 ESM import**，main-world.js 与
 * isolated.js 是两个独立脚本，没法互相引用类型。但它们传递的是同一份载荷
 * （main-world 解析 → isolated 渲染），类型必须一致，否则浮层会静默读到
 * 不存在的字段。
 *
 * 这个 .d.ts 没有顶层 import/export 语句，所以是**全局声明**，
 * 两个 .js 里直接写 `@type {ExtractResult}` 即可，不需要 import。
 * 它不参与运行时，也不会被打进扩展的执行路径。
 *
 * 载荷类型一律从 src/types.ts 引 —— 那是前后端唯一的类型来源。
 * 这里只做「转出去」，不重新定义，免得两边漂移。
 */

/** 采集载荷。定义在 src/types.ts，后端用同一份做校验和入库 */
type CollectedOffer = import("../src/types").CollectedOffer;
type CollectedSku = import("../src/types").CollectedSku;
type SpecDimension = import("../src/types").SpecDimension;
type CollectedAttribute = import("../src/types").CollectedAttribute;
type PriceTier = import("../src/types").PriceTier;

/**
 * 供浮层展示的摘要。
 *
 * 刻意**不放进 src/types.ts** —— 它是界面细节，不上报后端，
 * 放进通用类型里会让后端以为这是接口契约的一部分。
 */
interface ExtractSummary {
  offerId: string;
  title: string;
  supplierName: string;
  moq?: number;
  priceMin?: number;
  priceMax?: number;
  skuCount: number;
  attributeCount: number;
  mainCount: number;
  detailCount: number;
  weightGram?: number;
  /** priceDisplayType 的实测值；取不到时为 "unknown" */
  priceMode: string;
}

/**
 * 解析结果。
 *
 * 写成**可判别联合**而不是 `{ ok: boolean; offer: CollectedOffer | null }`：
 * 后者在 `if (!result.ok) return` 之后，TS 仍然认为 `offer` 可能是 null，
 * 于是每个用到它的地方都要再加一次判空 —— 而那些多余的判空会掩盖真正的错误。
 */
type ExtractResult =
  | { ok: true; offer: CollectedOffer; summary: ExtractSummary; warnings: string[] }
  | { ok: false; offer: null; summary?: undefined; warnings: string[] };
