/**
 * 内存数据库 —— 种子数据 + 可变状态。前后端共用。
 *
 * 服务端把它当作权威数据源；前端在 Express 接口不可达时（例如只跑了
 * `vite preview`）直接用同一个模块兜底，因此离线状态下的查询与写入
 * 行为与在线完全一致 —— 见 shared/queries.ts 与 src/lib/api.ts。
 *
 * 种子用紧凑元组定义、模块加载时展开为强类型对象，避免几百行对象字面量。
 * 库存记录、流水、采购单由 SKU 确定性派生（seedNum 哈希），因此同一个 SKU
 * 每次启动拿到的库存都一样，方便复现问题。
 *
 * 注意：本文件不得引入任何 Node 专有 API（fs / path 等），否则无法打包进浏览器。
 */
import type {
  Category,
  ChannelStatus,
  InventoryRecord,
  MovementType,
  Product,
  ProductAttribute,
  ProductChannel,
  ProductStatus,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseStatus,
  Sku,
  StockMovement,
  WarehouseCode,
} from "../src/types";
import { CHANNEL_CODES, OPERATORS } from "../src/lib/labels";

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** FNV-1a 哈希，用于从字符串派生稳定的伪随机数 */
function seedNum(key: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % modulo;
}

const NOW = Date.now();
const DAY = 86_400_000;

const isoDaysAgo = (days: number, hourOffset = 0) =>
  new Date(NOW - days * DAY + hourOffset * 3_600_000).toISOString();

const isoDaysAhead = (days: number) => new Date(NOW + days * DAY).toISOString();

const productImage = (seed: string, size = 400) =>
  `https://picsum.photos/seed/${seed}/${size}/${size}`;

/* ------------------------------------------------------------------ *
 * 类目
 * ------------------------------------------------------------------ */

interface CategorySeed {
  id: string;
  name: string;
  nameEn: string;
  commissionRate: number;
  children: { id: string; name: string; nameEn: string; commissionRate: number }[];
}

