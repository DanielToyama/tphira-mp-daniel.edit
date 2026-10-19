import { roomIdToString } from "../../../common/roomId.js";
import { isHiddenRoomId } from "../../game/roomUtils.js";
import type { RequestContext } from "./types.js";

/** /room 列表缓存 TTL（毫秒） */
const ROOM_LIST_CACHE_TTL_MS = 2000;

let roomListCache: { json: string; expiresAt: number } | null = null;

/** 清空 /room 列表缓存（仅用于测试：同一进程内会跑多个 server 实例） */
export function clearRoomListCache(): void {
  roomListCache = null;
}

/**
 * 处理公共路由：无需鉴权的查询接口
 * 返回 true 表示已处理。
 */
export async function tryHandlePublicRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, url, state, write } = ctx;

  if (req.method === "GET" && url.pathname === "/room") {
    const now = Date.now();
    if (roomListCache && now < roomListCache.expiresAt) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(roomListCache.json);
      return true;
    }

    const rooms: Array<{
      roomid: string;
      cycle: boolean;
      lock: boolean;
      host: { name: string; id: string };
      state: "select_chart" | "waiting_for_ready" | "playing";
      chart: { name: string; id: string } | null;
      players: Array<{ name: string; id: number }>;
      /** 房间人数上限。官方 tphira-mp 格式没有此字段，这里是附加字段，
       *  官方客户端会忽略未知字段，不影响兼容性；自有前端用它显示真实上限。 */
      max_users: number;
      /** 隐私房间（房号以 h 开头）：详情一律置空，前端据此渲染为不可点击的灰块 */
      hidden: boolean;
    }> = [];

    let total = 0;
    for (const [rid, room] of state.rooms) {
      const roomid = roomIdToString(rid);
      if (roomid.startsWith("_")) continue;

      // 隐私房间不泄露房间号 / 房主 / 玩家 / 谱面，只留一个占位条目
      if (isHiddenRoomId(roomid)) {
        rooms.push({
          roomid: "",
          cycle: false,
          lock: true,
          host: { name: "", id: "" },
          state: "select_chart",
          chart: null,
          players: [],
          max_users: 0,
          hidden: true
        });
        continue;
      }

      const hostUser = state.users.get(room.hostId);
      const hostName = hostUser?.name ?? String(room.hostId);

      const players = room.userIds().map((id) => {
        const u = state.users.get(id);
        return { id, name: u?.name ?? String(id) };
      });
      total += players.length;

      const stateStr =
        room.state.type === "Playing"
          ? "playing"
          : room.state.type === "WaitForReady"
            ? "waiting_for_ready"
            : "select_chart";

      const chart = room.chart ? { name: room.chart.name, id: String(room.chart.id) } : null;

      rooms.push({
        roomid,
        cycle: room.cycle,
        lock: room.locked,
        host: { name: hostName, id: String(room.hostId) },
        state: stateStr,
        chart,
        players,
        max_users: room.maxUsers,
        hidden: false
      });
    }

    rooms.sort((a, b) => a.roomid.localeCompare(b.roomid));
    const result = { rooms, total };
    const json = JSON.stringify(result);
    roomListCache = { json, expiresAt: now + ROOM_LIST_CACHE_TTL_MS };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(json);
    return true;
  }

  // 自定义接口：扁平房间列表（供自有前端使用，字段与 /room 不同，保持原样）
  if (req.method === "GET" && url.pathname === "/api/rooms") {
    const out = await state.mutex.runExclusive(async () => {
      const rooms: Array<{
        id: string;
        player_count: number;
        max_players: number;
        state: string;
        mode: string;
        locked: boolean;
        players: string[];
        current_chart: { name: string; id: number } | null;
      }> = [];

      for (const [rid, room] of state.rooms) {
        const roomid = roomIdToString(rid);
        if (roomid.startsWith("_")) continue; // 保持过滤逻辑

        // 获取玩家列表
        const players = room.userIds().map((uid) => {
          const u = state.users.get(uid);
          return u?.name ?? String(uid);
        });

        const player_count = players.length;

        // 状态映射：Rust 风格的状态文本
        let stateStr: string;
        if (room.state.type === "Playing") {
          stateStr = "游戏中";
        } else if (room.locked) {
          stateStr = "已锁定";
        } else {
          stateStr = "准备中";
        }

        // 模式映射
        const mode = room.cycle ? "循环模式" : "普通模式";

        // 谱面信息
        const current_chart = room.chart ? { id: Number(room.chart.id) || 0, name: room.chart.name } : null;

        rooms.push({
          id: roomid,
          player_count,
          max_players: room.maxUsers,
          state: stateStr,
          mode,
          locked: room.locked,
          players,
          current_chart
        });
      }

      // 保持排序
      rooms.sort((a, b) => a.id.localeCompare(b.id));
      return rooms; // 直接返回数组，不包装
    });

    write(200, out);
    return true;
  }

  // 玩家游玩排行（无需鉴权）：按游玩次数降序，支持分页
  // 带 user_id 时改为「查该用户的名次」，一次请求即可定位，前端不必逐页回扫
  if (req.method === "GET" && url.pathname === "/stats/leaderboard") {
    const userIdRaw = url.searchParams.get("user_id");
    if (userIdRaw !== null) {
      const userId = Number(userIdRaw);
      if (!Number.isInteger(userId) || userId < 0) {
        write(400, { ok: false, error: "invalid-user-id" });
        return true;
      }
      const hit = state.playerStats.rankOf(userId);
      write(200, {
        ok: true,
        total: state.playerStats.size,
        rank: hit?.rank ?? 0,
        entry: hit?.entry ?? null
      });
      return true;
    }

    const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
    const limitRaw = Number(url.searchParams.get("limit") ?? "30");
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 30;
    const { total, entries } = state.playerStats.leaderboard(offset, limit);
    write(200, { ok: true, total, offset, limit, players: entries });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/room-creation/config") {
    write(200, { ok: true, enabled: state.roomCreationEnabled });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/replay/config") {
    write(200, { ok: true, enabled: state.replayEnabled });
    return true;
  }

  return false;
}
