// 隐私房间（房号以 h 开头）测试
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { Client } from "../../src/client/client.js";
import { startServer } from "../../src/server/core/server.js";
import { isHiddenRoomId } from "../../src/server/game/roomUtils.js";
import { clearRoomListCache } from "../../src/server/network/routes/publicRoutes.js";
import { cleanupTempDir, createTempDir, setupMockFetch, waitFor } from "../helpers.js";

describe("隐私房间", () => {
  test("房号以 h / H 开头即判定为隐私房间", () => {
    expect(isHiddenRoomId("h1234")).toBe(true);
    expect(isHiddenRoomId("H1234")).toBe(true);
    expect(isHiddenRoomId("room1")).toBe(false);
    expect(isHiddenRoomId("_system")).toBe(false);
    expect(isHiddenRoomId("")).toBe(false);
  });

  describe("接口与房间列表", () => {
    const { originalFetch, mockFetch } = setupMockFetch();
    let tempDir: string;

    beforeAll(() => {
      globalThis.fetch = mockFetch;
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    beforeEach(() => {
      // /room 有 2 秒模块级缓存，跨用例会串数据，这里显式清空
      clearRoomListCache();
    });

    afterEach(async () => {
      if (tempDir) await cleanupTempDir(tempDir);
    });

    test("/room 不泄露隐私房间详情，欢迎语只显示占位文案", async () => {
      tempDir = await createTempDir("hidden-room");

      const running = await startServer({
        port: 0,
        configPath: join(tempDir, "server_config.yml"),
        config: { monitors: [], http_service: true, http_port: 0, replay_base_dir: tempDir }
      });
      const port = running.address().port;
      const httpPort = running.http!.address().port;
      const base = `http://127.0.0.1:${httpPort}`;

      const alice = await Client.connect("127.0.0.1", port);
      const bob = await Client.connect("127.0.0.1", port);

      try {
        await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        await alice.createRoom("hsecret");

        // 公开接口只返回占位条目，房间号/房主/玩家/谱面全部清空
        const data = (await originalFetch(`${base}/room`).then((r) => r.json())) as any;
        expect(data.rooms).toHaveLength(1);
        const room = data.rooms[0];
        expect(room.hidden).toBe(true);
        expect(room.roomid).toBe("");
        expect(room.host).toEqual({ name: "", id: "" });
        expect(room.players).toEqual([]);
        expect(room.chart).toBeNull();
        // 房间号不得出现在响应体的任何位置
        expect(JSON.stringify(data)).not.toContain("hsecret");

        // 欢迎语里的文字房间列表显示为占位文案
        await bob.authenticate("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        const chats: string[] = [];
        await waitFor(() => {
          chats.push(
            ...bob
              .takeMessages()
              .filter((m) => m.type === "Chat" && m.user === 0)
              .map((m) => (m as any).content as string)
          );
          return chats.some((s) => s.includes("*隐藏的房间*"));
        }, 3000);

        const all = chats.join("\n");
        expect(all).toContain("*隐藏的房间*");
        expect(all).not.toContain("hsecret");
        // 隐私房间提示也在公告里
        expect(all).toContain("可在房间号前面加h");
      } finally {
        await alice.close();
        await bob.close();
        await running.close();
      }
    }, 20000);

    test("普通房间仍正常展示完整信息", async () => {
      tempDir = await createTempDir("normal-room");

      const running = await startServer({
        port: 0,
        configPath: join(tempDir, "server_config.yml"),
        config: { monitors: [], http_service: true, http_port: 0, replay_base_dir: tempDir }
      });
      const port = running.address().port;
      const httpPort = running.http!.address().port;

      const alice = await Client.connect("127.0.0.1", port);
      try {
        await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        await alice.createRoom("room1");

        const data = (await originalFetch(`http://127.0.0.1:${httpPort}/room`).then((r) => r.json())) as any;
        expect(data.rooms).toHaveLength(1);
        expect(data.rooms[0]).toMatchObject({ roomid: "room1", hidden: false });
        expect(data.rooms[0].players).toHaveLength(1);
      } finally {
        await alice.close();
        await running.close();
      }
    }, 20000);
  });
});
