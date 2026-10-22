// 账号级访问统计（用户粘性企划）测试
import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VisitStatsStore, toDateKey, VISIT_MILESTONES } from "../../src/server/stats/visitStats.js";
import { quoteForDate, quoteCount } from "../../src/server/stats/dailyQuote.js";
import { Client } from "../../src/client/client.js";
import { startServer } from "../../src/server/core/server.js";
import { createTempDir, cleanupTempDir, setupMockFetch, waitFor, sleep } from "../helpers.js";

const DAY = 86_400_000;

describe("访问统计存储", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  test("首次连接：编号从 1 起，次数含历史游玩基数", async () => {
    tempDir = await createTempDir("visit-first");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));

    const out = store.recordVisit(100, "Alice", 86);
    expect(out.isNewAccount).toBe(true);
    expect(out.number).toBe(1);
    // 历史 86 次游玩 + 本次连接
    expect(out.totalVisits).toBe(87);
    expect(out.previousVisits).toBe(86);
    expect(out.firstRecordedDay).toBe(true);
    expect(out.recordedDays).toBe(1);
    expect(out.gapDays).toBe(0);
    expect(out.todayOrdinal).toBe(1);
    expect(out.todayUsers).toBe(1);
  });

  test("编号按首次出现顺序递增", async () => {
    tempDir = await createTempDir("visit-order");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));

    expect(store.recordVisit(200, "B").number).toBe(1);
    expect(store.recordVisit(100, "A").number).toBe(2);
    expect(store.recordVisit(300, "C").number).toBe(3);
    // 重复连接不改变编号
    expect(store.recordVisit(200, "B").number).toBe(1);
  });

  test("同一天重复连接只算一天，次数照常累加", async () => {
    tempDir = await createTempDir("visit-sameday");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 20, 0, 0).getTime();

    store.recordVisit(1, "A", 0, t0);
    const second = store.recordVisit(1, "A", 0, t0 + 3600_000);
    expect(second.firstRecordedDay).toBe(false);
    expect(second.recordedDays).toBe(1);
    expect(second.gapDays).toBe(0);
    expect(second.totalVisits).toBe(2);
  });

  test("跨天：天数递增，间隔按自然日算", async () => {
    tempDir = await createTempDir("visit-gap");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 20, 0, 0).getTime();

    store.recordVisit(1, "A", 0, t0);
    const later = store.recordVisit(1, "A", 0, t0 + 3 * DAY);
    expect(later.recordedDays).toBe(2);
    expect(later.gapDays).toBe(3);
    // 同一天再来不重复加天数
    const sameDay = store.recordVisit(1, "A", 0, t0 + 3 * DAY + 3600_000);
    expect(sameDay.recordedDays).toBe(2);
  });

  test("离开期间新增账号数", async () => {
    tempDir = await createTempDir("visit-away-new");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();

    store.recordVisit(1, "A", 0, t0);
    // A 离开期间来了两个新账号
    store.recordVisit(2, "B", 0, t0 + DAY);
    store.recordVisit(3, "C", 0, t0 + 2 * DAY);
    const back = store.recordVisit(1, "A", 0, t0 + 3 * DAY);
    expect(back.newAccountsWhileAway).toBe(2);
    expect(back.gapDays).toBe(3);
  });

  test("今日序号与小时聚合", async () => {
    tempDir = await createTempDir("visit-hour");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 3, 30, 0).getTime();

    const a = store.recordVisit(1, "A", 0, t0);
    expect(a.hour).toBe(3);
    expect(a.aloneInHour).toBe(true);
    expect(a.todayOrdinal).toBe(1);

    const b = store.recordVisit(2, "B", 0, t0 + 600_000);
    expect(b.aloneInHour).toBe(false);
    expect(b.todayOrdinal).toBe(2);
    // 同一账号同一天再来，序号仍是首次的位置
    const a2 = store.recordVisit(1, "A", 0, t0 + 900_000);
    expect(a2.todayOrdinal).toBe(1);
    expect(a2.todayUsers).toBe(2);
  });

  test("房间名只聚合特征，不保存原文", async () => {
    tempDir = await createTempDir("visit-roomname");
    const path = join(tempDir, "visit_stats.json");
    const store = new VisitStatsStore(path);

    store.recordRoomName("1f");
    store.recordRoomName("hello");
    store.recordRoomName("room99");
    store.recordRoomName("TEST");

    const snap = store.snapshot();
    expect(snap.roomStats.created).toBe(4);
    expect(snap.roomStats.maxNameLength).toBe(6);
    expect(snap.roomStats.withDigit).toBe(2);
    expect(snap.roomStats.digitRatio).toBeCloseTo(0.5, 6);
    expect(snap.roomStats.easter.hello).toBe(1);
    expect(snap.roomStats.easter.test).toBe(1);

    await store.flush();
    const raw = await readFile(path, "utf8");
    // 彩蛋键只可能是白名单里的固定名，任意用户房间名一律不落盘
    expect(raw).not.toContain("room99");
    expect(raw).not.toContain("1f");
  });

  test("全局面板快照", async () => {
    tempDir = await createTempDir("visit-snapshot");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();

    store.recordVisit(1, "A", 0, t0);
    store.recordVisit(2, "B", 0, t0 + 1000);
    // 第三次距首次已超过冷却期，才会再计入一次连接
    store.recordVisit(1, "A", 0, t0 + 31 * 60_000);

    const snap = store.snapshot(t0 + 31 * 60_000);
    expect(snap.serverDay).toBe(1);
    expect(snap.totalAccounts).toBe(2);
    expect(snap.todayConnections).toBe(3);
    expect(snap.todayUsers).toBe(2);
    expect(snap.todayNewAccounts).toBe(2);
  });

  test("半小时内重复连接不计入次数", async () => {
    tempDir = await createTempDir("visit-cooldown");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();

    const first = store.recordVisit(1, "A", 0, t0);
    expect(first.counted).toBe(true);
    expect(first.totalVisits).toBe(1);

    // 10 分钟后再连：只刷新最近连接时间
    const again = store.recordVisit(1, "A", 0, t0 + 10 * 60_000);
    expect(again.counted).toBe(false);
    expect(again.totalVisits).toBe(1);
    expect(store.snapshot(t0 + 10 * 60_000).todayConnections).toBe(1);

    // 过了 30 分钟才算新的一次
    const later = store.recordVisit(1, "A", 0, t0 + 31 * 60_000);
    expect(later.counted).toBe(true);
    expect(later.totalVisits).toBe(2);
    expect(store.snapshot(t0 + 31 * 60_000).todayConnections).toBe(2);
  });

  test("冷却不跨自然日：跨天后即使不足 30 分钟也计入", async () => {
    tempDir = await createTempDir("visit-cooldown-midnight");
    const store = new VisitStatsStore(join(tempDir, "visit_stats.json"));
    const late = new Date(2026, 0, 10, 23, 50, 0).getTime();

    store.recordVisit(1, "A", 0, late);
    // 20 分钟后已经是第二天
    const nextDay = store.recordVisit(1, "A", 0, late + 20 * 60_000);
    expect(nextDay.counted).toBe(true);
    expect(nextDay.totalVisits).toBe(2);
    expect(nextDay.recordedDays).toBe(2);
  });

  test("落盘后可重新加载", async () => {
    tempDir = await createTempDir("visit-persist");
    const path = join(tempDir, "visit_stats.json");
    const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();

    const store = new VisitStatsStore(path);
    store.recordVisit(100, "Alice", 5, t0);
    await store.flush();

    const reloaded = new VisitStatsStore(path);
    await reloaded.load();
    // 超过冷却期再连，才算新的一次
    const out = reloaded.recordVisit(100, "Alice", 5, t0 + 31 * 60_000);
    expect(out.number).toBe(1);
    // 历史 5 次 + 上次 1 次 + 本次 1 次
    expect(out.totalVisits).toBe(7);
    expect(out.recordedDays).toBe(1);
  });

  test("文件缺失或损坏时从空统计开始", async () => {
    tempDir = await createTempDir("visit-corrupt");
    const missing = new VisitStatsStore(join(tempDir, "nope.json"));
    await missing.load();
    expect(missing.snapshot().totalAccounts).toBe(0);
  });

  test("里程碑取值包含前端约定的节点", () => {
    for (const n of [10, 50, 100, 200]) expect(VISIT_MILESTONES).toContain(n);
  });
});

