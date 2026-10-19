// 玩家游玩统计（游玩排行）测试
import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlayerStatsStore } from "../../src/server/stats/playerStats.js";
import { Client } from "../../src/client/client.js";
import { startServer } from "../../src/server/core/server.js";
import { createTempDir, cleanupTempDir, setupMockFetch, waitFor, sleep } from "../helpers.js";

describe("玩家游玩统计", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  test("累加游玩次数与平均分数/准度", async () => {
    tempDir = await createTempDir("player-stats-accumulate");
    const store = new PlayerStatsStore(join(tempDir, "player_stats.json"));

    store.recordPlay(100, "Alice", 900000, 0.9);
    store.recordPlay(100, "Alice", 800000, 0.8);
    store.recordPlay(200, "Bob", 500000, 0.5);

    const { total, entries } = store.leaderboard(0, 10);
    expect(total).toBe(2);
    // 游玩次数降序：Alice(2) 在前
    expect(entries[0]).toMatchObject({ id: 100, name: "Alice", plays: 2 });
    expect(entries[0]!.avg_score).toBe(850000);
    expect(entries[0]!.avg_accuracy).toBeCloseTo(0.85, 6);
    expect(entries[1]).toMatchObject({ id: 200, name: "Bob", plays: 1, avg_score: 500000 });
    expect(entries[1]!.avg_accuracy).toBeCloseTo(0.5, 6);
  });

  test("分页与越界", async () => {
    tempDir = await createTempDir("player-stats-page");
    const store = new PlayerStatsStore(join(tempDir, "player_stats.json"));

    for (let i = 0; i < 5; i++) {
      for (let n = 0; n <= i; n++) store.recordPlay(100 + i, `P${100 + i}`, 1000, 0.5);
    }

    const first = store.leaderboard(0, 2);
    expect(first.total).toBe(5);
    expect(first.entries.map((it) => it.id)).toEqual([104, 103]);

    const second = store.leaderboard(2, 2);
    expect(second.entries.map((it) => it.id)).toEqual([102, 101]);

    const beyond = store.leaderboard(99, 10);
    expect(beyond.total).toBe(5);
    expect(beyond.entries).toEqual([]);
  });

  test("按 id 查询名次", async () => {
    tempDir = await createTempDir("player-stats-rank");
    const store = new PlayerStatsStore(join(tempDir, "player_stats.json"));

    // 名次：104(5 局) > 103(4) > 102(3) > 101(2) > 100(1)
    for (let i = 0; i < 5; i++) {
      for (let n = 0; n <= i; n++) store.recordPlay(100 + i, `P${100 + i}`, 1000, 0.5);
    }

    expect(store.size).toBe(5);
    expect(store.rankOf(104)?.rank).toBe(1);
    expect(store.rankOf(102)?.rank).toBe(3);
    expect(store.rankOf(100)?.rank).toBe(5);
    expect(store.rankOf(100)?.entry).toMatchObject({ id: 100, name: "P100", plays: 1 });
    // 未上榜
    expect(store.rankOf(999)).toBeNull();
  });

  test("非法输入被忽略", async () => {
    tempDir = await createTempDir("player-stats-invalid");
    const store = new PlayerStatsStore(join(tempDir, "player_stats.json"));

    store.recordPlay(-1, "Bad", 100, 0.5);
    store.recordPlay(1.5, "Bad", 100, 0.5);

    expect(store.leaderboard(0, 10).total).toBe(0);
  });

  test("落盘后可重新加载，并保留玩家名", async () => {
    tempDir = await createTempDir("player-stats-persist");
    const path = join(tempDir, "player_stats.json");

    const store = new PlayerStatsStore(path);
    store.recordPlay(100, "Alice", 900000, 0.9);
    await store.flush();

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.players).toHaveLength(1);

    const reloaded = new PlayerStatsStore(path);
    await reloaded.load();
    const { entries } = reloaded.leaderboard(0, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 100, name: "Alice", plays: 1, avg_score: 900000 });
  });

  test("文件缺失或损坏时从空统计开始", async () => {
    tempDir = await createTempDir("player-stats-corrupt");
    const path = join(tempDir, "player_stats.json");

    const missing = new PlayerStatsStore(join(tempDir, "nope.json"));
    await missing.load();
    expect(missing.leaderboard(0, 10).total).toBe(0);

    await writeFile(path, "{ not json", "utf8");
    const corrupt = new PlayerStatsStore(path);
    await corrupt.load();
    expect(corrupt.leaderboard(0, 10).total).toBe(0);
  });
});

describe("游玩排行 HTTP 接口", () => {
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

  test("完成一局后排行榜出现该玩家，并能按 user_id 查到名次", async () => {
    tempDir = await createTempDir("player-stats-route");

    const running = await startServer({
      port: 0,
      configPath: join(tempDir, "server_config.yml"),
      config: { monitors: [], http_service: true, http_port: 0, replay_base_dir: tempDir }
    });
    const port = running.address().port;
    const httpPort = running.http!.address().port;
    const base = `http://127.0.0.1:${httpPort}`;

    const alice = await Client.connect("127.0.0.1", port);
    try {
      const before = await originalFetch(`${base}/stats/leaderboard`).then((r) => r.json() as any);
      expect(before).toMatchObject({ ok: true, total: 0 });
      expect(before.players).toEqual([]);

      await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await alice.createRoom("room_stats");
      await alice.selectChart(1);
      await alice.requestStart();
      await waitFor(() => alice.roomState()?.type === "Playing", 5000);

      await alice.played(1);
      await waitFor(() => alice.roomState()?.type === "SelectChart", 5000);

      // 统计是内存即时生效的；短轮询只为规避请求时序
      let after: any = null;
      for (let i = 0; i < 10; i++) {
        after = await originalFetch(`${base}/stats/leaderboard`).then((r) => r.json() as any);
        if (after.total > 0) break;
        await sleep(100);
      }

      expect(after.ok).toBe(true);
      expect(after.total).toBe(1);
      expect(after.players).toHaveLength(1);
      expect(after.players[0]).toMatchObject({ id: 100, name: "Alice", plays: 1 });
      expect(typeof after.players[0].avg_score).toBe("number");
      expect(typeof after.players[0].avg_accuracy).toBe("number");

      // user_id 直查名次（前端「我的排名」贴底栏用）
      const mine = await originalFetch(`${base}/stats/leaderboard?user_id=100`).then((r) => r.json() as any);
      expect(mine).toMatchObject({ ok: true, total: 1, rank: 1 });
      expect(mine.entry).toMatchObject({ id: 100, name: "Alice", plays: 1 });

      // 未上榜：rank 0 且 entry 为 null，而不是报错
      const notRanked = await originalFetch(`${base}/stats/leaderboard?user_id=999`).then((r) => r.json() as any);
      expect(notRanked).toMatchObject({ ok: true, total: 1, rank: 0, entry: null });

      // 非法 user_id
      const badId = await originalFetch(`${base}/stats/leaderboard?user_id=abc`);
      expect(badId.status).toBe(400);
    } finally {
      await alice.close();
      await running.close();
    }
  }, 20000);
});
