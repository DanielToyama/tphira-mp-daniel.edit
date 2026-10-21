/**
 * 从 hitokoto-osc/sentences-bundle 生成内置格言库
 *
 * 数据来源：https://github.com/hitokoto-osc/sentences-bundle （AGPL-3.0）
 * 本脚本只取一部分分类，做长度/敏感词过滤与确定性抽样，产出
 * `src/server/stats/quotes.generated.ts`（生成物，不要手改）。
 *
 * 用法：node tools/fetch-quotes.mjs
 * 可调环境变量：QUOTE_PER_CATEGORY（每类保留条数，默认 300）
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outFile = join(repoRoot, "src", "server", "stats", "quotes.generated.ts");

const REPO = "hitokoto-osc/sentences-bundle";
const REF = "master";

/** 参与抽取的分类：动画 / 游戏 / 诗词 / 哲学 / 文学 / 原创 / 影视 */
const CATEGORIES = ["a", "c", "i", "k", "d", "e", "h"];

const PER_CATEGORY = Number(process.env.QUOTE_PER_CATEGORY ?? "300");
/** 适合客户端聊天框一行的长度上限 */
const MAX_LEN = 40;
const MIN_LEN = 4;

/**
 * 敏感词过滤（保守起见只拦明确不合适的词，避免把库清空）。
 * 这是一层兜底，不代表做了完整的内容审核。
 */
const BLOCKLIST = [
  "色情", "裸", "性爱", "做爱", "强奸", "嫖", "妓", "淫",
  "自杀", "杀人", "砍死", "杀死你", "去死", "他妈", "傻逼", "操你", "滚蛋",
  "习近平", "共产党", "台独", "港独", "法轮", "六四", "天安门事件",
  "毒品", "吸毒", "赌博", "博彩",
  "http://", "https://", "www."
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isClean(text) {
  if (text.length < MIN_LEN || text.length > MAX_LEN) return false;
  if (/[\r\n\t]/.test(text)) return false;
  const lower = text.toLowerCase();
  return !BLOCKLIST.some((w) => lower.includes(w.toLowerCase()));
}

async function fetchCategory(cat) {
  const url = `https://api.github.com/repos/${REPO}/contents/sentences/${cat}.json?ref=${REF}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "phira-mp-quote-fetcher", Accept: "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error(`拉取 ${cat}.json 失败：HTTP ${res.status}`);
  const json = await res.json();
  const buf = Buffer.from(json.content, json.encoding);
  return JSON.parse(buf.toString("utf8"));
}

const all = [];
const seen = new Set();
let rawTotal = 0;

for (const cat of CATEGORIES) {
  const items = await fetchCategory(cat);
  rawTotal += items.length;
  const candidates = [];
  for (const it of items) {
    const quote = typeof it.hitokoto === "string" ? it.hitokoto.trim().replace(/\s+/g, " ") : "";
    if (!quote || !isClean(quote) || seen.has(quote)) continue;
    seen.add(quote);
    const fromWho = typeof it.from_who === "string" ? it.from_who.trim() : "";
    const fromSrc = typeof it.from === "string" ? it.from.trim() : "";
    const from = fromWho || fromSrc || "佚名";
    candidates.push({ quote, from: from.length > 24 ? from.slice(0, 24) : from });
  }
  // 确定性抽样：同一份输入永远产出同一份结果
  const rand = mulberry32(0x9e3779b9 ^ cat.charCodeAt(0));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const picked = candidates.slice(0, PER_CATEGORY);
  all.push(...picked);
  console.log(`分类 ${cat}: 原始 ${items.length} → 合格 ${candidates.length} → 保留 ${picked.length}`);
}

// 全局再打散一次，避免同分类的条目扎堆
const rand = mulberry32(0x12345678);
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}

const body = all.map((it) => `  ${JSON.stringify(it)}`).join(",\n");
const content = `// 本文件由 tools/fetch-quotes.mjs 生成，请勿手改。
// 数据来源：https://github.com/hitokoto-osc/sentences-bundle （AGPL-3.0）
// 已做长度限制、敏感词过滤与确定性抽样；重新生成请运行 node tools/fetch-quotes.mjs
import type { DailyQuote } from "./dailyQuote.js";

export const BUNDLED_QUOTES: readonly DailyQuote[] = [
${body}
];
`;

writeFileSync(outFile, content, "utf8");
console.log(`\n原始 ${rawTotal} 条 → 写入 ${all.length} 条`);
console.log(`输出：${outFile}`);
