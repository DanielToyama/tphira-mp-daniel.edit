import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../utils/logger.js";

/** 一天的长度（毫秒），仅用于换算「离开几天」这类整数天差 */
const DAY_MS = 86_400_000;

/** 落盘防抖间隔（毫秒） */
const FLUSH_DEBOUNCE_MS = 2000;

/** 深夜文案覆盖的时段（服务器本地时间，含起不含止） */
export const LATE_NIGHT_START_HOUR = 0;
export const LATE_NIGHT_END_HOUR = 6;

/**
 * 同一账号两次「计入统计」的最小间隔。
 * 客户端连接多是短平快的（开房、看一眼、断线重连），半小时内反复连不该算多次到访。
 */
export const VISIT_COOLDOWN_MS = 30 * 60 * 1000;

/** 客户端里程碑彩蛋触发点 */
export const VISIT_MILESTONES: readonly number[] = [10, 50, 100, 200, 500, 1000];

/**
 * 房间名彩蛋：只认这几个固定 ASCII 名，命中只累加计数，
 * 原始房间名一律不入库（避免任何需要审核的用户文本）。
 */
export const ROOM_NAME_EASTER_EGGS: readonly string[] = ["hello", "test", "123"];

/** 单个账号的访问记录 */
export type VisitRecord = {
  id: number;
  name: string;
  /** 永久编号：首次出现顺序，从 1 起 */
  number: number;
  /** 本功能上线后累计的连接次数 */
  visits: number;
  /** 首次记录时快照的历史游玩次数（真实历史，作为次数基数，避免与后续对局重复计数） */
  baselinePlays: number;
  /** 首次带日期连接时间（毫秒） */
  firstSeenAt: number;
  /** 最近一次连接时间（毫秒） */
  lastSeenAt: number;
  /** 最近一次「计入统计」的连接时间（毫秒）；冷却以它为基准，避免频繁重连把窗口一直往后推 */
  lastCountedAt: number;
  /** 最近一次连接所在自然日（YYYY-MM-DD）；与今天不同即视为新的一天 */
  lastSeenDate: string;
  /** 有记录的天数（不同自然日的个数） */
  days: number;
};

/** 一天内的聚合计数，跨天时整体重置 */
type DailyState = {
  date: string;
  /** 当日连接总次数（含同一账号多次） */
  connections: number;
  /** 当日新账号数 */
  newAccounts: number;
  /** 当日连入过的账号 id，按首次连入顺序 */
  users: number[];
  /** 当日每小时连入次数，键为 0-23 */
  hours: Record<string, number>;
};

/** 当日房间名聚合：只统计特征，不保存原始房间名 */
type RoomDailyState = {
  /** 当日创建的房间数 */
  created: number;
  /** 最长房间名字符数 */
  maxNameLength: number;
  /** 含数字的房间名个数 */
  withDigit: number;
  /** 命中彩蛋名的次数 */
  easter: Record<string, number>;
};

type VisitFile = {
  version: 1;
  /** 服务器上线日期（本功能首次启动），用于「服务器第 X 天」 */
  bornDate: string;
  bornAt: number;
  daily: DailyState;
  rooms: RoomDailyState;
  players: VisitRecord[];
};

/** 一次连接产生的派生结果，供欢迎文案使用 */
export type VisitOutcome = {
  /** 累计次数（历史游玩次数基数 + 本期连接次数，含本次） */
  totalVisits: number;
  /** 本次之前来过多少次 */
  previousVisits: number;
  /** 本次是否是该账号第一个有记录日 */
  firstRecordedDay: boolean;
  /** 有记录的第几天（本次计入后） */
  recordedDays: number;
  /** 距上次连接隔了整几天（同日为 0） */
  gapDays: number;
  /** 永久编号 */
  number: number;
  /** 是否首次出现在记录里 */
  isNewAccount: boolean;
  /** 离开期间服务器新增的账号数 */
  newAccountsWhileAway: number;
  /** 今日第几位连入（1 起） */
  todayOrdinal: number;
  /** 今日连入的不同账号数（本次计入后） */
  todayUsers: number;
  /** 本次连接的小时（服务器本地时间 0-23） */
  hour: number;
  /** 该小时今日是否只有自己连入过 */
  aloneInHour: boolean;
  /** 本次是否真的计入了统计（冷却期内为 false，只刷新了最近连接时间） */
  counted: boolean;
};

