// 核心功能测试
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "../../src/client/client.js";
import { startServer } from "../../src/server/core/server.js";
import { waitFor, setupMockFetch, createTempDir, cleanupTempDir } from "../helpers.js";
import type { TouchFrame } from "../../src/common/commands.js";

describe("核心功能", () => {
  const { originalFetch, mockFetch, getHitokotoCalls } = setupMockFetch();

  beforeAll(() => {
    globalThis.fetch = mockFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("创建房间→观战加入→准备→开始→触控转发→结算结束", async () => {
    const tempDir = await createTempDir("core-test");
    const running = await startServer({
      port: 0,
      config: {
        monitors: [200],
        replay_enabled: true,
        replay_base_dir: tempDir,
        hitokoto_api_url: "https://v1.hitokoto.cn/",
        room_list_tip: "群：123456；查房间：example.com"
      }
    });
    const port = running.address().port;

    const alice = await Client.connect("127.0.0.1", port);
    const bob = await Client.connect("127.0.0.1", port);

    try {
      await alice.authenticate("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await alice.createRoom("room1");
      await waitFor(() => getHitokotoCalls() >= 1);

      await bob.authenticate("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const bobChat: string[] = [];
      await waitFor(() => {
        const batch = bob
          .takeMessages()
          .filter((m) => m.type === "Chat" && m.user === 0)
          .map((m) => (m as any).content as string);
        bobChat.push(...batch);
        return (
          bobChat.some((s) => s.includes("当前可用的房间如下：")) &&
          bobChat.some((s) => s.includes("群：123456")) &&
          bobChat.some((s) => s.includes("iphira.danieltoyama.fun")) &&
          bobChat.some((s) => s.includes("iphira.danieluu.top"))
        );
      }, 1500);

      expect(bobChat.join("\n")).toContain("iphira.danieltoyama.fun");
      // 域名迁移公告：新域名与状态站都要出现在欢迎信息里
      expect(bobChat.join("\n")).toContain("phira.danieluu.top");
      expect(bobChat.join("\n")).toContain("https://iphira.danieluu.top/");
      expect(bobChat.join("\n")).toContain("655504577");
      expect(bobChat.join("\n")).toContain("当前可用的房间如下：");
      expect(bobChat.join("\n")).toContain("room1（1/8）");
      expect(bobChat.join("\n")).toContain("群：123456；查房间：example.com");
      expect(getHitokotoCalls()).toBe(1);

      await bob.joinRoom("room1", true);

      await alice.selectChart(1);
      await alice.requestStart();
      await bob.ready();

      await waitFor(() => alice.roomState()?.type === "Playing");
      await waitFor(() => bob.roomState()?.type === "Playing");

      const frames: TouchFrame[] = [{ time: 1, points: [[0, { x: 0, y: 1 }]] }];
      await alice.sendTouches(frames);

      await waitFor(() => bob.livePlayer(100).touch_frames.length > 0, 1000);
      expect(bob.livePlayer(100).touch_frames.at(-1)).toEqual(frames[0]);

      await alice.played(1);
      await waitFor(() => alice.roomState()?.type === "SelectChart");

      const endChats: string[] = [];
      await waitFor(() => {
        const batch = bob
          .takeMessages()
          .filter((m) => m.type === "Chat" && m.user === 0)
          .map((m) => (m as any).content as string);
        endChats.push(...batch);
        return endChats.some(
          (s) => s.includes("本局结算：") && s.includes("无瑕度") && s.includes("0ms") && s.includes("准度排行")
        );
      }, 1500);

      // 结算消息里应含准度排行，且列出唯一提交成绩的玩家
      const summaryText = endChats.find((s) => s.includes("准度排行"))!;
      expect(summaryText).toContain("本局结算：");
      expect(summaryText).toContain("1. Alice");
      expect(summaryText).toContain("100.00%");
    } finally {
      await alice.close();
      await bob.close();
      await running.close();
      await cleanupTempDir(tempDir);
    }
  });
});
