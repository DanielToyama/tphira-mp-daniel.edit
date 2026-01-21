import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type ReplayHeader = {
  chartId: number;
  userId: number;
  recordId: number;
};

export type ReplayEntry = {
  chartId: number;
  timestamp: number;
  recordId: number;
  path: string;
};

export function defaultReplayBaseDir(): string {
  return join(process.cwd(), "record");
}

export function replayFilePath(baseDir: string, userId: number, chartId: number, timestamp: number): string {
  return join(baseDir, String(userId), String(chartId), `${timestamp}.phirarec`);
}

export async function ensureReplayDir(baseDir: string, userId: number, chartId: number): Promise<string> {
  const dir = join(baseDir, String(userId), String(chartId));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readReplayHeader(filePath: string): Promise<ReplayHeader | null> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(12);
    const res = await handle.read(buf, 0, 12, 0);
    if (res.bytesRead < 12) return null;
    const chartId = buf.readUInt32LE(0);
    const userId = buf.readUInt32LE(4);
    const recordId = buf.readUInt32LE(8);
    return { chartId, userId, recordId };
  } finally {
    await handle.close();
  }
}

function parseTimestampFromName(name: string): number | null {
  const m = /^(\d+)\.phirarec$/i.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function listReplaysForUser(baseDir: string, userId: number): Promise<Map<number, ReplayEntry[]>> {
  const out = new Map<number, ReplayEntry[]>();
  const userDir = join(baseDir, String(userId));
  let charts: string[];
  try {
    charts = await readdir(userDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return out;
  }
  for (const chartName of charts) {
    const chartId = Number(chartName);
    if (!Number.isInteger(chartId) || chartId < 0) continue;
    const chartDir = join(userDir, chartName);
    let files: string[];
    try {
      files = await readdir(chartDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isFile()).map((e) => e.name));
    } catch {
      continue;
    }
    const entries: ReplayEntry[] = [];
    for (const file of files) {
      const ts = parseTimestampFromName(file);
      if (ts === null) continue;
      const path = join(chartDir, file);
      const header = await readReplayHeader(path).catch(() => null);
      if (!header) continue;
      entries.push({ chartId, timestamp: ts, recordId: header.recordId, path });
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    if (entries.length > 0) out.set(chartId, entries);
  }
  return out;
}

export async function cleanupExpiredReplays(baseDir: string, nowMs: number, ttlDays: number): Promise<void> {
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  let users: string[];
  try {
    users = await readdir(baseDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return;
  }

  for (const userName of users) {
    const userId = Number(userName);
    if (!Number.isInteger(userId) || userId < 0) continue;
    const userDir = join(baseDir, userName);
    let charts: string[];
    try {
      charts = await readdir(userDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      continue;
    }

    for (const chartName of charts) {
      const chartId = Number(chartName);
      if (!Number.isInteger(chartId) || chartId < 0) continue;
      const chartDir = join(userDir, chartName);
      let files: string[];
      try {
        files = await readdir(chartDir, { withFileTypes: true }).then((ents) => ents.filter((e) => e.isFile()).map((e) => e.name));
      } catch {
        continue;
      }

      for (const file of files) {
        const ts = parseTimestampFromName(file);
        if (ts === null) continue;
        if (nowMs - ts <= ttlMs) continue;
        await rm(join(chartDir, file), { force: true }).catch(() => {});
      }

      const remain = await readdir(chartDir).catch(() => []);
      if (remain.length === 0) await rm(chartDir, { recursive: true, force: true }).catch(() => {});
    }

    const remainUser = await readdir(userDir).catch(() => []);
    if (remainUser.length === 0) await rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function patchReplayRecordId(filePath: string, recordId: number): Promise<void> {
  if (!Number.isInteger(recordId) || recordId < 0) return;
  const handle = await open(filePath, "r+");
  try {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(recordId >>> 0, 0);
    await handle.write(buf, 0, 4, 8);
  } finally {
    await handle.close();
  }
}