/** 全局面板快照 */
export type VisitSnapshot = {
  /** 服务器上线日期 YYYY-MM-DD */
  bornDate: string;
  /** 今天是服务器第几天（1 起） */
  serverDay: number;
  /** 今天日期 YYYY-MM-DD */
  today: string;
  /** 存档里出现过的账号总数 */
  totalAccounts: number;
  /** 今日连接次数 */
  todayConnections: number;
  /** 今日连入的不同账号数 */
  todayUsers: number;
  /** 今日新账号数 */
  todayNewAccounts: number;
  /** 今日房间名聚合 */
  roomStats: {
    created: number;
    maxNameLength: number;
    withDigit: number;
    /** 含数字房间名占比（0..1） */
    digitRatio: number;
    /** 命中彩蛋名的次数，键为彩蛋名 */
    easter: Record<string, number>;
  };
};

/** 把毫秒时间戳转成服务器本地自然日 YYYY-MM-DD */
export function toDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 自然日序号（按 UTC 取整，仅用于做差，避免夏令时影响） */
function dateOrdinal(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS);
}

function emptyDaily(date: string): DailyState {
  return { date, connections: 0, newAccounts: 0, users: [], hours: {} };
}

function emptyRooms(): RoomDailyState {
  return { created: 0, maxNameLength: 0, withDigit: 0, easter: {} };
}

/**
 * 账号级访问统计（用户粘性企划的数据层）
 *
 * 口径说明（重要，避免编造历史）：
 * - 次数 = 首次记录时快照的历史游玩次数（真实历史）+ 本功能上线后的连接次数；
 * - 日期只从本功能上线起记录，历史日期不做任何推测；
 * - 永久编号按首次出现顺序从 1 分配，同样只覆盖上线后出现过的账号；
 * - 房间名只聚合成「长度/是否含数字/是否命中彩蛋」，原始字符串不落盘。
 */
export class VisitStatsStore {
  private readonly path: string;
  private readonly logger: Logger | null;
  private readonly players = new Map<number, VisitRecord>();
  private bornDate = "";
  private bornAt = 0;
  private daily: DailyState = emptyDaily("");
  private rooms: RoomDailyState = emptyRooms();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(path: string, logger?: Logger) {
    this.path = path;
    this.logger = logger ?? null;
  }

  get filePath(): string {
    return this.path;
  }

