/**
 * APP 链接自动采集 → 妙手 ERP（2026-10-28 新增，同日多次演进后按用户要求
 * 最终回归「按钮点击」方式：开 1688 详情页 → 点妙手插件采集条的「采集此商品」）
 *
 * 为什么不直连 push_collect_box 接口（抓包验证过可行但被否）：用户更信任
 * 与手动点击完全一致的路径——插件自己处理站点识别、店铺归属等前置逻辑，
 * 接口字段（site/postFee）直填错值反而可能造成脏数据。
 *
 * 流程：resolveOfferId → 托管浏览器开 1688 详情页新标签 →
 *   等妙手采集条挂载（远程包 ~13-16s）→ 点击主按钮 → 抓页面结果提示 → 关标签。
 * 全程 40~90s（等页面渲染 + 妙手远程包），HTTP 请求挂起至跑完。
 *
 * 硬前提：
 *   1. 比特窗口里已登录 erp.91miaoshou.com（插件判定看网页端登录态，
 *      未登录时点击只弹「您还未登录ERP软件」框、0 条上报——空点）
 *   2. 比特窗口里妙手插件处于启用状态（采集条 .earth-wxt-collect-panel 才会挂载）
 *
 * 妙手按钮三大坑（均已实测踩过）：
 *   ① 按钮文案「采␣集此商品」藏 U+200B 零宽字符防文本匹配，比对前必须洗掉；
 *      主按钮直接用类名 .earth-wxt-button--primary 定位更稳
 *   ② evaluate 回调里禁止定义具名函数/箭头：tsx(esbuild keepNames) 会编译成
 *      __name(fn,"x")，序列化到浏览器后 ReferenceError 且被 .catch 静默吞掉
 *      （表现为按钮明明在却永远找不到）——本文件所有 evaluate 均零具名函数
 *   ③ 页面有多个 .earth-wxt-collect-panel 实例，第一个可能是空壳，
 *      必须 document 级全局搜按钮，不能先取第一个 panel 再往里找
 */
import { openManagedTab } from "../browser/manager";
import type { Page } from "playwright-core";

const PAGE_TIMEOUT_MS = 45_000;
/** 妙手采集条挂载等待上限（页面渲染 + 远程包下发，实测 ~13-16s，留足余量） */
const MISHOU_WAIT_MS = 45_000;
/** 点击后等结果提示（el-message/toast）的窗口 */
const MISHOU_FEEDBACK_MS = 12_000;

export interface AutoCollectResult {
  offerId: string;
  offerUrl: string;
  /** 妙手按钮点击结果 */
  mishou: {
    clicked: boolean;
    /** 妙手页面上的原文提示（已提交采集任务…/未登录提示等），可能为 null */
    feedback: string | null;
  };
}

/* ------------------------------------------------------------------ *
 * 链接解析
 * ------------------------------------------------------------------ */

/**
 * 从用户给的任意 1688 链接里挖 offerId。
 * 支持：qr.1688.com/s/xxx 短链（APP 分享）、m.1688.com/offer/…、detail.1688.com/offer/…（含追踪参数）
 */
