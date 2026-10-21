/**
 * 欢迎消息生成模块
 *
 * 在用户认证成功后,生成包含房间列表、服务器提示、站点与群组信息的欢迎消息,
 * 以系统聊天形式发送给用户。
 */
import type { ServerState } from "../../core/state.js";
import type { User } from "../../game/user.js";
import type { Language } from "../../utils/l10n.js";
import { getAvailableRoomsText } from "./roomListCache.js";
import { quoteForDate } from "../../stats/dailyQuote.js";
import {
  LATE_NIGHT_END_HOUR,
  LATE_NIGHT_START_HOUR,
  VISIT_MILESTONES,
  type VisitOutcome,
  type VisitSnapshot
} from "../../stats/visitStats.js";

export type HitokotoValue = { quote: string; from: string };

/**
 * 人少文案的触发阈值：在线人数不超过该值时，才会说「现在只有 N 人在线」。
 * 人多了这句会失去稀缺感，反而显得奇怪。
 */
const FEW_ONLINE_THRESHOLD = 5;

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
 * 生成「用户粘性」相关的欢迎文案行（个人数据 + 全局今日数据 + 每日一句）。
 *
 * 口径（与 visitStats 保持一致，不编造历史）：
 * - 次数含首次记录时快照的历史游玩次数，所以老账号连上就能看到真实次数；
 * - 日期只从本功能上线起算，`firstRecordedDay` 为真时明确告知「从今天起开始记天数」。
 *
 * @param lang - 展示语言
 * @param outcome - 本次连接的派生结果
 * @param global - 全局面板快照
 * @param onlineCount - 当前在线人数（含本人）
 * @param roomCount - 当前房间数
 */
export function buildVisitLines(opts: {
  lang: Language;
  outcome: VisitOutcome;
  global: VisitSnapshot;
  onlineCount: number;
  roomCount: number;
}): string[] {
  const { lang, outcome, global, onlineCount, roomCount } = opts;
  const lines: string[] = [];
  const total = String(outcome.totalVisits);

  // ---- 个人：次数与天数 ----
  if (outcome.firstRecordedDay) {
    if (outcome.totalVisits > 1) {
      // 老账号：历史次数是真实游玩数据，日期从今天开始
      lines.push(lang.format("visit-old-account", { count: String(outcome.previousVisits) }));
      lines.push(lang.format("visit-first-recorded"));
    } else {
      lines.push(lang.format("visit-welcome-first"));
    }
  } else {
    // 回归（隔 ≥2 天）优先用更具体的文案
    if (outcome.gapDays >= 2) {
      lines.push(lang.format("visit-return", { total, gap: String(outcome.gapDays) }));
      if (outcome.newAccountsWhileAway > 0) {
        lines.push(
          lang.format("visit-new-accounts-while-away", {
            gap: String(outcome.gapDays),
            count: String(outcome.newAccountsWhileAway)
          })
        );
      }
    } else {
      lines.push(lang.format("visit-daily", { total, days: String(outcome.recordedDays) }));
      if (outcome.gapDays === 1) lines.push(lang.format("visit-last-seen", { gap: "1" }));
    }
  }

  // ---- 个人：里程碑 ----
  if (VISIT_MILESTONES.includes(outcome.totalVisits)) {
    lines.push(lang.format("visit-milestone", { total }));
  }

  // ---- 个人：编号（元老感） ----
  lines.push(
    lang.format("visit-veteran", {
      number: String(outcome.number),
      padded: String(outcome.number).padStart(4, "0")
    })
  );

  // ---- 个人：人少与深夜 ----
  if (onlineCount <= FEW_ONLINE_THRESHOLD) {
    lines.push(lang.format("visit-few-online", { online: String(onlineCount) }));
  }
  if (outcome.hour >= LATE_NIGHT_START_HOUR && outcome.hour < LATE_NIGHT_END_HOUR) {
    // 只有自己一个人时用更具体的「唯一」文案，否则用氛围文案，避免两句叠在一起啰嗦
    lines.push(
      outcome.aloneInHour
        ? lang.format("visit-alone-in-hour", { hour: String(outcome.hour) })
        : lang.format("visit-late-night", { hour: String(outcome.hour) })
    );
  }

  // ---- 全局：今日人格 ----
  lines.push(lang.format("visit-server-day", { day: String(global.serverDay) }));
  lines.push(
    lang.format("visit-today-ordinal", {
      count: String(global.todayUsers),
      ordinal: String(outcome.todayOrdinal)
    })
  );
  lines.push(lang.format("visit-online-summary", { users: String(onlineCount), rooms: String(roomCount) }));

  // ---- 每日一句 ----
  const daily = quoteForDate(global.today);
  lines.push(lang.format("visit-daily-quote", { quote: daily.quote, from: daily.from }));

  return lines;
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
 * @param opts.visit - 本次连接的访问统计派生结果；缺省时不展示个人粘性文案
 */
export async function sendWelcomeExtras(opts: {
  user: User;
  state: ServerState;
  sendSystemChat: (content: string) => Promise<void>;
  hitokoto?: HitokotoValue | null;
  visit?: VisitOutcome | null;
}): Promise<void> {
  const { user, state, sendSystemChat, visit } = opts;
  try {
    const lang = user.lang;
    const tip = state.config.room_list_tip;
    const sep = "=".repeat(73) + "\n";

    const parts: string[] = [];
    parts.push("\n".repeat(40));
    parts.push(lang.format("chat-welcome", { userName: user.name, serverName: state.serverName }) + "\n");
    parts.push(sep);
    // 个人 / 今日 / 每日一句：放在最靠前的位置，玩家一进来就能看到
    if (visit) {
      const visitLines = buildVisitLines({
        lang,
        outcome: visit,
        global: state.visitStats.snapshot(),
        onlineCount: state.users.size,
        roomCount: state.rooms.size
      });
      for (const line of visitLines) parts.push(line + "\n");
      parts.push(sep);
    }
    parts.push(lang.format("chat-welcome-version", { version: state.version }) + "\n");
    parts.push(sep);
    parts.push(lang.format("chat-roomlist-title") + "\n");
    parts.push(getAvailableRoomsText(state, lang) + "\n");
    parts.push(lang.format("welcome-hidden-room-tip") + "\n");
    parts.push(sep);
    if (tip) parts.push(tip + "\n");

    // 站点与群组信息(替代此前的"一言"展示)
    parts.push(sep);
    parts.push(lang.format("welcome-site-tip") + "\n");
    parts.push(lang.format("welcome-max-players") + "\n");
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