  /** 从磁盘加载；文件缺失或损坏时按「今天首次上线」初始化 */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<VisitFile>;
      if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.players)) {
        this.initFresh();
        return;
      }
      this.bornDate = typeof raw.bornDate === "string" && raw.bornDate ? raw.bornDate : toDateKey(Date.now());
      this.bornAt = Number.isFinite(raw.bornAt) ? Number(raw.bornAt) : Date.now();
      this.daily = sanitizeDaily(raw.daily);
      this.rooms = sanitizeRooms(raw.rooms);
      for (const it of raw.players) {
        if (!it || !Number.isInteger(it.id) || it.id < 0) continue;
        this.players.set(it.id, {
          id: it.id,
          name: typeof it.name === "string" && it.name ? it.name : String(it.id),
          number: Number.isInteger(it.number) && it.number > 0 ? it.number : this.players.size + 1,
          visits: Number.isFinite(it.visits) && it.visits > 0 ? Math.floor(it.visits) : 0,
          baselinePlays: Number.isFinite(it.baselinePlays) && it.baselinePlays > 0 ? Math.floor(it.baselinePlays) : 0,
          firstSeenAt: Number.isFinite(it.firstSeenAt) ? it.firstSeenAt : Date.now(),
          lastSeenAt: Number.isFinite(it.lastSeenAt) ? it.lastSeenAt : Date.now(),
          // 旧存档没有该字段时退化为 lastSeenAt，冷却行为与升级前一致
          lastCountedAt: Number.isFinite((it as Partial<VisitRecord>).lastCountedAt)
            ? Number((it as Partial<VisitRecord>).lastCountedAt)
            : Number.isFinite(it.lastSeenAt)
              ? it.lastSeenAt
              : Date.now(),
          lastSeenDate: typeof it.lastSeenDate === "string" && it.lastSeenDate ? it.lastSeenDate : toDateKey(Date.now()),
          days: Number.isFinite(it.days) && it.days > 0 ? Math.floor(it.days) : 1
        });
      }
    } catch {
      this.initFresh();
    }
  }

  private initFresh(): void {
    const now = Date.now();
    const today = toDateKey(now);
    this.bornAt = now;
    this.bornDate = today;
    this.daily = emptyDaily(today);
    this.rooms = emptyRooms();
    this.players.clear();
  }

  /** 记录一次连接，返回本次的派生结果 */
  recordVisit(userId: number, name: string, baselinePlays = 0, now: number = Date.now()): VisitOutcome {
    this.rollDaily(now);
    const today = toDateKey(now);
    const prev = this.players.get(userId);
    const isNewAccount = !prev;

    // 冷却期：同一自然日内、距上次连接不足 30 分钟，视为同一次到访的延续。
    // 只刷新最近连接时间，不动次数/天数/日计数，避免短平快重连把次数刷上去。
    if (prev && prev.lastSeenDate === today && now - prev.lastCountedAt < VISIT_COOLDOWN_MS) {
      prev.lastSeenAt = now;
      if (name) prev.name = name;
      // 重启导致当日 users 丢失时补登记（今天确实连过），但不累加 connections
      let idx = this.daily.users.indexOf(userId);
      if (idx < 0) {
        this.daily.users.push(userId);
        idx = this.daily.users.length - 1;
      }
      this.scheduleFlush();
      const total = prev.baselinePlays + prev.visits;
      return {
        totalVisits: total,
        previousVisits: Math.max(0, total - 1),
        firstRecordedDay: false,
        recordedDays: prev.days,
        gapDays: 0,
        number: prev.number,
        isNewAccount: false,
        newAccountsWhileAway: 0,
        todayOrdinal: idx + 1,
        todayUsers: this.daily.users.length,
        hour: new Date(now).getHours(),
        aloneInHour: false,
        counted: false
      };
    }

    // 下面会就地更新 record，先把「上一次」的时间点存下来，供间隔与新增账号数计算
    const prevLastSeenAt = prev?.lastSeenAt ?? 0;
    const prevLastSeenDate = prev?.lastSeenDate ?? today;

    let record: VisitRecord;
    if (prev) {
      record = prev;
      record.visits += 1;
      record.lastSeenAt = now;
      record.lastCountedAt = now;
      if (record.lastSeenDate !== today) {
        record.lastSeenDate = today;
        record.days += 1;
      }
      if (name) record.name = name;
    } else {
      const safeBaseline = Number.isFinite(baselinePlays) && baselinePlays > 0 ? Math.floor(baselinePlays) : 0;
      record = {
        id: userId,
        name: name || String(userId),
        number: this.players.size + 1,
        visits: 1,
        baselinePlays: safeBaseline,
        firstSeenAt: now,
        lastSeenAt: now,
        lastCountedAt: now,
        lastSeenDate: today,
        days: 1
      };
      this.players.set(userId, record);
      this.daily.newAccounts += 1;
    }

    this.daily.connections += 1;
    let todayOrdinal = this.daily.users.indexOf(userId) + 1;
    if (todayOrdinal === 0) {
      this.daily.users.push(userId);
      todayOrdinal = this.daily.users.length;
    }

    const hour = new Date(now).getHours();
    const hourKey = String(hour);
    this.daily.hours[hourKey] = (this.daily.hours[hourKey] ?? 0) + 1;

    const gapDays = prev ? Math.max(0, dateOrdinal(today) - dateOrdinal(prevLastSeenDate)) : 0;
    // 离开期间新增的账号：首次出现时间晚于本账号上次连接时间
    const newAccountsWhileAway = prev
      ? [...this.players.values()].filter((it) => it.id !== userId && it.firstSeenAt > prevLastSeenAt).length
      : 0;

    const totalVisits = record.baselinePlays + record.visits;
    this.scheduleFlush();

    return {
      totalVisits,
      previousVisits: Math.max(0, totalVisits - 1),
      firstRecordedDay: isNewAccount,
      recordedDays: record.days,
      gapDays,
      number: record.number,
      isNewAccount,
      newAccountsWhileAway,
      todayOrdinal,
      todayUsers: this.daily.users.length,
      hour,
      aloneInHour: this.daily.hours[hourKey] === 1,
      counted: true
    };
  }

  /** 记录一次建房（只聚合特征，不保存房间名原文） */
  recordRoomName(rawId: string, now: number = Date.now()): void {
    this.rollDaily(now);
    this.rooms.created += 1;
    this.rooms.maxNameLength = Math.max(this.rooms.maxNameLength, rawId.length);
    if (/\d/.test(rawId)) this.rooms.withDigit += 1;
    const lower = rawId.trim().toLowerCase();
    if (ROOM_NAME_EASTER_EGGS.includes(lower)) {
      this.rooms.easter[lower] = (this.rooms.easter[lower] ?? 0) + 1;
    }
    this.scheduleFlush();
  }

  /** 全局面板快照 */
  snapshot(now: number = Date.now()): VisitSnapshot {
    this.rollDaily(now);
    const today = toDateKey(now);
    return {
      bornDate: this.bornDate,
      serverDay: Math.max(1, dateOrdinal(today) - dateOrdinal(this.bornDate) + 1),
      today,
      totalAccounts: this.players.size,
      todayConnections: this.daily.connections,
      todayUsers: this.daily.users.length,
      todayNewAccounts: this.daily.newAccounts,
      roomStats: {
        created: this.rooms.created,
        maxNameLength: this.rooms.maxNameLength,
        withDigit: this.rooms.withDigit,
        digitRatio: this.rooms.created > 0 ? this.rooms.withDigit / this.rooms.created : 0,
        easter: { ...this.rooms.easter }
      }
    };
  }

  /** 某账号的记录（测试/调试用） */
  get(userId: number): VisitRecord | undefined {
    return this.players.get(userId);
  }

  /** 跨天时重置当日计数 */
  private rollDaily(now: number): void {
    const today = toDateKey(now);
    if (!this.bornDate) {
      this.bornDate = today;
      this.bornAt = now;
    }
    if (this.daily.date === today) return;
    this.daily = emptyDaily(today);
    this.rooms = emptyRooms();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  /** 立即落盘（进程退出前调用） */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const data: VisitFile = {
      version: 1,
      bornDate: this.bornDate,
      bornAt: this.bornAt,
      daily: this.daily,
      rooms: this.rooms,
      players: [...this.players.values()]
    };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      try {
        await rename(tmp, this.path);
      } catch {
        try {
          await unlink(this.path);
        } catch {
          // 文件可能不存在
        }
        await rename(tmp, this.path);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger?.log("ERROR", `[Visit] 访问统计落盘失败: ${msg}`);
    }
  }
}

