// Town Crier: the always-on process on the Yoga laptop.
//
// Serves main.ts on 127.0.0.1:PORT, where the Cloudflare Tunnel delivers
// crier.tavernworks.dev, and runs the ad engine's tick every TICK_MS plus a
// live-status sync every LIVE_SYNC_MS (and once at start-up, so a restart
// mid-stream picks up where it left off).
//
//   deno task start    (the systemd unit runs the same thing)

import handler from "./main.ts";
import { BASE_URL, CLIENT_ID, EVENTSUB_SECRET, LIVE_SYNC_MS, TICK_MS } from "./config.ts";
import { ensureTables, listChannels, setLive } from "./db.ts";
import { forgetSchedule, tick } from "./ads.ts";
import { ensureOrrery, refreshOrrery } from "./orrery.ts";
import { fetchLive } from "./twitch.ts";

const PORT = Number(Deno.env.get("PORT") || 8804);
const HOST = Deno.env.get("HOST") || "127.0.0.1";

// Runs fn on a timer, skipping a tick while the last one is still going.
function every(name: string, ms: number, firstMs: number, fn: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`${name} failed:`, e);
    } finally {
      running = false;
    }
  };
  setTimeout(run, firstMs);
  setInterval(run, ms);
}

async function syncLive() {
  const channels = await listChannels();
  if (!channels.length) return;
  const live = await fetchLive(channels.map((c) => c.broadcaster_id));
  for (const c of channels) {
    const now = live.has(c.broadcaster_id);
    if (now !== !!c.is_live) {
      console.log(`[${c.login}] live sync: ${now ? "live" : "offline"}`);
      await setLive(c.broadcaster_id, now);
      forgetSchedule(c.broadcaster_id);
    }
  }
}

await ensureTables();
// The bot's personality comes from the Grand Orrery (orrery.ts): read it
// before the first page or reply, and keep the copy fresh on a timer.
await ensureOrrery();
if (!CLIENT_ID || !EVENTSUB_SECRET) console.warn("TWITCH_CLIENT_ID / EVENTSUB_SECRET not set: see .env.example");
every("orrery", 60_000, 30_000, refreshOrrery);
every("live sync", LIVE_SYNC_MS, 3_000, syncLive);
every("ad tick", TICK_MS, 8_000, tick);

Deno.serve({ port: PORT, hostname: HOST }, (req) => {
  // The tunnel hands requests over as plain http://127.0.0.1; give the
  // handler the public https URL the visitor actually used.
  const url = new URL(req.url);
  return handler(
    new Request(new URL(url.pathname + url.search, BASE_URL), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      duplex: "half",
    } as RequestInit),
  );
});
