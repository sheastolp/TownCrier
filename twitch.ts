// Everything that talks to Twitch: tokens, EventSub, the ad schedule, and
// posting to chat.

import { CLIENT_ID, CLIENT_SECRET, EVENTSUB_CALLBACK, EVENTSUB_SECRET } from "./config.ts";
import { type Channel, getKv, saveChannelToken, setAdsSubscribed, setKv } from "./db.ts";

const HELIX = "https://api.twitch.tv/helix";

// ---- Tokens ----

async function tokenRequest(params: Record<string, string>) {
  return await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
}

export async function getAppToken(): Promise<string> {
  const cached = JSON.parse((await getKv("app_token")) || "null");
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;
  const res = await tokenRequest({ grant_type: "client_credentials" });
  if (!res.ok) throw new Error(`App token failed: ${res.status} ${await res.text()}`);
  const d = await res.json();
  await setKv("app_token", JSON.stringify({ access_token: d.access_token, expires_at: Date.now() + d.expires_in * 1000 }));
  return d.access_token;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const res = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  if (!res.ok) throw new Error(`Code exchange failed: ${res.status} ${await res.text()}`);
  return await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope?: string[] };
}

export async function getUser(token: string): Promise<{ id: string; login: string; display_name: string } | null> {
  const res = await fetch(`${HELIX}/users`, { headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()).data?.[0] ?? null;
}

/** The streamer's own token (to read their ad schedule), refreshed when
 * close to expiry. Null when they never granted it or revoked the bot. */
export async function getChannelToken(ch: Channel): Promise<string | null> {
  if (!ch.refresh_token) return null;
  if (ch.access_token && ch.token_expires_at > Date.now() + 60_000) return ch.access_token;
  const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: ch.refresh_token });
  if (!res.ok) {
    console.error(`Token refresh failed for ${ch.login}:`, res.status, await res.text());
    // 400/401: the streamer disconnected the bot. Forget the dead token.
    if (res.status === 400 || res.status === 401) await saveChannelToken(ch.broadcaster_id, null, null, 0);
    return null;
  }
  const d = await res.json();
  await saveChannelToken(ch.broadcaster_id, d.access_token, d.refresh_token ?? ch.refresh_token, d.expires_in);
  ch.access_token = d.access_token;
  ch.token_expires_at = Date.now() + d.expires_in * 1000;
  return d.access_token;
}

/** The bot account's user token, for announcements. */
export async function saveBotToken(t: { access_token: string; refresh_token: string; expires_in: number }) {
  await setKv("bot_token", JSON.stringify({ ...t, expires_at: Date.now() + t.expires_in * 1000 }));
}

async function getBotToken(): Promise<string | null> {
  const cached = JSON.parse((await getKv("bot_token")) || "null");
  if (!cached?.refresh_token) return null;
  if (cached.expires_at > Date.now() + 60_000) return cached.access_token;
  const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: cached.refresh_token });
  if (!res.ok) {
    console.error("Bot token refresh failed:", res.status, await res.text());
    if (res.status === 400 || res.status === 401) await setKv("bot_token", "");
    return null;
  }
  const d = await res.json();
  await saveBotToken({ access_token: d.access_token, refresh_token: d.refresh_token ?? cached.refresh_token, expires_in: d.expires_in });
  return d.access_token;
}

// ---- Ad schedule ----

export type AdSchedule = {
  nextAdAt: number; // ms, 0 when nothing is scheduled
  lastAdAt: number; // ms, 0 when unknown
  durationSeconds: number;
  snoozeCount: number;
};

/** Twitch documents next_ad_at/last_ad_at as RFC3339 but has sent Unix
 * seconds too; accepts both. 0 when empty or unparseable. */
export function parseTwitchTime(v: unknown): number {
  if (v === null || v === undefined || v === "" || v === 0) return 0;
  const n = Number(v);
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
  return Date.parse(String(v)) || 0;
}

export async function fetchAdSchedule(ch: Channel): Promise<AdSchedule | null> {
  const token = await getChannelToken(ch);
  if (!token) return null;
  const res = await fetch(`${HELIX}/channels/ads?broadcaster_id=${encodeURIComponent(ch.broadcaster_id)}`, {
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Ad schedule failed for ${ch.login}:`, res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const d = (await res.json())?.data?.[0];
  if (!d) return null;
  return {
    nextAdAt: parseTwitchTime(d.next_ad_at),
    lastAdAt: parseTwitchTime(d.last_ad_at),
    durationSeconds: Math.max(0, Number(d.duration) || 0),
    snoozeCount: Number(d.snooze_count ?? 0),
  };
}

// ---- Live status ----

/** Which of these channels are live right now. */
export async function fetchLive(ids: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  const token = await getAppToken();
  for (let i = 0; i < ids.length; i += 100) {
    const p = new URLSearchParams({ first: "100" });
    for (const id of ids.slice(i, i + 100)) p.append("user_id", id);
    const res = await fetch(`${HELIX}/streams?${p}`, { headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Streams lookup failed: ${res.status}`);
    for (const s of (await res.json()).data ?? []) if (s.type === "live") live.add(String(s.user_id));
  }
  return live;
}