const CATEGORY_SEED: CategorySeed[] = [
  {
    id: "c1",
    name: "3C数码配件",
    nameEn: "3C & Electronics",
    commissionRate: 8,
    children: [
      { id: "c1-1", name: "手机配件", nameEn: "Phone Accessories", commissionRate: 10 },
      { id: "c1-2", name: "音频设备", nameEn: "Audio Devices", commissionRate: 9 },
      { id: "c1-3", name: "充电储能", nameEn: "Charging & Power", commissionRate: 11 },
    ],
  },
  {
    id: "c2",
    name: "家居厨房",
    nameEn: "Home & Kitchen",
    commissionRate: 12,
    children: [
      { id: "c2-1", name: "厨房用具", nameEn: "Kitchen Tools", commissionRate: 13 },
      { id: "c2-2", name: "收纳整理", nameEn: "Storage & Organizing", commissionRate: 12 },
    ],
  },
  {
    id: "c3",
    name: "户外运动",
    nameEn: "Outdoor & Sports",
    commissionRate: 10,
    children: [
      { id: "c3-1", name: "露营装备", nameEn: "Camping Gear", commissionRate: 10 },
      { id: "c3-2", name: "骑行配件", nameEn: "Cycling Accessories", commissionRate: 11 },
    ],
  },
  {
    id: "c4",
    name: "美妆个护",
    nameEn: "Beauty & Personal Care",
    commissionRate: 15,
    children: [
      { id: "c4-1", name: "面部护理", nameEn: "Facial Care", commissionRate: 16 },
      { id: "c4-2", name: "美发工具", nameEn: "Hair Styling Tools", commissionRate: 14 },
    ],
  },
  {
    id: "c5",
    name: "宠物用品",
    nameEn: "Pet Supplies",
    commissionRate: 12,
    children: [
      { id: "c5-1", name: "宠物玩具", nameEn: "Pet Toys", commissionRate: 12 },
      { id: "c5-2", name: "宠物清洁", nameEn: "Pet Grooming", commissionRate: 13 },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

interface ProductSeed {
  spu: string;
  title: string;
  titleEn: string;
  categoryId: string;
  brand: string;
  status: ProductStatus;
  specName: string;
  attributes: [string, string][];
  tags: string[];
  /** [规格值, 售价USD, 成本CNY, 重量g] */
  skus: [string, number, number, number][];
}

const PRODUCT_SEED: ProductSeed[] = [
  {
    spu: "SPU-10001",
    title: "主动降噪无线蓝牙耳机 Pro",
    titleEn: "Active Noise Cancelling Wireless Earbuds Pro",
    categoryId: "c1-2",
    brand: "Aurelia",
    status: "on_sale",
    specName: "颜色",
    attributes: [
      ["蓝牙版本", "5.4"],
      ["续航", "单次 8h / 配合充电仓 32h"],
      ["防水等级", "IPX5"],
      ["充电口", "Type-C"],
    ],
    tags: ["爆款", "Amazon Choice"],
    skus: [
      ["午夜黑", 59.99, 168, 52],
      ["珍珠白", 59.99, 168, 52],
      ["雾霾蓝", 64.99, 172, 52],
    ],
  },
  {
    spu: "SPU-10002",
    title: "65W 氮化镓多口快充充电器",
    titleEn: "65W GaN Multi-Port Fast Charger",
    categoryId: "c1-3",
    brand: "Lumo",
    status: "on_sale",
    specName: "插头规格",
    attributes: [
      ["总功率", "65W"],
      ["接口", "2×USB-C + 1×USB-A"],
      ["协议", "PD3.0 / QC4+ / PPS"],
      ["折叠插脚", "是"],
    ],
    tags: ["热销"],
    skus: [
      ["美规 US", 32.99, 96, 128],
      ["欧规 EU", 32.99, 96, 130],
      ["英规 UK", 34.99, 99, 138],
    ],
  },
  {
    spu: "SPU-10003",
    title: "磁吸无线充电宝 10000mAh",
    titleEn: "Magnetic Wireless Power Bank 10000mAh",
    categoryId: "c1-3",
    brand: "Lumo",
    status: "on_sale",
    specName: "颜色",
    attributes: [
      ["容量", "10000mAh / 37Wh"],
      ["无线输出", "15W 磁吸"],
      ["有线输出", "20W PD"],
      ["过安检", "可随身登机"],
    ],
    tags: ["新品", "TikTok 爆款"],
    skus: [
      ["石墨黑", 45.99, 132, 215],
      ["月光银", 45.99, 132, 215],
    ],
  },
  {
    spu: "SPU-10004",
    title: "铝合金磁吸手机支架",
    titleEn: "Aluminum Magnetic Phone Stand",
    categoryId: "c1-1",
    brand: "Nordvik",
    status: "off_shelf",
    specName: "颜色",
    attributes: [
      ["材质", "6063 铝合金"],
      ["适配", "MagSafe 及磁吸壳"],
      ["调节角度", "0-90°"],
    ],
    tags: ["清库存"],
    skus: [
      ["深空灰", 19.99, 46, 96],
      ["银色", 19.99, 46, 96],
    ],
  },
  {
    spu: "SPU-10005",
    title: "德国不锈钢厨房刀具套装",
    titleEn: "German Stainless Steel Kitchen Knife Set",
    categoryId: "c2-1",
    brand: "Verdant",
    status: "on_sale",
    specName: "套装规格",
    attributes: [
      ["钢材", "5Cr15MoV 不锈钢"],
      ["刀柄", "防滑 ABS"],
      ["可洗碗机", "是"],
    ],
    tags: ["家居热销"],
    skus: [
      ["五件套", 39.99, 118, 860],
      ["七件套", 54.99, 158, 1180],
    ],
  },
  {
    spu: "SPU-10006",
    title: "食品级硅胶折叠沥水篮",
    titleEn: "Food-Grade Collapsible Silicone Colander",
    categoryId: "c2-1",
    brand: "Verdant",
    status: "on_sale",
    specName: "尺寸",
    attributes: [
      ["材质", "食品级硅胶 + PP"],
      ["耐温", "-40°C ~ 230°C"],
      ["折叠后高度", "3.5cm"],
    ],
    tags: ["小件轻货"],
    skus: [
      ["中号 M", 16.99, 38, 240],
      ["大号 L", 21.99, 48, 310],
    ],
  },
  {
    spu: "SPU-10007",
    title: "真空保鲜收纳盒三件组",
    titleEn: "Vacuum Food Storage Container Set",
    categoryId: "c2-2",
    brand: "Verdant",
    status: "draft",
    specName: "容量",
    attributes: [
      ["材质", "Tritan 共聚酯"],
      ["密封", "真空泵抽气"],
      ["可微波", "是"],
    ],
    tags: ["待上架"],
    skus: [
      ["500ml", 24.99, 62, 320],
      ["1000ml", 29.99, 76, 420],
      ["1500ml", 34.99, 88, 510],
    ],
  },
  {
    spu: "SPU-10008",
    title: "便携露营折叠椅 承重150kg",
    titleEn: "Portable Folding Camping Chair 150kg Capacity",
    categoryId: "c3-1",
    brand: "Peakline",
    status: "on_sale",
    specName: "颜色",
    attributes: [
      ["承重", "150kg"],
      ["支架", "航空级铝合金"],
      ["面料", "600D 牛津布"],
      ["自重", "1.2kg"],
    ],
    tags: ["Amazon Choice", "大件"],
    skus: [
      ["军绿", 42.99, 128, 1250],
      ["卡其", 42.99, 128, 1250],
      ["深灰", 44.99, 132, 1250],
    ],
  },
  {
    spu: "SPU-10009",
    title: "户外防水登山背包 防撕裂尼龙",
    titleEn: "Waterproof Hiking Backpack Ripstop Nylon",
    categoryId: "c3-1",
    brand: "Peakline",
    status: "on_sale",
    specName: "容量",
    attributes: [
      ["面料", "210D 防撕裂尼龙"],
      ["防水", "PU 涂层 + 防雨罩"],
      ["背负", "透气网眼减压系统"],
    ],
    tags: ["海外仓主推"],
    skus: [
      ["30L", 49.99, 142, 780],
      ["40L", 59.99, 168, 920],
      ["55L", 69.99, 196, 1080],
    ],
  },
  {
    spu: "SPU-10010",
    title: "USB 充电自行车前后灯套装",
    titleEn: "USB Rechargeable Bike Front & Rear Light Set",
    categoryId: "c3-2",
    brand: "Peakline",
    status: "on_sale",
    specName: "规格",
    attributes: [
      ["亮度", "前灯 800 流明"],
      ["续航", "最长 12 小时"],
      ["防水", "IPX6"],
      ["安装", "免工具快拆"],
    ],
    tags: ["季节品"],
    skus: [
      ["前灯单只", 18.99, 44, 110],
      ["后灯单只", 12.99, 30, 62],
      ["前后套装", 27.99, 68, 172],
    ],
  },
  {
    spu: "SPU-10011",
    title: "玻尿酸深层保湿精华液",
    titleEn: "Hyaluronic Acid Deep Hydrating Serum",
    categoryId: "c4-1",
    brand: "Mireu",
    status: "on_sale",
    specName: "容量",
    attributes: [
      ["核心成分", "三重分子玻尿酸"],
      ["适用肤质", "全肤质"],
      ["保质期", "3 年"],
      ["认证", "FDA 备案 / CPNP"],
    ],
    tags: ["高毛利", "美妆主推"],
    skus: [
      ["30ml", 28.99, 42, 86],
      ["50ml", 39.99, 58, 128],
    ],
  },
  {
    spu: "SPU-10012",
    title: "负离子速干护发电吹风",
    titleEn: "Ionic Fast-Dry Hair Dryer",
    categoryId: "c4-2",
    brand: "Mireu",
    status: "on_sale",
    specName: "插头规格",
    attributes: [
      ["功率", "1800W"],
      ["风速档位", "3 档风速 / 3 档温度"],
      ["负离子", "5000 万/cm³"],
      ["配件", "集风嘴 + 扩散风罩"],
    ],
    tags: ["美妆主推"],
    skus: [
      ["美规 US", 54.99, 156, 620],
      ["欧规 EU", 54.99, 156, 620],
    ],
  },
  {
    spu: "SPU-10013",
    title: "自动逗猫激光玩具 智能感应",
    titleEn: "Automatic Cat Laser Toy with Smart Sensor",
    categoryId: "c5-1",
    brand: "Pawfect",
    status: "on_sale",
    specName: "版本",
    attributes: [
      ["供电", "USB 充电 / 4×AA 电池"],
      ["模式", "随机轨迹 / 定时 15 分钟"],
      ["材质", "ABS 环保塑料"],
    ],
    tags: ["宠物爆款"],
    skus: [
      ["标准版", 22.99, 54, 280],
      ["充电版", 29.99, 72, 300],
    ],
  },
  {
    spu: "SPU-10014",
    title: "宠物去浮毛梳理梳",
    titleEn: "Pet Deshedding Grooming Brush",
    categoryId: "c5-2",
    brand: "Pawfect",
    status: "on_sale",
    specName: "尺寸",
    attributes: [
      ["刀头", "不锈钢细齿"],
      ["一键退毛", "支持"],
      ["适用", "猫 / 中小型犬"],
    ],
    tags: ["高频复购"],
    skus: [
      ["小号", 13.99, 32, 140],
      ["大号", 16.99, 39, 186],
    ],
  },
  {
    spu: "SPU-10015",
    title: "宠物免洗泡沫清洁手套",
    titleEn: "Pet No-Rinse Foam Cleaning Gloves",
    categoryId: "c5-2",
    brand: "Pawfect",
    status: "off_shelf",
    specName: "香型",
    attributes: [
      ["成分", "植物提取温和配方"],
      ["规格", "6 只 / 盒"],
      ["适用", "猫犬通用"],
    ],
    tags: ["待整改"],
    skus: [
      ["无香型", 11.99, 26, 190],
      ["薰衣草", 12.99, 28, 190],
    ],
  },
  {
    spu: "SPU-10016",
    title: "降噪记忆棉睡眠耳塞",
    titleEn: "Noise Cancelling Memory Foam Earplugs",
    categoryId: "c1-2",
    brand: "Aurelia",
    status: "on_sale",
    specName: "规格",
    attributes: [
      ["降噪值", "NRR 32dB"],
      ["材质", "慢回弹记忆棉"],
      ["可水洗", "是"],
    ],
    tags: ["旅行必备"],
    skus: [
      ["3 对装", 9.99, 18, 26],
      ["6 对装", 14.99, 27, 48],
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 采购单
 * ------------------------------------------------------------------ */

interface PurchaseSeed {
  poNo: string;
  supplier: string;
  warehouse: WarehouseCode;
  status: PurchaseStatus;
  expectedInDays: number;
  createdDaysAgo: number;
  operatorIndex: number;
  remark: string;
  /** [sku编码, 数量, 单价CNY, 已收货数量] */
  items: [string, number, number, number][];
}

const PURCHASE_SEED: PurchaseSeed[] = [
  {
    poNo: "PO-20260301-001",
    supplier: "深圳市恒通电子有限公司",
    warehouse: "us_west",
    status: "shipping",
    expectedInDays: 12,
    createdDaysAgo: 18,
    operatorIndex: 0,
    remark: "美西仓 Q2 备货，走海运整柜",
    items: [
      ["SPU-10001-1", 600, 165, 600],
      ["SPU-10002-1", 400, 94, 400],
      ["SPU-10003-1", 300, 130, 300],
    ],
  },
  {
    poNo: "PO-20260305-002",
    supplier: "宁波奥翔户外用品有限公司",
    warehouse: "us_west",
    status: "approved",
    expectedInDays: 20,
    createdDaysAgo: 11,
    operatorIndex: 1,
    remark: "露营季前补货",
    items: [
      ["SPU-10008-1", 250, 126, 0],
      ["SPU-10009-1", 180, 166, 0],
      ["SPU-10010-3", 500, 66, 0],
    ],
  },
  {
    poNo: "PO-20260308-003",
    supplier: "广州美研化妆品科技有限公司",
    warehouse: "de_central",
    status: "received",
    expectedInDays: -3,
    createdDaysAgo: 32,
    operatorIndex: 2,
    remark: "德国仓美妆线首单，已完成入库",
    items: [
      ["SPU-10011-1", 800, 41, 800],
      ["SPU-10012-1", 350, 154, 350],
    ],
  },
  {
    poNo: "PO-20260312-004",
    supplier: "义乌市博远家居用品厂",
    warehouse: "cn_main",
    status: "pending",
    expectedInDays: 9,
    createdDaysAgo: 4,
    operatorIndex: 3,
    remark: "等采购主管审核",
    items: [
      ["SPU-10005-1", 700, 116, 0],
      ["SPU-10006-1", 1200, 37, 0],
      ["SPU-10007-1", 900, 61, 0],
    ],
  },
  {
    poNo: "PO-20260315-005",
    supplier: "东莞市宠乐宠物用品厂",
    warehouse: "us_west",
    status: "draft",
    expectedInDays: 25,
    createdDaysAgo: 1,
    operatorIndex: 4,
    remark: "草稿，待确认数量后提交",
    items: [
      ["SPU-10013-1", 500, 53, 0],
      ["SPU-10014-1", 800, 31, 0],
    ],
  },
  {
    poNo: "PO-20260225-006",
    supplier: "深圳市恒通电子有限公司",
    warehouse: "cn_main",
    status: "received",
    expectedInDays: -12,
    createdDaysAgo: 40,
    operatorIndex: 0,
    remark: "国内仓补货，已全部入库",
    items: [
      ["SPU-10001-1", 1500, 166, 1500],
      ["SPU-10016-2", 3000, 17, 3000],
    ],
  },
  {
    poNo: "PO-20260310-007",
    supplier: "宁波奥翔户外用品有限公司",
    warehouse: "de_central",
    status: "cancelled",
    expectedInDays: 15,
    createdDaysAgo: 25,
    operatorIndex: 1,
    remark: "供应商产能不足，取消",
    items: [["SPU-10009-2", 200, 164, 0]],
  },
  {
    poNo: "PO-20260318-008",
    supplier: "广州美研化妆品科技有限公司",
    warehouse: "cn_main",
    status: "approved",
    expectedInDays: 7,
    createdDaysAgo: 2,
    operatorIndex: 2,
    remark: "精华液旺季备货",
    items: [["SPU-10011-2", 1200, 43, 0]],
  },
];

/* ------------------------------------------------------------------ *
 * 库存流水
 * ------------------------------------------------------------------ */

/** [SKU编码, 仓库, 类型, 变动数量, 几天前, 关联单号, 操作人序号, 备注] */
type MovementSeed = [string, WarehouseCode, MovementType, number, number, string, number, string];

const MOVEMENT_SEED: MovementSeed[] = [
  ["SPU-10001-1", "cn_main", "inbound", 600, 40, "PO-20260225-006", 0, "采购入库"],
  ["SPU-10001-2", "cn_main", "inbound", 500, 40, "PO-20260225-006", 0, "采购入库"],
  ["SPU-10001-1", "us_west", "inbound", 600, 18, "PO-20260301-001", 0, "海运到仓"],
  ["SPU-10001-1", "us_west", "outbound", -180, 12, "AMZ-2603-88431", 4, "Amazon 订单出库"],
  ["SPU-10001-3", "us_west", "outbound", -96, 9, "AMZ-2603-88502", 4, "Amazon 订单出库"],
  ["SPU-10001-3", "us_west", "return", 12, 6, "RTN-2603-0117", 3, "客户退货可售"],
  ["SPU-10002-1", "us_west", "inbound", 400, 18, "PO-20260301-001", 0, "海运到仓"],
  ["SPU-10002-1", "us_west", "outbound", -142, 10, "SHF-2603-2201", 4, "Shopify 订单出库"],
  ["SPU-10002-2", "de_central", "outbound", -88, 8, "AMZ-2603-91004", 2, "Amazon DE 出库"],
  ["SPU-10002-3", "de_central", "adjust", -6, 5, "ADJ-2603-0031", 3, "盘点差异，包装破损"],
  ["SPU-10003-1", "us_west", "inbound", 300, 18, "PO-20260301-001", 0, "海运到仓"],
  ["SPU-10003-1", "us_west", "outbound", -210, 7, "TTS-2603-5520", 1, "TikTok 直播出库"],
  ["SPU-10003-2", "cn_main", "outbound", -160, 6, "TTS-2603-5531", 1, "TikTok 直播出库"],
  ["SPU-10005-1", "cn_main", "inbound", 700, 4, "PO-20260312-004", 3, "待入库"],
  ["SPU-10006-1", "cn_main", "outbound", -320, 11, "AMZ-2603-86990", 4, "Amazon 订单出库"],
  ["SPU-10008-1", "us_west", "outbound", -64, 13, "AMZ-2603-85112", 4, "Amazon 订单出库"],
  ["SPU-10008-2", "us_west", "outbound", -58, 13, "AMZ-2603-85120", 4, "Amazon 订单出库"],
  ["SPU-10009-2", "us_west", "adjust", 4, 4, "ADJ-2603-0044", 3, "盘点盈余"],
  ["SPU-10010-3", "de_central", "inbound", 500, 30, "PO-20260308-003", 2, "空运到仓"],
  ["SPU-10011-1", "de_central", "inbound", 800, 30, "PO-20260308-003", 2, "空运到仓"],
  ["SPU-10011-1", "de_central", "outbound", -265, 8, "AMZ-2603-90877", 2, "Amazon DE 出库"],
  ["SPU-10011-2", "cn_main", "outbound", -190, 5, "SHF-2603-2288", 1, "Shopify 订单出库"],
  ["SPU-10012-1", "de_central", "inbound", 350, 30, "PO-20260308-003", 2, "空运到仓"],
  ["SPU-10012-2", "cn_main", "return", 8, 3, "RTN-2603-0121", 3, "客户退货，外观瑕疵转次品"],
  ["SPU-10013-1", "us_west", "outbound", -175, 6, "TTS-2603-5610", 1, "TikTok 直播出库"],
  ["SPU-10014-2", "cn_main", "outbound", -410, 9, "AMZ-2603-87344", 4, "Amazon 订单出库"],
  ["SPU-10016-2", "cn_main", "inbound", 3000, 40, "PO-20260225-006", 0, "采购入库"],
  ["SPU-10016-2", "cn_main", "outbound", -1240, 7, "AMZ-2603-88120", 4, "Amazon 订单出库"],
];

/* ------------------------------------------------------------------ *
 * 展开种子
 * ------------------------------------------------------------------ */

function buildCategories(): Category[] {
  const flat: Category[] = [];
  for (const top of CATEGORY_SEED) {
    flat.push({
      id: top.id,
      name: top.name,
      nameEn: top.nameEn,
      parentId: null,
      level: 1,
      productCount: 0,
      commissionRate: top.commissionRate,
    });
    for (const child of top.children) {
      flat.push({
        id: child.id,
        name: child.name,
        nameEn: child.nameEn,
        parentId: top.id,
        level: 2,
        productCount: 0,
        commissionRate: child.commissionRate,
      });
    }
  }
  return flat;
}

function buildChannels(spu: string, status: ProductStatus): ProductChannel[] {
  return CHANNEL_CODES.map((code) => {
    let st: ChannelStatus;
    if (status === "draft") {
      st = "not_listed";
    } else {
      const r = seedNum(`${spu}:${code}`, 10);
      st = r < 5 ? "listed" : r < 7 ? "pending" : r < 8 ? "rejected" : "not_listed";
    }
    return {
      code,
      status: st,
      listingId: st === "listed" ? `${code.slice(0, 3).toUpperCase()}${seedNum(spu + code, 900000) + 100000}` : undefined,
      lastSyncedAt: st === "listed" ? isoDaysAgo(seedNum(spu + code, 6)) : undefined,
    };
  });
}

function buildProducts(): Product[] {
  return PRODUCT_SEED.map((seed, pIdx) => {
    const productId = seed.spu;
    const skus: Sku[] = seed.skus.map(([specValue, price, cost, weight], sIdx) => ({
      id: `${seed.spu}-${sIdx + 1}`,
      skuCode: `${seed.spu}-${sIdx + 1}`,
      productId,
      specValues: { [seed.specName]: specValue },
      barcode: `69${String(seedNum(`${seed.spu}${sIdx}`, 9_000_000_000) + 1_000_000_000)}`,
      price,
      costPrice: cost,
      weightGram: weight,
      image: productImage(`${seed.spu}-${sIdx + 1}`, 200),
      stock: 0, // 由库存记录回填
      lockedStock: 0,
      safetyStock: 30 + seedNum(`${seed.spu}-${sIdx + 1}:safe`, 60),
    }));

    const attributes: ProductAttribute[] = seed.attributes.map(([name, value]) => ({ name, value }));

    return {
      id: productId,
      spu: seed.spu,
      title: seed.title,
      titleEn: seed.titleEn,
      categoryId: seed.categoryId,
      brand: seed.brand,
      mainImage: productImage(seed.spu, 400),
      status: seed.status,
      attributes,
      tags: seed.tags,
      channels: buildChannels(seed.spu, seed.status),
      skus,
      createdAt: isoDaysAgo(60 - pIdx * 3),
      updatedAt: isoDaysAgo(seedNum(seed.spu + ":upd", 20)),
      operator: OPERATORS[seedNum(seed.spu + ":op", OPERATORS.length)],
    };
  });
}

/**
 * 按 SKU × 仓库派生库存记录。
 * 国内主仓每个 SKU 都备货；海外仓只备约 2/3 的 SKU，贴近真实跨境备货策略。
 */
function buildInventory(products: Product[]): InventoryRecord[] {
  const records: InventoryRecord[] = [];

  for (const product of products) {
    for (const sku of product.skus) {
      for (const warehouse of ["cn_main", "us_west", "de_central"] as WarehouseCode[]) {
        const key = `${sku.skuCode}:${warehouse}`;
        const stocked = warehouse === "cn_main" || seedNum(`${key}:has`, 3) > 0;
        if (!stocked) continue;

        const isOutlier = seedNum(`${key}:out`, 14) === 0;
        const base = 40 + seedNum(`${key}:base`, 260);
        const onHand = isOutlier ? 0 : base;
        const lockCeil = Math.max(1, Math.round(onHand * 0.35));
        const locked = onHand === 0 ? 0 : seedNum(`${key}:lock`, lockCeil);
        const safetyStock = 30 + seedNum(`${sku.skuCode}:safe`, 60);

        records.push({
          id: `${sku.skuCode}@${warehouse}`,
          skuId: sku.id,
          skuCode: sku.skuCode,
          productId: product.id,
          productTitle: product.title,
          specText: Object.values(sku.specValues).join(" / "),
          image: sku.image ?? product.mainImage,
          warehouse,
          onHand,
          locked,
          available: onHand - locked,
          safetyStock,
          health: "normal", // 由 refreshDerived() 统一重算
          lastInboundAt: isoDaysAgo(seedNum(`${key}:in`, 45)),
          updatedAt: isoDaysAgo(seedNum(`${key}:upd`, 10)),
        });
      }
    }
  }

  return records;
}

function buildMovements(): StockMovement[] {
  const productBySku = new Map<string, Product>();
  for (const p of db.products) {
    for (const s of p.skus) productBySku.set(s.skuCode, p);
  }

  return MOVEMENT_SEED.map((seed, idx) => {
    const [skuCode, warehouse, type, quantity, daysAgo, refNo, opIdx, remark] = seed;
    const product = productBySku.get(skuCode);
    const sku = product?.skus.find((s) => s.skuCode === skuCode);
    const beforeQty = 60 + seedNum(`${skuCode}:${refNo}:before`, 340);
    return {
      id: `MV-${String(idx + 1).padStart(4, "0")}`,
      skuCode,
      productTitle: product?.title ?? "—",
      specText: sku ? Object.values(sku.specValues).join(" / ") : "—",
      warehouse,
      type,
      quantity,
      beforeQty,
      afterQty: beforeQty + quantity,
      refNo,
      operator: OPERATORS[opIdx % OPERATORS.length],
      remark,
      createdAt: isoDaysAgo(daysAgo, seedNum(refNo, 12)),
    };
  }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function buildPurchaseOrders(): PurchaseOrder[] {
  const findSku = (skuCode: string) => {
    for (const product of db.products) {
      const sku = product.skus.find((s) => s.skuCode === skuCode);
      if (sku) return { sku, product };
    }
    return undefined;
  };

  return PURCHASE_SEED.map((seed) => {
    const items: PurchaseOrderItem[] = seed.items.map(([skuCode, quantity, unitCost, receivedQty], iIdx) => {
      const entry = findSku(skuCode);
      return {
        id: `${seed.poNo}-${iIdx + 1}`,
        skuId: entry?.sku.id ?? "—",
        skuCode,
        productTitle: entry?.product.title ?? "—",
        specText: entry ? Object.values(entry.sku.specValues).join(" / ") : "—",
        quantity,
        receivedQty,
        unitCost,
        amount: quantity * unitCost,
      };
    });

    return {
      id: seed.poNo,
      poNo: seed.poNo,
      supplier: seed.supplier,
      warehouse: seed.warehouse,
      status: seed.status,
      items,
      totalAmount: items.reduce((sum, i) => sum + i.amount, 0),
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      currency: "CNY",
      expectedAt: isoDaysAhead(seed.expectedInDays),
      operator: OPERATORS[seed.operatorIndex % OPERATORS.length],
      remark: seed.remark,
      createdAt: isoDaysAgo(seed.createdDaysAgo),
      updatedAt: isoDaysAgo(Math.max(0, seed.createdDaysAgo - seedNum(seed.poNo, 3))),
    };
  });
}

/* ------------------------------------------------------------------ *
 * 内存数据库
 * ------------------------------------------------------------------ */

export const db = {
  categories: [] as Category[],
  products: [] as Product[],
  inventory: [] as InventoryRecord[],
  movements: [] as StockMovement[],
  purchaseOrders: [] as PurchaseOrder[],
};

/** 重算库存派生字段：available / health，以及 SKU 上的库存汇总 */
export function refreshDerived(): void {
  for (const rec of db.inventory) {
    rec.available = rec.onHand - rec.locked;
    rec.health = rec.onHand === 0 ? "out" : rec.available < rec.safetyStock ? "low" : "normal";
  }

  for (const product of db.products) {
    for (const sku of product.skus) {
      const rows = db.inventory.filter((r) => r.skuId === sku.id);
      sku.stock = rows.reduce((sum, r) => sum + r.onHand, 0);
      sku.lockedStock = rows.reduce((sum, r) => sum + r.locked, 0);
    }
  }

  // 类目商品数：二级类目算自己，一级类目累加子类目
  for (const cat of db.categories) {
    if (cat.level === 2) {
      cat.productCount = db.products.filter((p) => p.categoryId === cat.id).length;
    }
  }
  for (const cat of db.categories) {
    if (cat.level === 1) {
      cat.productCount = db.categories
        .filter((c) => c.parentId === cat.id)
        .reduce((sum, c) => sum + c.productCount, 0);
    }
  }
}

function init(): void {
  db.categories = buildCategories();
  db.products = buildProducts();
  db.inventory = buildInventory(db.products);
  db.movements = buildMovements();
  db.purchaseOrders = buildPurchaseOrders();
  refreshDerived();
}

init();
