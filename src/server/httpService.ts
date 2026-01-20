import http from "node:http";
import type net from "node:net";
import { roomIdToString } from "../common/roomId.js";
import type { ServerState } from "./state.js";
import { Language, tl } from "./l10n.js";

export type HttpService = {
  server: http.Server;
  address: () => net.AddressInfo;
  close: () => Promise<void>;
};

export async function startHttpService(opts: { state: ServerState; host: string; port: number }): Promise<HttpService> {
  const { state } = opts;

  const server = http.createServer((req, res) => {
    void (async () => {
      const lang = req.headers["accept-language"] ? new Language(String(req.headers["accept-language"])) : state.serverLang;
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/room") {
        const out = await state.mutex.runExclusive(async () => {
          const rooms: Array<{
            roomid: string;
            cycle: boolean;
            lock: boolean;
            host: { name: string; id: string };
            state: "select_chart" | "waiting_for_ready" | "playing";
            chart: { name: string; id: string } | null;
            players: Array<{ name: string; id: number }>;
          }> = [];

          let total = 0;
          for (const [rid, room] of state.rooms) {
            const roomid = roomIdToString(rid);
            if (roomid.startsWith("_")) continue;

            const hostUser = state.users.get(room.hostId);
            const hostName = hostUser?.name ?? String(room.hostId);

            const players = room.userIds().map((id) => {
              const u = state.users.get(id);
              return { id, name: u?.name ?? String(id) };
            });
            total += players.length;

            const stateStr =
              room.state.type === "Playing" ? "playing" : room.state.type === "WaitForReady" ? "waiting_for_ready" : "select_chart";

            const chart = room.chart ? { name: room.chart.name, id: String(room.chart.id) } : null;

            rooms.push({
              roomid,
              cycle: room.cycle,
              lock: room.locked,
              host: { name: hostName, id: String(room.hostId) },
              state: stateStr,
              chart,
              players
            });
          }

          rooms.sort((a, b) => a.roomid.localeCompare(b.roomid));
          return { rooms, total };
        });

        const body = JSON.stringify(out);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(tl(lang, "http-not-found"));
    })().catch(() => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const lang = req.headers["accept-language"] ? new Language(String(req.headers["accept-language"])) : state.serverLang;
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(tl(lang, "http-internal-error"));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: opts.host, port: opts.port }, () => resolve());
  });

  return {
    server,
    address: () => server.address() as net.AddressInfo,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  };
}

