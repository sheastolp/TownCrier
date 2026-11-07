// The ad engine against a fake clock and a fake Twitch, in two channels at
// once.   deno task test

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("DB_PATH", ":memory:");
const db = await import("../db.ts");
const ads = await import("../ads.ts");
import type { AdSchedule } from "../twitch.ts";

await db.ensureTables();
await db.setKv("bot_user_id", "999");

let now = Date.parse("2026-06-01T20:00:00Z"); // not October: tavern lines
const schedules = new Map<string, AdSchedule | null>();
const posts: { id: string; text: string }[] = [];
ads.setAdIo({
  now: () => now,
  schedule: (ch) => Promise.resolve(schedules.get(ch.broadcaster_id) ?? null),
  post: (ch, text) => {
    posts.push({ id: ch.broadcaster_id, text });
    return Promise.resolve(true);
  },
  subscribeAds: () => Promise.resolve(true),
});

async function addChannel(id: string, login: string, subscribed: boolean) {
  await db.upsertChannel({ id, login, displayName: login, accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "channel:bot channel:read:ads" });
  await db.setLive(id, true);
  await db.setAdsSubscribed(id, subscribed);
}
await addChannel("1", "alpha", true);
await addChannel("2", "bravo", false); // no ad-break event: relies on the schedule

// Moves the clock forward, ticking every 5 s like server.ts does.
async function run(seconds: number) {
  for (let t = 0; t < seconds; t += 5) {
    now += 5000;
    await ads.tick();
  }
}
const said = (id: string) => posts.filter((p) => p.id === id).map((p) => p.text);
const clear = () => (posts.length = 0);

Deno.test("heads-up once, about a minute before the ad, in each channel", async () => {
  schedules.set("1", { nextAdAt: now + 5 * 60_000, lastAdAt: 0, durationSeconds: 90, snoozeCount: 2 });
  schedules.set("2", { nextAdAt: now + 3 * 60_000, lastAdAt: 0, durationSeconds: 60, snoozeCount: 0 });
  await run(60);
  assertEquals(posts.length, 0, "nothing yet, ads are minutes away");
  await run(90); // bravo's ad is now ~30 s out
  assertEquals(said("2").length, 1);
  assert(said("2")[0].includes("1 min"), said("2")[0]);
  assertEquals(said("1").length, 0);
  await run(120); // alpha's ad is now ~30 s out
  assertEquals(said("1").length, 1);
  assert(said("1")[0].includes("2 snoozes left"), said("1")[0]);
  await run(20);
  assertEquals(posts.length, 2, "no repeats");
  clear();
});

Deno.test("ad starts (event), then welcome-back after it ends", async () => {
  const startedAt = new Date(now).toISOString();
  await ads.onAdBreakBegin({ broadcaster_user_id: "1", duration_seconds: 90, started_at: startedAt }, "msg-1");
  await ads.onAdBreakBegin({ broadcaster_user_id: "1", duration_seconds: 90, started_at: startedAt }, "msg-1"); // re-delivery
  assertEquals(said("1").length, 1);
  assert(said("1")[0].includes("90s"));
  schedules.set("1", { nextAdAt: now + 60 * 60_000, lastAdAt: now, durationSeconds: 90, snoozeCount: 2 });
  await run(80);
  assertEquals(said("1").length, 1, "still running");
  await run(30);
  assertEquals(said("1").length, 2);
  assert(/over|ends|done|end of/i.test(said("1")[1]), said("1")[1]);
  clear();
});

Deno.test("a break with no event is found on the schedule and announced", async () => {
  // bravo's ad ran (it had no subscription, so no event).
  const ranAt = now - 10_000;
  schedules.set("2", { nextAdAt: now + 60 * 60_000, lastAdAt: ranAt, durationSeconds: 60, snoozeCount: 0 });
  await run(30);
  assertEquals(said("2").length, 1, said("2").join(" | "));
  assert(said("2")[0].includes("60s") || said("2")[0].includes("1 min"));
  await run(60);
  assertEquals(said("2").length, 2, "welcome-back");
  clear();
});

Deno.test("a snooze after the heads-up is called out, then re-warned", async () => {
  schedules.set("1", { nextAdAt: now + 50_000, lastAdAt: now - 60 * 60_000, durationSeconds: 90, snoozeCount: 2 });
  ads.forgetSchedule("1"); // as if the 30 s poll just came round
  await run(10);
  assertEquals(said("1").length, 1, "heads-up");
  const warnedFor = schedules.get("1")!.nextAdAt;
  schedules.set("1", { nextAdAt: warnedFor + 5 * 60_000, lastAdAt: now - 60 * 60_000, durationSeconds: 90, snoozeCount: 1 });
  await run(20);
  assertEquals(said("1").length, 2, said("1").join(" | "));
  assert(said("1")[1].includes("5 min"), said("1")[1]);
  await run(5 * 60);
  assertEquals(said("1").length, 3, "a fresh heads-up for the new time");
  assert(said("1")[2].includes("1 snooze left"), said("1")[2]);
  clear();
});

Deno.test("switched off: no notices in that channel, the other carries on", async () => {
  await db.setChannelEnabled("2", false);
  schedules.set("1", { nextAdAt: now + 40_000, lastAdAt: 0, durationSeconds: 30, snoozeCount: 0 });
  schedules.set("2", { nextAdAt: now + 40_000, lastAdAt: 0, durationSeconds: 30, snoozeCount: 0 });
  ads.forgetSchedule("1");
  ads.forgetSchedule("2");
  await run(15);
  await ads.onAdBreakBegin({ broadcaster_user_id: "2", duration_seconds: 30, started_at: new Date(now).toISOString() }, "msg-2");
  assertEquals(said("2").length, 0);
  assertEquals(said("1").length, 1);
  await db.setChannelEnabled("2", true);
  clear();
});

Deno.test("offline: nothing posts, and a running break is dropped", async () => {
  await ads.onAdBreakBegin({ broadcaster_user_id: "1", duration_seconds: 30, started_at: new Date(now).toISOString() }, "msg-3");
  clear();
  await db.setLive("1", false);
  await run(60);
  assertEquals(said("1").length, 0);
});

Deno.test("!nextad text", async () => {
  await db.setLive("1", true);
  schedules.set("1", { nextAdAt: now + 12 * 60_000, lastAdAt: now - 18 * 60_000, durationSeconds: 90, snoozeCount: 0 });
  ads.forgetSchedule("1");
  const text = await ads.nextAdText((await db.getChannel("1"))!);
  assert(text.includes("12 minutes") && text.includes("90s"), text);
});
