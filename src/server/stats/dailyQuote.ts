/**
 * 一言
 *
 * 设计取舍：
 * - 只读本地内置库（`quotes.generated.ts`），不依赖外部 API，网络故障也不会缺文案；
 * - **每次取用随机一条**，连续两次不会重复（库内有多条时）；
 * - 库来自 hitokoto-osc/sentences-bundle，已在生成阶段做长度与敏感词过滤；
 * - 不接收任何用户生成内容，因此没有审核成本。
 */
import { BUNDLED_QUOTES } from "./quotes.generated.js";

export type DailyQuote = {
  /** 正文 */
  quote: string;
  /** 出处 */
  from: string;
};

const QUOTES: readonly DailyQuote[] = BUNDLED_QUOTES;

/** 上一次返回的下标：避免连续两次拿到同一条 */
let lastIndex = -1;

/**
 * 随机取一条一言。
 * 库内条目多于 1 条时保证与上一次不同，让「每次打开都不一样」真的成立。
 */
export function randomQuote(): DailyQuote {
  if (QUOTES.length === 0) return { quote: "愿你在音游里找到节奏。", from: "本服务器" };
  let index = Math.floor(Math.random() * QUOTES.length);
  if (QUOTES.length > 1 && index === lastIndex) {
    index = (index + 1 + Math.floor(Math.random() * (QUOTES.length - 1))) % QUOTES.length;
  }
  lastIndex = index;
  return QUOTES[index]!;
}

/** 库内条目数（测试与 Web 端校验用） */
export function quoteCount(): number {
  return QUOTES.length;
}
