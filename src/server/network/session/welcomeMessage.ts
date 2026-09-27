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
    // 域名迁移公告：旧域名仍可用，此处仅提示后续变更
    parts.push(lang.format("see-our-web-migration") + "\n");
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
