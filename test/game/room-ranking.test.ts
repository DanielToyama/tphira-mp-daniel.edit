// 结算「准度排行」单元测试
// 直接测 formatAccuracyRanking：排序、并列名次、截断提示、以及 6 种语言的键都能渲染。
import { describe, expect, test } from "vitest";
import { formatAccuracyRanking, GAME_SUMMARY_RANK_LIMIT } from "../../src/server/game/roomUtils.js";
import { Language } from "../../src/server/utils/l10n.js";
import type { RecordData } from "../../src/server/core/types.js";
import type { User } from "../../src/server/game/user.js";

function rec(accuracy: number, score = 1000000, player = 1): RecordData {
  return {
    id: player,
    player,
    score,
    perfect: 1,
    good: 0,
    bad: 0,
    miss: 0,
    max_combo: 1,
    accuracy,
    full_combo: true,
    std: 0,
    std_score: 0
  };
}

/** 只用到 name 字段，其余用 as 断言凑成 User */
function users(names: Record<number, string>): (id: number) => User | undefined {
  const map = new Map<number, User>();
  for (const [id, name] of Object.entries(names)) map.set(Number(id), { name } as User);
  return (id) => map.get(id);
}

describe("formatAccuracyRanking", () => {
  test("按准度降序排列，名次从 1 开始", () => {
    const results = new Map([
      [100, rec(0.9, 100, 100)],
      [200, rec(0.99, 100, 200)],
      [300, rec(0.95, 100, 300)]
    ]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), users({ 100: "Alice", 200: "Bob", 300: "Carol" }));

    const lines = text.split("\n");
    expect(lines[0]).toContain("准度排行");
    expect(lines[0]).toContain("3");
    expect(lines[1]).toContain("1. Bob");
    expect(lines[2]).toContain("2. Carol");
    expect(lines[3]).toContain("3. Alice");
  });

  test("准度相同则并列同名次，后续名次跳过（1、1、3）", () => {
    const results = new Map([
      [100, rec(0.99, 100, 100)],
      [200, rec(0.99, 100, 200)],
      [300, rec(0.95, 100, 300)]
    ]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), users({ 100: "Alice", 200: "Bob", 300: "Carol" }));

    const lines = text.split("\n");
    expect(lines[1]).toContain("1.");
    expect(lines[2]).toContain("1.");
    expect(lines[3]).toContain("3.");
  });

  test("准度相同时按分数降序决定先后", () => {
    const results = new Map([
      [100, rec(0.99, 100, 100)],
      [200, rec(0.99, 999999, 200)]
    ]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), users({ 100: "Alice", 200: "Bob" }));

    const lines = text.split("\n");
    expect(lines[1]).toContain("Bob");
    expect(lines[2]).toContain("Alice");
  });

  test("准度以百分比保留两位小数展示", () => {
    const results = new Map([[100, rec(0.99875, 100, 100)]]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), users({ 100: "Alice" }));
    expect(text).toContain("99.88%");
  });

  test("超出上限时截断并提示未显示人数", () => {
    const results = new Map<number, RecordData>();
    const names: Record<number, string> = {};
    const total = GAME_SUMMARY_RANK_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const id = 100 + i;
      // 准度各不相同，避免并列干扰计数
      results.set(id, rec(1 - i * 0.001, 100, id));
      names[id] = `P${i}`;
    }

    const text = formatAccuracyRanking(results, new Language("zh-CN"), users(names));
    const lines = text.split("\n");
    // 标题 + 上限条数 + 未显示提示
    expect(lines).toHaveLength(GAME_SUMMARY_RANK_LIMIT + 2);
    expect(lines[0]).toContain(String(total));
    expect(lines.at(-1)).toContain("5");
    expect(text).toContain("未显示");
  });

  test("人数未超上限时没有未显示提示", () => {
    const results = new Map([
      [100, rec(0.9, 100, 100)],
      [200, rec(0.8, 100, 200)]
    ]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), users({ 100: "Alice", 200: "Bob" }));
    expect(text).not.toContain("未显示");
  });

  test("查不到用户名时回退显示 id", () => {
    const results = new Map([[100, rec(0.9, 100, 100)]]);
    const text = formatAccuracyRanking(results, new Language("zh-CN"), () => undefined);
    expect(text).toContain("100");
  });

  test("6 种语言的排行键都能正常渲染（无缺翻译）", () => {
    const results = new Map([
      [100, rec(0.99, 100, 100)],
      [200, rec(0.95, 100, 200)]
    ]);
    for (const lang of ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "ru-RU"]) {
      const text = formatAccuracyRanking(results, new Language(lang), users({ 100: "Alice", 200: "Bob" }));
      expect(text).toContain("99.00%");
      expect(text).toContain("Alice");
      expect(text.split("\n")).toHaveLength(3);
    }
  });
});
