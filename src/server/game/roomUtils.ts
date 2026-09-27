import type { Room } from "../game/room.js";
import type { RecordData } from "../core/types.js";
import { tl, type Language } from "../utils/l10n.js";
import type { User } from "../game/user.js";

/**
 * 结算消息里「准度排行」最多列出的玩家数。
 * 房间人数上限默认 8，但管理员可调到 64，避免人多时结算消息过长刷屏。
 */
export const GAME_SUMMARY_RANK_LIMIT = 10;

/** monitor数据转发模块：判断房间是否有观战者 */
function roomHasMonitors(room: Room): boolean {
  return room.monitorIds().length > 0;
}

/** 录制回放模块：判断房间是否应该录制 */
function roomShouldRecord(room: Room, replayEnabled: boolean): boolean {
  return replayEnabled && room.replayEligible;
}

/** 综合判断：房间是否处于活跃状态（用于客户端显示） */
function roomShouldBeLive(room: Room, replayEnabled: boolean): boolean {
  return roomHasMonitors(room) || roomShouldRecord(room, replayEnabled);
}

export function refreshRoomLive(room: Room, replayEnabled: boolean): boolean {
  const live = roomShouldBeLive(room, replayEnabled);
  room.live = live;
  return live;
}

/**
 * 生成结算消息里的「准度排行」文本。
 *
 * - 按 accuracy 降序，同准度按 score 降序（给并列一个稳定的先后顺序）
 * - 并列同名次（1、1、3…），名次只在准度变化时推进
 * - 最多展示 limit 名，其余以「另有 N 名未显示」提示，避免人多时消息过长
 */
export function formatAccuracyRanking(
  results: Map<number, RecordData>,
  lang: Language,
  usersById: (id: number) => User | undefined,
  limit: number = GAME_SUMMARY_RANK_LIMIT
): string {
  const ranked = [...results.entries()].sort((a, b) => {
    if (b[1].accuracy !== a[1].accuracy) return b[1].accuracy - a[1].accuracy;
    return b[1].score - a[1].score;
  });
  const shown = limit > 0 ? ranked.slice(0, limit) : [];

  const lines: string[] = [tl(lang, "chat-game-summary-rank-title", { total: String(results.size) })];
  let currentRank = 0;
  let prevAcc: number | null = null;
  for (let i = 0; i < shown.length; i++) {
    const [id, r] = shown[i]!;
    // 仅当准度变化时才推进名次，从而实现并列同名次
    if (prevAcc === null || r.accuracy !== prevAcc) currentRank = i + 1;
    prevAcc = r.accuracy;
    lines.push(
      tl(lang, "chat-game-summary-rank-item", {
        rank: String(currentRank),
        name: usersById(id)?.name ?? String(id),
        id: String(id),
        acc: `${(r.accuracy * 100).toFixed(2)}%`
      })
    );
  }
  const rest = ranked.length - shown.length;
  if (rest > 0) lines.push(tl(lang, "chat-game-summary-rank-more", { rest: String(rest) }));
  return lines.join("\n");
}
