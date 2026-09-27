/**
 * 欢迎消息生成模块
 *
 * 在用户认证成功后,生成包含房间列表、服务器提示、站点与群组信息的欢迎消息,
 * 以系统聊天形式发送给用户。
 */
import type { ServerState } from "../../core/state.js";
import type { User } from "../../game/user.js";
import { getAvailableRoomsText } from "./roomListCache.js";

export type HitokotoValue = { quote: string; from: string };

/**
 * 服务器地址迁移公告的截止时间（UTC+8 的 2027-02-01 00:00）。
 * 到达该时间后不再展示迁移公告，避免过期信息长期占用欢迎信息。
 * 该判定仅用于内部逻辑，不会展示在玩家可见的地方。
 */
const MIGRATION_NOTICE_DEADLINE_MS = Date.parse("2027-02-01T00:00:00+08:00");

/**
 * 是否仍需要展示服务器地址迁移公告。
 * 截止时间之前展示；到达/超过截止时间后不再展示（判定本身不输出给玩家）。
 *
 * @param now - 当前时间戳（毫秒），默认取系统时间；参数化便于确定性验证
 */
export function shouldShowMigrationNotice(now: number = Date.now()): boolean {
  return now < MIGRATION_NOTICE_DEADLINE_MS;
}

/**
 * 生成并发送欢迎消息(系统聊天)
 *
 * 内容包括: 清屏空行 + 欢迎语 + 版本 + 房间列表 + 服务器提示(可选) + 站点/群组信息。
 * 任何环节失败都不会抛出异常,只会记录到 ERROR 日志,以避免阻塞认证流程。
 *
 * @param opts.user - 已认证的用户
 * @param opts.state - 服务器状态
 * @param opts.sendSystemChat - 发送系统聊天的回调
 * @param opts.hitokoto - 一言数据。本定制不再展示一言,参数保留以兼容 session.ts 的预热调用
 */
export async function sendWelcomeExtras(opts: {
  user: User;
  state: ServerState;
  sendSystemChat: (content: string) => Promise<void>;
  hitokoto?: HitokotoValue | null;
}): Promise<void> {
  const { user, state, sendSystemChat } = opts;
  try {
    const lang = user.lang;
    const tip = state.config.room_list_tip;
    const sep = "=".repeat(73) + "\n";

    const parts: string[] = [];
    parts.push("\n".repeat(40));
    parts.push(lang.format("chat-welcome", { userName: user.name, serverName: state.serverName }) + "\n");
    parts.push(sep);
    parts.push(lang.format("chat-welcome-version", { version: state.version }) + "\n");
    parts.push(sep);
    parts.push(lang.format("chat-roomlist-title") + "\n");
    parts.push(getAvailableRoomsText(state, lang) + "\n");
    parts.push(sep);
    if (tip) parts.push(tip + "\n");

    // 站点与群组信息(替代此前的"一言"展示)
    parts.push(sep);
    parts.push(lang.format("see-our-web") + "\n");
    // 服务器地址迁移公告：仅在截止时间前展示，过期后自动隐藏
    if (shouldShowMigrationNotice()) {
      parts.push(lang.format("see-our-web-migration-0") + "\n");
      parts.push(lang.format("see-our-web-migration-1") + "\n");
    }
    parts.push(sep);
    parts.push(lang.format("chat-group-0") + "\n");
    parts.push(lang.format("chat-group-1") + "\n");
    parts.push(lang.format("chat-group-2") + "\n");
    parts.push(sep);

    await sendSystemChat(parts.join(""));
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    state.logger.error(errorMsg);
  }
}
