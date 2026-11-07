// Logins and OAuth state, adapted from UndercoverBurn's auth.ts.
//
// Three Twitch flows share /auth/callback, told apart by the state prefix:
//   channel.<nonce>        a streamer adding the bot (INVITE_SCOPES)
//   bot.<nonce>            the operator connecting the bot account, once
//   login.<nonce>.<next>   anyone signing in for /my or /dashboard
// Each nonce also sits in a short-lived cookie, so a flow started in someone
// else's browser can't be finished in yours. The session cookie is signed
// with ADMIN_KEY.

import { ADMIN_KEY, ADMIN_TWITCH_LOGINS, BASE_URL, CLIENT_ID, REDIRECT_URI } from "./config.ts";
import { getKv, setKv } from "./db.ts";

export type Flow = "channel" | "bot" | "login";
const SESSION_COOKIE = "tc_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const MOD_LIST_TTL_MS = 24 * 60 * 60_000;

export function getCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSec: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Where a login may send you back to.
function safeNext(next: string | null | undefined): string {
  return next && /^\/(my|dashboard)(\?channel=\d{1,20})?$/.test(next) ? next : "/my";
}

export function authorizeUrl(scope: string, state: string, forceVerify = false) {
  const u = new URL("https://id.twitch.tv/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  if (forceVerify) u.searchParams.set("force_verify", "true");
  return u.toString();
}

/** Redirects to Twitch for one of the flows. */
export function startFlow(flow: Flow, scope: string, next?: string | null) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const state = flow === "login" ? `login.${nonce}.${safeNext(next)}` : `${flow}.${nonce}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(scope, state, flow === "bot"),
      "Set-Cookie": cookie(`tc_state_${flow}`, nonce, 600),
    },
  });
}

/** Which flow a callback belongs to, or null when its state doesn't match
 * this browser's cookie. */
export function checkState(req: Request, state: string | null): { flow: Flow; next: string } | null {
  if (!state) return null;
  const [flow, nonce, ...rest] = state.split(".");
  if (flow !== "channel" && flow !== "bot" && flow !== "login") return null;
  const expected = getCookie(req, `tc_state_${flow}`);
  if (!nonce || !expected || !same(nonce, expected)) return null;
  return { flow, next: safeNext(rest.join(".")) };
}

export type SessionUser = { login: string; id: string };

export async function sessionCookie(user: SessionUser): Promise<string> {
  const value = `${user.login.toLowerCase()}.${user.id}.${Date.now() + SESSION_TTL_MS}`;
  return cookie(SESSION_COOKIE, `${value}.${await sign(value)}`, SESSION_TTL_MS / 1000);
}

export function logoutCookie() {
  return cookie(SESSION_COOKIE, "", 0);
}

export async function sessionUser(req: Request): Promise<SessionUser | null> {
  if (!ADMIN_KEY) return null;
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const [login, id, expires, sig] = raw.split(".");
  if (!login || !id || !expires || !sig) return null;
  if (!same(sig, await sign(`${login}.${id}.${expires}`))) return null;
  if (Number(expires) < Date.now()) return null;
  return { login, id };
}

export const isAdmin = (u: SessionUser | null) => !!u && ADMIN_TWITCH_LOGINS.has(u.login);

/** Saves the channels this user moderates (read with their login token). */
export async function saveModeratedChannels(userId: string, token: string) {
  const ids: string[] = [];
  try {
    let after = "";
    do {
      const u = new URL("https://api.twitch.tv/helix/moderation/channels");
      u.searchParams.set("user_id", userId);
      u.searchParams.set("first", "100");
      if (after) u.searchParams.set("after", after);
      const res = await fetch(u, { headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const d = await res.json();
      for (const c of d.data ?? []) ids.push(String(c.broadcaster_id));
      after = d.pagination?.cursor ?? "";
    } while (after);
  } catch (e) {
    console.error("Moderated channels lookup failed:", e);
  }
  await setKv(`modof:${userId}`, JSON.stringify({ at: Date.now(), ids }));
}

/** The channels this user moderates; null when the saved list is stale. */
export async function moderatedChannels(userId: string): Promise<string[] | null> {
  try {
    const saved = JSON.parse((await getKv(`modof:${userId}`)) ?? "null");
    if (!saved || Date.now() - saved.at > MOD_LIST_TTL_MS) return null;
    return saved.ids;
  } catch {
    return null;
  }
}

/** The broadcaster, one of their mods, or an admin. */
export async function canManage(user: SessionUser | null, broadcasterId: string): Promise<boolean> {
  if (!user) return false;
  if (user.id === broadcasterId || isAdmin(user)) return true;
  return (await moderatedChannels(user.id))?.includes(broadcasterId) ?? false;
}

/** Form posts must come from this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin) return origin === new URL(BASE_URL).origin;
  const ref = req.headers.get("Referer");
  return !!ref && ref.startsWith(BASE_URL + "/");
}