export async function resolveOfferId(rawUrl: string): Promise<{ offerId: string; offerUrl: string }> {
  const direct = /detail\.1688\.com\/offer\/(\d+)\.html/.exec(rawUrl) ?? /1688\.com\/offer\/(?:\?id=)?(\d+)/.exec(rawUrl);
  if (direct) {
    return { offerId: direct[1], offerUrl: `https://detail.1688.com/offer/${direct[1]}.html` };
  }

  // 短链：页面是 JS 跳转壳，目标地址写在 HTML 里（HTTP 层不 302，实测）
  if (/qr\.1688\.com\/s\//.test(rawUrl)) {
    const res = await fetch(rawUrl, {
      headers: {
        // 移动 UA：APP 分享链接在移动端页面里才带完整 offerId 参数
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const m =
      /offerId=(\d+)/.exec(html) ??
      /m\.1688\.com\/offer\/(\d+)\.html/.exec(html) ??
      /detail\.1688\.com\/offer\/(\d+)\.html/.exec(html);
    if (!m) throw new Error(`短链里没解析到商品 ID（页面 ${html.length} 字节）`);
    return { offerId: m[1], offerUrl: `https://detail.1688.com/offer/${m[1]}.html` };
  }

  throw new Error(`不认识的 1688 链接：${rawUrl.slice(0, 120)}`);
}

/* ------------------------------------------------------------------ *
 * 妙手采集条：DOM 定位点击（普通 DOM，无需像素扫描）
 * ------------------------------------------------------------------ */

/**
 * 尝试点击妙手采集条上的「采集此商品」按钮。
 * 主按钮 = .earth-wxt-button--primary；从 document 全局搜（多 panel 坑③），
 * 兜底：任意 earth-wxt-button 文案匹配（洗掉零宽字符，坑①）。
 * evaluate 回调零具名函数（坑②），零宽字符清洗用内联 replace。
 * 找不到按钮返回 false（插件未启用/还在加载），调用方按超时策略兜底。
 */
async function tryClickMishouButton(page: Page): Promise<boolean> {
  const hit = await page
    .evaluate(() => {
      // 注意：不能定义 norm 具名函数（tsx __name 坑），replace 全部内联
      let el = document.querySelector<HTMLElement>(".earth-wxt-collect-panel .earth-wxt-button--primary");
      if (!el) {
        for (const b of document.querySelectorAll<HTMLElement>(".earth-wxt-collect-panel .earth-wxt-button")) {
          if ((b.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").includes("采集此商品")) {
            el = b;
            break;
          }
        }
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return null;
      return {
        text: (el.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().slice(0, 20),
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
      };
    })
    .catch(() => null);
  if (!hit) return false;
  console.log(`[autocollect] 妙手主按钮已定位：「${hit.text}」@(${Math.round(hit.cx)},${Math.round(hit.cy)})`);
  await page.mouse.move(hit.cx, hit.cy, { steps: 5 });
  await page.waitForTimeout(300);
  await page.mouse.click(hit.cx, hit.cy);
  return true;
}

/** 点击后抓妙手的结果提示（采集成功/失败/登录提示等页面浮层原文） */
function grabMishouFeedback(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      for (const el of document.querySelectorAll(".el-message, .el-notification, [class*='message'], [class*='toast']")) {
        const t = (el.textContent || "").trim();
        if (/已提交采集任务|采集成功|采集失败|请先登录|需要登录|登录已过期|验证/.test(t)) return t.slice(0, 80);
      }
      return null;
    })
    .catch(() => null);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 单飞锁：同一时刻只允许一个采集流程占用托管窗口 */
let inFlight: Promise<AutoCollectResult> | null = null;

export function collectOfferFromUrl(rawUrl: string): Promise<AutoCollectResult> {
  if (inFlight) return inFlight;
  inFlight = runCollect(rawUrl).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCollect(rawUrl: string): Promise<AutoCollectResult> {
  const { offerId, offerUrl } = await resolveOfferId(rawUrl);
  const page = await openManagedTab(offerUrl, PAGE_TIMEOUT_MS);

  try {
    // 等妙手采集条挂载并点击。妙手是唯一产出，条一直不出现（插件被禁用/
    // 掉登录壳）就直接报错，静默跳过等于什么都没发生
    const clickDeadline = Date.now() + MISHOU_WAIT_MS;
    let clicked = false;
    let poll = 0;
    while (Date.now() < clickDeadline) {
      poll += 1;
      if (await tryClickMishouButton(page)) {
        clicked = true;
        break;
      }
      // 诊断日志：区分「条没挂」和「条挂了按钮没渲染」两种卡法
      if (poll % 5 === 1) {
        const state = await page
          .evaluate(() => ({
            panel: !!document.querySelector(".earth-wxt-collect-panel"),
            primary: !!document.querySelector(".earth-wxt-collect-panel .earth-wxt-button--primary"),
          }))
          .catch(() => null);
        console.log(`[autocollect] 等妙手采集条 #${poll}：${JSON.stringify(state)}`);
      }
      await page.waitForTimeout(3_000);
    }
    if (!clicked) {
      throw new Error(
        "妙手采集条未出现（45s）：请确认比特窗口里妙手插件已启用，且 erp.91miaoshou.com 处于登录状态",
      );
    }

    // 抓结果提示（已提交采集任务/未登录提示等），拿不到提示也算点击成功
    const fbDeadline = Date.now() + MISHOU_FEEDBACK_MS;
    let feedback: string | null = null;
    while (Date.now() < fbDeadline && !feedback) {
      feedback = await grabMishouFeedback(page);
      if (!feedback) await new Promise((r) => setTimeout(r, 1_500));
    }

    console.log(
      `[autocollect] 妙手按钮已点击：offerId=${offerId} 提示=${feedback ?? "（未捕获到结果提示）"}`,
    );
    return { offerId, offerUrl, mishou: { clicked: true, feedback } };
  } finally {
    // 标签用完即关，比特窗口本体和用户开着的其他标签不受影响
    await page.close().catch(() => {});
  }
}
