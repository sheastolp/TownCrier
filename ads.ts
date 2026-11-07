// The ad engine. Merges what GuildScribe (adalerts.ts) and UndercoverBurn
// (ads.ts) each did, for every channel the bot is in:
//
//   • Heads-up: HEADS_UP_MS before Twitch's next scheduled ad (Get Ad
//     Schedule), once per scheduled ad, with the streamer's snoozes left.
//   • Snooze notice: chat was warned, then the ad moved later without
//     running: the streamer snoozed it. Chat is told, and the heads-up
//     re-arms for the new time.
//   • Start notice: channel.ad_break.begin (EventSub), manual or automatic.
//   • End notice: Twitch has no ad-end event, so the start records when the
//     break finishes and the tick posts the welcome-back then. One more
//     than AD_END_STALE_MS late is dropped.
//   • Missed breaks: the schedule's last_ad_at is compared with the last
//     break on record, so a break whose event never arrived (no
//     subscription yet, a dropped webhook, the laptop restarting) is still
//     logged for !nextad, and announced if it's still running.
//   • Missing subscription: created lazily on the next tick, so channels
//     never have to re-add the bot.
//
// A persistent process now (the Yoga laptop, not Val Town), so one in-
// process tick replaces both bots' self-calling HTTP timers and
// chat-activity triggers. Every notice is claimed with a conditional UPDATE
// first, so it posts at most once even if events and ticks race.

import {
  AD_END_DELAY_MS,
  AD_END_STALE_MS,
  HEADS_UP_MS,
  MIN_WARNING_MS,
  SAME_BREAK_MS,
  SCHEDULE_POLL_CLOSE_MS,
  SCHEDULE_POLL_MS,
  SNOOZE_MIN_SHIFT_MS,
  SUBSCRIBE_RETRY_MS,
} from "./config.ts";
import { type Channel, claimAdState, getAdState, getChannel, getKv, listChannels, setLive } from "./db.ts";
import { formatLength, formatUntil, type Kind, message } from "./messages.ts";
import { type AdSchedule, fetchAdSchedule, postToChat, subscribeAdBreaks } from "./twitch.ts";

// What the engine needs from the outside world; tests swap it out.
export type AdIo = {
  now(): number;
  schedule(ch: Channel): Promise<AdSchedule | null>;
  post(ch: Channel, text: string): Promise<boolean>;
  subscribeAds(broadcasterId: string): Promise<boolean>;
};
const realIo: AdIo = {
  now: () => Date.now(),
  schedule: fetchAdSchedule,
  post: (ch, text) => postToChat(ch.broadcaster_id, text, { announce: ch.announce === 1 }),
  subscribeAds: subscribeAdBreaks,
};
let io: AdIo = realIo;
export function setAdIo(overrides: Partial<AdIo> | null) {
  io = overrides ? { ...realIo, ...overrides } : realIo;
}

// The last schedule fetched per channel. Memory only: a restart refetches.
const cache = new Map<string, { at: number; sched: AdSchedule | null }>();
export function forgetSchedule(id: string) {
  cache.delete(id);
}

async function botOn(): Promise<boolean> {
  return (await getKv("bot_enabled")) !== "0" && !!(await getKv("bot_user_id"));
}

async function say(ch: Channel, kind: Kind, vars: Record<string, string>) {
  await io.post(ch, message(kind, vars, new Date(io.now())));
}

const hasAdsScope = (ch: Channel) => ch.scope.split(/\s+/).includes("channel:read:ads");

/** One pass over every live, switched-on channel. Never throws. */
export async function tick() {
  if (!(await botOn())) return;
  for (const ch of await listChannels("is_live = 1 AND enabled = 1")) {
    await checkChannel(ch).catch((e) => console.error(`[${ch.login}] ad check failed:`, e));
  }
}

export async function checkChannel(ch: Channel) {
  const now = io.now();
  const id = ch.broadcaster_id;
  let state = await getAdState(id);

  // ── End notice ──
  if (state.break_ends_at && now >= state.break_ends_at) {
    const endsAt = state.break_ends_at;
    if (await claimAdState(id, "break_ends_at = 0", "break_ends_at = ?", [endsAt])) {
      if (now - endsAt <= AD_END_STALE_MS) await say(ch, "end", {});
    }
    state = await getAdState(id);
  }

  if (!hasAdsScope(ch) || !ch.refresh_token) return;

  // ── Missing ad-break subscription ──
  if (!ch.ads_subscribed && now - ch.subscribe_tried_at > SUBSCRIBE_RETRY_MS) {
    ch.subscribe_tried_at = now;
    ch.ads_subscribed = (await io.subscribeAds(id).catch(() => false)) ? 1 : 0;
  }

  // ── Fetch the schedule (more often when an ad is close) ──
  const cached = cache.get(id);
  const close = (cached?.sched?.nextAdAt && cached.sched.nextAdAt - now < HEADS_UP_MS + 60_000) ||
    (state.warned_for && now < state.warned_for + 60_000);
  if (!cached || now - cached.at >= (close ? SCHEDULE_POLL_CLOSE_MS : SCHEDULE_POLL_MS)) {
    const sched = await io.schedule(ch);
    cache.set(id, { at: now, sched });
    if (sched) {
      await catchMissedBreak(ch, sched, now);
      state = await getAdState(id);
      await checkSnooze(ch, sched, state, now);
      state = await getAdState(id);
    }
  }

  // ── Heads-up ──
  const sched = cache.get(id)?.sched;
  if (!sched?.nextAdAt) return;
  const until = sched.nextAdAt - now;
  if (until <= MIN_WARNING_MS || until > HEADS_UP_MS) return;
  if (state.break_ends_at > now) return; // ads already running
  if (Math.abs(state.warned_for - sched.nextAdAt) <= 5000) return; // already warned
  const claimed = await claimAdState(
    id,
    "warned_for = ?, warned_at = ?",
    "abs(warned_for - ?) > 5000",
    [sched.nextAdAt, now, sched.nextAdAt],
  );
  if (!claimed) return;
  let line = message("warning", { time: formatUntil(until), length: formatLength(sched.durationSeconds) }, new Date(now));
  if (sched.snoozeCount > 0) {
    line += ` (Streamer: ${sched.snoozeCount} snooze${sched.snoozeCount === 1 ? "" : "s"} left if now's a bad time.)`;
  }
  await io.post(ch, line);
}

