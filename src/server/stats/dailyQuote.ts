/**
 * 每日一句
 *
 * 设计取舍：
 * - 只读本地内置库（`quotes.generated.ts`），不依赖外部 API，网络故障也不会缺文案；
 * - 按日期做稳定哈希，同一天所有用户看到同一条，且相邻日期不会连续撞同一条；
 * - 库来自 hitokoto-osc/sentences-bundle，已在生成阶段做长度与敏感词过滤；
 * - 不接收任何用户生成内容，因此没有审核成本。
 */
import { BUNDLED_QUOTES } from "./quotes.generated.js";

export type DailyQuote = {
  /** 正文 */
  quote: string;
  /** 出处，展示在正文之后 */
  from: string;
};

const QUOTES: readonly DailyQuote[] = BUNDLED_QUOTES;

/**
 * 按日期取一条固定格言。
 *
 * @param dateKey - YYYY-MM-DD
 */
export function quoteForDate(dateKey: string): DailyQuote {
  if (QUOTES.length === 0) return { quote: "愿你在音游里找到节奏。", from: "本服务器" };
  let h = 2166136261;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return QUOTES[h % QUOTES.length]!;
}

/** 库内条目数（测试与 Web 端校验用） */
export function quoteCount(): number {
  return QUOTES.length;
}
