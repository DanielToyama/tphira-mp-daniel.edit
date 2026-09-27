// 结算「准度排行」端到端测试：三个玩家提交不同准确率，验证结算消息里的名次顺序
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "../../src/client/client.js";
import { startServer } from "../../src/server/core/server.js";
import { waitFor, setupMockFetch } from "../helpers.js";

describe("结算准度排行", () => {
  const { originalFetch, mockFetch, setRecordOverride, resetRecordOverrides } = setupMockFetch();

  beforeAll(() => {
    globalThis.fetch = mockFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("多名玩家提交不同准度时，结算按准度降序列出排行榜", async () => {
    resetRecordOverrides();
    // record id → 玩家：1=Alice(100)、2=Bob(200)、3=Carol(300)
    setRecordOverride(1, { player: 100, accuracy: 0.9, score: 500000 });
    setRecordOverride(2, { player: 200, accuracy: 0.99, score: 1000 });
    setRecordOverride(3, { player: 300, accuracy: 0.95, score: 800000 });

    const running = await startServer({ port: 0, config: { monitors: [] } });
    const port = running.address().port;

    const alice = await Client.connect("127.0.0.1", port);
    const bob = await Client.connect("127.0.0.1", port);
    const carol = await Client.connect("127.0.0.1", port);

    try {
      await alice.authenticate("a".repeat(32));
      await alice.createRoom("rankroom");

      await bob.authenticate("b".repeat(32));
      await bob.joinRoom("rankroom", false);

      await carol.authenticate("c".repeat(32));
      await carol.joinRoom("rankroom", false);

      await alice.selectChart(1);
      await alice.requestStart();
      await bob.ready();
      await carol.ready();

      await waitFor(() => alice.roomState()?.type === "Playing");
      await waitFor(() => carol.roomState()?.type === "Playing");

      // 观战者视角收集系统结算消息
      const chats: string[] = [];
      await alice.played(1);
      await bob.played(2);
      await carol.played(3);

      await waitFor(() => {
        chats.push(
          ...alice
            .takeMessages()
            .filter((m) => m.type === "Chat" && m.user === 0)
            .map((m) => (m as any).content as string)
        );
        return chats.some((s) => s.includes("准度排行"));
      }, 3000);

      const summary = chats.find((s) => s.includes("准度排行"))!;
      const rankSection = summary.slice(summary.indexOf("准度排行"));

      // 排行按准度降序：Bob 99% > Carol 95% > Alice 90%
      expect(rankSection).toContain("1. Bob");
      expect(rankSection).toContain("2. Carol");
      expect(rankSection).toContain("3. Alice");

      expect(rankSection.indexOf("Bob")).toBeLessThan(rankSection.indexOf("Carol"));
      expect(rankSection.indexOf("Carol")).toBeLessThan(rankSection.indexOf("Alice"));

      expect(rankSection).toContain("99.00%");
      expect(rankSection).toContain("95.00%");
      expect(rankSection).toContain("90.00%");
    } finally {
      await alice.close();
      await bob.close();
      await carol.close();
      await running.close();
    }
  }, 20000);
});