/** Logs a break Twitch reports that nothing on record has, and announces it
 * when it's still running and no ad-break event will. */
async function catchMissedBreak(ch: Channel, sched: AdSchedule, now: number) {
  const lastAt = sched.lastAdAt;
  if (!lastAt || lastAt > now) return;
  const id = ch.broadcaster_id;
  const logged = await claimAdState(
    id,
    "last_ad_at = ?, last_ad_duration = ?",
    "last_ad_at < ?",
    [lastAt, sched.durationSeconds, lastAt - SAME_BREAK_MS],
  );
  if (!logged) return;
  const runningMs = Math.max(sched.durationSeconds, 30) * 1000;
  if (ch.ads_subscribed || now - lastAt >= runningMs) return;
  const breakId = `schedule:${lastAt}`;
  const endsAt = lastAt + runningMs + AD_END_DELAY_MS;
  if (
    await claimAdState(id, "break_id = ?, break_ends_at = ?, warned_for = 0", "break_id != ? AND break_ends_at = 0", [
      breakId,
      endsAt,
      breakId,
    ])
  ) {
    await say(ch, "start", { length: formatLength(sched.durationSeconds) });
  }
}

/** After a heads-up: the ad moved later without running means a snooze. */
async function checkSnooze(ch: Channel, sched: AdSchedule, state: Awaited<ReturnType<typeof getAdState>>, now: number) {
  const warnedFor = state.warned_for;
  if (!warnedFor || state.snooze_noticed_for === warnedFor) return;
  if (!sched.nextAdAt || sched.nextAdAt - warnedFor < SNOOZE_MIN_SHIFT_MS) return;
  // Did an ad run since the warning? Then the new time is just the next ad.
  const since = state.warned_at - 5000;
  if (state.last_ad_at >= since || sched.lastAdAt >= since || state.break_ends_at > 0) return;
  // Once the ad was due, give its begin event a moment to land before
  // calling it a snooze.
  if (now >= warnedFor - 5000 && now < warnedFor + 15_000) return;
  const claimed = await claimAdState(
    ch.broadcaster_id,
    "snooze_noticed_for = warned_for, warned_for = 0",
    "warned_for = ?",
    [warnedFor],
  );
  if (!claimed) return;
  const delayMin = Math.max(1, Math.round((sched.nextAdAt - warnedFor) / 60_000));
  console.log(`[${ch.login}] ad snoozed ~${delayMin} min`);
  await say(ch, "snooze", { delay: formatLength(delayMin * 60) });
}

/** channel.ad_break.begin. messageId dedupes Twitch's re-deliveries. */
export async function onAdBreakBegin(event: any, messageId: string) {
  const id = String(event?.broadcaster_user_id ?? "");
  const ch = id ? await getChannel(id) : null;
  if (!ch) return;
  const now = io.now();
  const duration = Math.max(0, Math.round(Number(event?.duration_seconds) || 0));
  const startedAt = Date.parse(String(event?.started_at ?? "")) || now;
  const endsAt = startedAt + Math.max(duration, 30) * 1000 + AD_END_DELAY_MS;
  const breakId = messageId || `event:${startedAt}`;
  const fresh = await claimAdState(
    id,
    "break_id = ?, break_ends_at = ?, last_ad_at = ?, last_ad_duration = ?, warned_for = 0",
    "break_id != ?",
    [breakId, endsAt, startedAt, duration, breakId],
  );
  forgetSchedule(id);
  if (!fresh) return;
  console.log(`[${ch.login}] ad break ${duration}s${event?.is_automatic ? " (automatic)" : ""}`);
  // An ad break is proof the stream is live, even if stream.online was missed.
  if (!ch.is_live) await setLive(id, true);
  if (!ch.enabled || !(await botOn())) return;
  await say(ch, "start", { length: formatLength(duration) });
}

/** The !nextad answer. */
export async function nextAdText(ch: Channel): Promise<string> {
  const now = io.now();
  const state = await getAdState(ch.broadcaster_id);
  if (state.break_ends_at > now) {
    return `📯 Ads are running now; back in about ${formatUntil(state.break_ends_at - now)}.`;
  }
  if (!hasAdsScope(ch) || !ch.refresh_token) {
    return "📯 I can't see this channel's ad schedule. The streamer can re-add Town Crier to fix that.";
  }
  let c = cache.get(ch.broadcaster_id);
  if (!c || now - c.at > SCHEDULE_POLL_CLOSE_MS) {
    c = { at: now, sched: await io.schedule(ch) };
    cache.set(ch.broadcaster_id, c);
  }
  const s = c.sched;
  const last = Math.max(state.last_ad_at, s?.lastAdAt ?? 0);
  const lastText = last ? ` Last one was ${formatUntil(now - last)} ago.` : "";
  if (!s?.nextAdAt || s.nextAdAt <= now) return `📯 No ad break is scheduled right now.${lastText}`;
  return `📯 Next ad break in about ${formatUntil(s.nextAdAt - now)} (${formatLength(s.durationSeconds)}).${lastText}`;
}