// ---- EventSub ----

async function subscribe(type: string, condition: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const token = await getAppToken();
  const res = await fetch(`${HELIX}/eventsub/subscriptions`, {
    method: "POST",
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      version: "1",
      condition,
      transport: { method: "webhook", callback: EVENTSUB_CALLBACK, secret: EVENTSUB_SECRET },
    }),
  });
  const ok = res.ok || res.status === 409; // 409: already subscribed
  if (!ok) console.error(`EventSub ${type} failed for ${condition.broadcaster_user_id}:`, res.status, await res.text());
  else await res.body?.cancel();
  return { ok, status: res.status };
}

/** stream.online/offline, the ad-break event, and (when the bot account is
 * set up) chat messages for !nextad. Returns whether the ad event exists. */
export async function subscribeChannel(broadcasterId: string): Promise<boolean> {
  await subscribe("stream.online", { broadcaster_user_id: broadcasterId });
  await subscribe("stream.offline", { broadcaster_user_id: broadcasterId });
  const botId = await getKv("bot_user_id");
  if (botId) await subscribe("channel.chat.message", { broadcaster_user_id: broadcasterId, user_id: botId });
  return await subscribeAdBreaks(broadcasterId);
}

export async function subscribeAdBreaks(broadcasterId: string): Promise<boolean> {
  const { ok } = await subscribe("channel.ad_break.begin", { broadcaster_user_id: broadcasterId });
  await setAdsSubscribed(broadcasterId, ok);
  return ok;
}

/** Deletes every subscription this app holds for the channel. Best effort. */
export async function unsubscribeChannel(broadcasterId: string): Promise<number> {
  let deleted = 0;
  try {
    const token = await getAppToken();
    const headers = { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` };
    const ids: string[] = [];
    let cursor = "";
    do {
      const p = new URLSearchParams({ user_id: broadcasterId });
      if (cursor) p.set("after", cursor);
      const res = await fetch(`${HELIX}/eventsub/subscriptions?${p}`, { headers });
      if (!res.ok) break;
      const d = await res.json();
      for (const s of d.data ?? []) if (s?.condition?.broadcaster_user_id === broadcasterId) ids.push(s.id);
      cursor = d.pagination?.cursor ?? "";
    } while (cursor);
    for (const id of ids) {
      const res = await fetch(`${HELIX}/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: "DELETE", headers });
      await res.body?.cancel();
      if (res.ok || res.status === 404) deleted++;
    }
  } catch (e) {
    console.error(`Unsubscribe failed for ${broadcasterId}:`, e);
  }
  return deleted;
}

export async function verifyEventSub(req: Request, body: string): Promise<boolean> {
  const id = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const ts = req.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const sig = req.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  if (!sig || !EVENTSUB_SECRET) return false;
  // Twitch says to refuse messages older than 10 minutes (replays).
  if (Math.abs(Date.now() - Date.parse(ts)) > 10 * 60_000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EVENTSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + ts + body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `sha256=${hex}`;
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- Posting ----

/** Posts one message: as an announcement when asked and possible (the bot
 * must be a mod there), else as plain chat. Returns whether it went out. */
export async function postToChat(
  broadcasterId: string,
  message: string,
  opts: { announce?: boolean; color?: string } = {},
): Promise<boolean> {
  const text = message.slice(0, 500);
  const botId = await getKv("bot_user_id");
  if (!botId || !text.trim()) return false;
  if (opts.announce) {
    const token = await getBotToken();
    if (token) {
      const u = new URL(`${HELIX}/chat/announcements`);
      u.searchParams.set("broadcaster_id", broadcasterId);
      u.searchParams.set("moderator_id", botId);
      const res = await fetch(u, {
        method: "POST",
        headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, color: opts.color ?? "primary" }),
      });
      await res.body?.cancel();
      if (res.ok) {
        console.log(`[${broadcasterId}] announced: ${text}`);
        return true;
      }
      // 403: not a mod in that channel. Fall through to plain chat.
    }
  }
  const res = await fetch(`${HELIX}/chat/messages`, {
    method: "POST",
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${await getAppToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: botId, message: text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.data?.[0]?.is_sent === false) {
    console.error(`[${broadcasterId}] send failed:`, res.status, JSON.stringify(body)?.slice(0, 300));
    return false;
  }
  console.log(`[${broadcasterId}] said: ${text}`);
  return true;
}
