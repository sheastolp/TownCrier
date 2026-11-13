// Town Crier settings. Secrets come from the environment
// (/etc/tavernworks/towncrier.env on the Yoga laptop; see .env.example).
// The timing knobs below are plain constants: change them here.

// The fallback name. The name the bot actually goes by — and the rest of
// its personality — comes from its record in the Grand Orrery (orrery.ts);
// this is only for before the first good read, or ORRERY=off.
export const BOT_NAME = "Town Crier";

export const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") ?? "";
export const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") ?? "";
// Signs login cookies and guards /cron/run. Changing it logs everyone out.
export const ADMIN_KEY = Deno.env.get("ADMIN_KEY") ?? "";
export const EVENTSUB_SECRET = Deno.env.get("EVENTSUB_SECRET") ?? "";

// Twitch accounts allowed into /dashboard and every channel's /my page.
// stonedsheamus, the operator, is always one.
export const ADMIN_TWITCH_LOGINS = new Set([
  "stonedsheamus",
  ...(Deno.env.get("ADMIN_TWITCH_LOGINS") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
]);

export const BASE_URL = (Deno.env.get("PUBLIC_BASE_URL") ?? "https://crier.tavernworks.dev")
  .replace(/\/+$/, "");
export const REDIRECT_URI = Deno.env.get("TWITCH_REDIRECT_URI") ?? `${BASE_URL}/auth/callback`;
export const EVENTSUB_CALLBACK = `${BASE_URL}/eventsub/callback`;
export const SUPPORT_URL = Deno.env.get("SUPPORT_URL") ?? "https://tavernworks.dev/";

// What a streamer grants when adding the bot: channel:bot lets the bot talk
// in their chat (and read commands) without being a mod; channel:read:ads
// lets it read their ad schedule and get ad-break events.
export const INVITE_SCOPES = "channel:bot channel:read:ads";
// What the bot account itself grants, once, at /auth/bot-setup. Twitch's
// Send Chat Message needs user:write:chat as well as user:bot from the
// sender, even when posting with the app token.
export const BOT_SCOPES = "user:bot user:read:chat user:write:chat moderator:manage:announcements";
// The login for /my and /dashboard: identity plus the channels you moderate.
export const LOGIN_SCOPES = "user:read:moderated_channels";

// ---- Timing ----
// The ad engine wakes this often to post anything that's due.
export const TICK_MS = 5_000;
// How often each live channel's ad schedule is fetched from Twitch...
export const SCHEDULE_POLL_MS = 30_000;
// ...and how often once an ad is close (inside the heads-up lead + 1 min) or
// chat was just warned, so snoozes and moves are caught quickly.
export const SCHEDULE_POLL_CLOSE_MS = 10_000;
// The welcome-back goes out this long after the ad's scheduled end.
export const AD_END_DELAY_MS = 6_000;
// A welcome-back this late is dropped instead of posted.
export const AD_END_STALE_MS = 5 * 60_000;
// Twitch's last_ad_at and the EventSub's started_at for the same break can
// differ by a few seconds; anything closer than this is the same break.
export const SAME_BREAK_MS = 60_000;
// A schedule that moves later by more than this after a heads-up, without
// an ad running, was snoozed.
export const SNOOZE_MIN_SHIFT_MS = 30_000;
// Don't post a heads-up with less than this left; the start notice covers it.
export const MIN_WARNING_MS = 10_000;
// Retry a missing ad-break subscription at most this often.
export const SUBSCRIBE_RETRY_MS = 30 * 60_000;
// Live status is re-checked against Twitch this often (and at start-up), in
// case a stream.online/offline event was missed while the laptop was down.
export const LIVE_SYNC_MS = 5 * 60_000;
// !nextad answers at most once per this, per channel.
export const COMMAND_COOLDOWN_MS = 20_000;
// The private helper (words.ts) looks at the watched channel's
// stream this often. It never posts in chat. WORDS=off disables it.
export const WORDS_GRAB_MS = 12_000;
export const WORDS_OFF = (Deno.env.get("WORDS") ?? "").toLowerCase() === "off";
// The heads-up goes out this long before a scheduled ad.
export const HEADS_UP_MS = 60_000;