function sanitizeDaily(raw: unknown): DailyState {
  const today = toDateKey(Date.now());
  if (!raw || typeof raw !== "object") return emptyDaily(today);
  const it = raw as Partial<DailyState>;
  if (typeof it.date !== "string" || it.date !== today) return emptyDaily(today);
  return {
    date: it.date,
    connections: Number.isFinite(it.connections) ? Math.max(0, Math.floor(Number(it.connections))) : 0,
    newAccounts: Number.isFinite(it.newAccounts) ? Math.max(0, Math.floor(Number(it.newAccounts))) : 0,
    users: Array.isArray(it.users) ? it.users.filter((n) => Number.isInteger(n)) : [],
    hours: it.hours && typeof it.hours === "object" ? { ...it.hours } : {}
  };
}

function sanitizeRooms(raw: unknown): RoomDailyState {
  if (!raw || typeof raw !== "object") return emptyRooms();
  const it = raw as Partial<RoomDailyState>;
  return {
    created: Number.isFinite(it.created) ? Math.max(0, Math.floor(Number(it.created))) : 0,
    maxNameLength: Number.isFinite(it.maxNameLength) ? Math.max(0, Math.floor(Number(it.maxNameLength))) : 0,
    withDigit: Number.isFinite(it.withDigit) ? Math.max(0, Math.floor(Number(it.withDigit))) : 0,
    easter: it.easter && typeof it.easter === "object" ? { ...it.easter } : {}
  };
}