describe("每日一句", () => {
  test("同一天固定同一条，且库非空", () => {
    expect(quoteCount()).toBeGreaterThan(100);
    const a = quoteForDate("2026-10-19");
    const b = quoteForDate("2026-10-19");
    expect(a).toEqual(b);
    expect(a.quote.length).toBeGreaterThan(0);
    expect(a.from.length).toBeGreaterThan(0);
  });

  test("连续日期会取到不同条目", () => {
    const keys = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
    const seen = new Set(keys.map((k) => quoteForDate(k).quote));
    expect(seen.size).toBeGreaterThan(2);
  });

  test("条目长度受控，适合客户端一行展示", () => {
    for (const key of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      expect(quoteForDate(key).quote.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("社区面板 HTTP 接口", () => {
  const { originalFetch, mockFetch } = setupMockFetch();
  let tempDir: string;

  beforeAll(() => {
    globalThis.fetch = mockFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  test("连接后 /stats/server 反映账号数与今日连接", async () => {
    tempDir = await createTempDir("visit-route");

    const running = await startServer({
      port: 0,
      configPath: join(tempDir, "server_config.yml"),
      config: { monitors: [], http_service: true, http_port: 0, replay_base_dir: tempDir, admin_data_path: join(tempDir, "admin_data.json") }
    });
    const port = running.address().port;
    const httpPort = running.http!.address().port;
    const base = `http://127.0.0.1:${httpPort}`;

    const alice = await Client.connect("127.0.0.1", port);
    try {
      const before = await originalFetch(`${base}/stats/server`).then((r) => r.json() as any);
      expect(before).toMatchObject({ ok: true, totalAccounts: 0, todayConnections: 0 });
      expect(typeof before.serverDay).toBe("number");
      expect(typeof before.dailyQuote.quote).toBe("string");

      await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      let after: any = null;
      for (let i = 0; i < 10; i++) {
        after = await originalFetch(`${base}/stats/server`).then((r) => r.json() as any);
        if (after.totalAccounts > 0) break;
        await sleep(100);
      }

      expect(after.ok).toBe(true);
      expect(after.totalAccounts).toBe(1);
      expect(after.todayConnections).toBe(1);
      expect(after.todayNewAccounts).toBe(1);
      expect(after.onlineUsers).toBe(1);
      expect(after.roomStats.created).toBe(0);
    } finally {
      await alice.close();
      await running.close();
    }
  }, 20000);

  test("建房会累加当日房间名聚合", async () => {
    tempDir = await createTempDir("visit-route-room");

    const running = await startServer({
      port: 0,
      configPath: join(tempDir, "server_config.yml"),
      config: { monitors: [], http_service: true, http_port: 0, replay_base_dir: tempDir, admin_data_path: join(tempDir, "admin_data.json") }
    });
    const port = running.address().port;
    const httpPort = running.http!.address().port;
    const base = `http://127.0.0.1:${httpPort}`;

    const alice = await Client.connect("127.0.0.1", port);
    try {
      await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await alice.createRoom("hello");
      // 建房后需先离开，否则「已在房间中」
      await alice.leaveRoom();
      await alice.createRoom("room123");

      const res = await originalFetch(`${base}/stats/server`).then((r) => r.json() as any);
      expect(res.roomStats.created).toBe(2);
      expect(res.roomStats.maxNameLength).toBe(7);
      expect(res.roomStats.withDigit).toBe(1);
      expect(res.roomStats.easter.hello).toBe(1);
      // 原文不入库：响应里只给聚合值
      expect(JSON.stringify(res.roomStats)).not.toContain("room123");
    } finally {
      await alice.close();
      await running.close();
    }
  }, 20000);
  test("白名单账号不计入访问统计", async () => {
    tempDir = await createTempDir("visit-excluded");

    const running = await startServer({
      port: 0,
      configPath: join(tempDir, "server_config.yml"),
      config: {
        monitors: [],
        http_service: true,
        http_port: 0,
        replay_base_dir: tempDir,
        admin_data_path: join(tempDir, "admin_data.json"),
        stats_excluded_user_ids: [100]
      }
    });
    const port = running.address().port;
    const httpPort = running.http!.address().port;
    const base = `http://127.0.0.1:${httpPort}`;

    const alice = await Client.connect("127.0.0.1", port);
    try {
      await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      // 连上后仍是在线用户，但统计里不该出现
      const res = await originalFetch(`${base}/stats/server`).then((r) => r.json() as any);
      expect(res.totalAccounts).toBe(0);
      expect(res.todayConnections).toBe(0);
      expect(res.todayNewAccounts).toBe(0);
      expect(res.onlineUsers).toBe(1);
    } finally {
      await alice.close();
      await running.close();
    }
  }, 20000);
});

describe("日期键", () => {
  test("按本地自然日换算", () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 59, 0).getTime())).toBe("2026-01-05");
    expect(toDateKey(new Date(2026, 0, 6, 0, 0, 1).getTime())).toBe("2026-01-06");
  });
});
