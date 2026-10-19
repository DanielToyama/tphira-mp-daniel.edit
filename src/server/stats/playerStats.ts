import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../utils/logger.js";

/** 单个玩家的累计统计 */
export type PlayerStatsRecord = {
  id: number;
  name: string;
  /** 已完成的对局数 */
  plays: number;
  /** 累计分数 */
  totalScore: number;
  /** 累计准度之和（0..1），除以 plays 即平均准度 */
  totalAccuracy: number;
  /** 最近一次游玩时间（毫秒时间戳） */
  lastPlayed: number;
};

/** 排行榜对外输出（平均值已算好） */
export type LeaderboardEntry = {
  id: number;
  name: string;
  plays: number;
  avg_score: number;
  avg_accuracy: number;
  last_played: number;
};

type StatsFile = {
  version: 1;
  players: PlayerStatsRecord[];
};

/** 落盘防抖间隔（毫秒）：避免每局结束都写盘 */
const FLUSH_DEBOUNCE_MS = 2000;

/** 内部累计记录 → 对外条目（平均值已算好） */
function toEntry(it: PlayerStatsRecord): LeaderboardEntry {
  return {
    id: it.id,
    name: it.name,
    plays: it.plays,
    avg_score: it.plays > 0 ? Math.round(it.totalScore / it.plays) : 0,
    avg_accuracy: it.plays > 0 ? it.totalAccuracy / it.plays : 0,
    last_played: it.lastPlayed
  };
}

/**
 * 玩家游玩统计（游玩次数 / 平均分数 / 平均准度）
 *
 * 数据来自每局结算时客户端上报的 Played 命令，落盘到 data/player_stats.json。
 * 写盘沿用管理员数据的「先写 .tmp 再 rename」原子写策略。
 */
export class PlayerStatsStore {
  private readonly path: string;
  private readonly logger: Logger | null;
  private readonly players = new Map<number, PlayerStatsRecord>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(path: string, logger?: Logger) {
    this.path = path;
    this.logger = logger ?? null;
  }

  get filePath(): string {
    return this.path;
  }

  /** 已上榜玩家总数 */
  get size(): number {
    return this.players.size;
  }

  /** 从磁盘加载统计；文件缺失或损坏时静默跳过（从空统计开始） */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<StatsFile>;
      if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.players)) return;
      for (const it of raw.players) {
        if (!it || !Number.isInteger(it.id) || it.id < 0) continue;
        this.players.set(it.id, {
          id: it.id,
          name: typeof it.name === "string" && it.name ? it.name : String(it.id),
          plays: Number.isFinite(it.plays) && it.plays > 0 ? it.plays : 0,
          totalScore: Number.isFinite(it.totalScore) && it.totalScore > 0 ? it.totalScore : 0,
          totalAccuracy: Number.isFinite(it.totalAccuracy) && it.totalAccuracy > 0 ? it.totalAccuracy : 0,
          lastPlayed: Number.isFinite(it.lastPlayed) ? it.lastPlayed : 0
        });
      }
    } catch {
      // 文件不存在或格式错误：从空统计开始
    }
  }

  /** 记录一次完成的对局（结算成功时调用） */
  recordPlay(userId: number, name: string, score: number, accuracy: number): void {
    if (!Number.isInteger(userId) || userId < 0) return;
    const safeScore = Number.isFinite(score) ? score : 0;
    const safeAccuracy = Number.isFinite(accuracy) ? accuracy : 0;
    const now = Date.now();
    const existing = this.players.get(userId);
    if (existing) {
      if (name) existing.name = name;
      existing.plays += 1;
      existing.totalScore += safeScore;
      existing.totalAccuracy += safeAccuracy;
      existing.lastPlayed = now;
    } else {
      this.players.set(userId, {
        id: userId,
        name: name || String(userId),
        plays: 1,
        totalScore: safeScore,
        totalAccuracy: safeAccuracy,
        lastPlayed: now
      });
    }
    this.scheduleFlush();
  }

  /** 按游玩次数降序分页返回排行榜 */
  leaderboard(offset: number, limit: number): { total: number; entries: LeaderboardEntry[] } {
    const all = this.sorted();
    const start = Math.max(0, offset);
    const slice = all.slice(start, start + Math.max(0, limit));
    return { total: all.length, entries: slice.map(toEntry) };
  }

  /** 查询某个用户在排行榜中的名次（1 起）；未上榜返回 null */
  rankOf(userId: number): { rank: number; entry: LeaderboardEntry } | null {
    const all = this.sorted();
    const index = all.findIndex((it) => it.id === userId);
    if (index < 0) return null;
    return { rank: index + 1, entry: toEntry(all[index]!) };
  }

  /** 排行榜排序：游玩次数降序，其次最近游玩，最后 id（保证名次稳定） */
  private sorted(): PlayerStatsRecord[] {
    return [...this.players.values()].sort(
      (a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed || a.id - b.id
    );
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
    const data: StatsFile = { version: 1, players: [...this.players.values()] };
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
      this.logger?.log("ERROR", `[Stats] 玩家统计落盘失败: ${msg}`);
    }
  }
}
