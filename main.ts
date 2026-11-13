// The web side: OAuth, the EventSub webhook, and the management pages.

import { ADMIN_KEY, BASE_URL, BOT_SCOPES, INVITE_SCOPES, LOGIN_SCOPES, REDIRECT_URI } from "./config.ts";
import { crierName } from "./orrery.ts";
import {
  type Channel,
  deleteChannel,
  ensureTables,
  getChannel,
  getKv,
  listChannels,
  setChannelAnnounce,
  setChannelEnabled,
  setKv,
  setLive,
  upsertChannel,
} from "./db.ts";
import {
  canManage,
  checkState,
  cookie,
  isAdmin,
  logoutCookie,
  moderatedChannels,
  saveModeratedChannels,
  sameOrigin,
  sessionCookie,
  sessionUser,
  startFlow,
} from "./auth.ts";
import { exchangeCode, fetchLive, getUser, saveBotToken, subscribeChannel, unsubscribeChannel, verifyEventSub } from "./twitch.ts";
import { forgetSchedule, onAdBreakBegin } from "./ads.ts";
import { handleChat } from "./commands.ts";
import { botMissingCard, dashboardPage, esc, homePage, type Manageable, messagePage, myPage, page, privacyPage, termsPage } from "./pages.ts";

const redirect = (to: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: to, ...headers } });

// Twitch re-sends a notification it thinks failed; remember recent ids.
const seenMessages = new Map<string, number>();
function seenBefore(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of seenMessages) if (now - t > 15 * 60_000) seenMessages.delete(k);
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, now);
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  await ensureTables();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/") return homePage(await getKv("bot_login"));
  if (path === "/health") return new Response("ok");
  if (path === "/privacy") return privacyPage();
  if (path === "/terms" || path === "/tos") return termsPage();

  // ---- OAuth ----
  if (path === "/auth/start") return startFlow("channel", INVITE_SCOPES);
  if (path === "/auth/login") return startFlow("login", LOGIN_SCOPES, url.searchParams.get("next"));
  if (path === "/auth/logout") return redirect(`${BASE_URL}/`, { "Set-Cookie": logoutCookie() });
  if (path === "/auth/bot-setup") {
    if (!isAdmin(await sessionUser(req))) return redirect(`${BASE_URL}/auth/login?next=/dashboard`);
    return startFlow("bot", BOT_SCOPES);
  }
  if (path === "/auth/callback") return await oauthCallback(req, url);

  // ---- EventSub ----
  if (path === "/eventsub/callback" && req.method === "POST") return await eventSub(req);

  // ---- Management ----
  if (path === "/my") return await myRoute(req, url);
  if (path === "/my/action" && req.method === "POST") return await myAction(req);
  if (path === "/dashboard") return await dashboardRoute(req, url);
  if (path === "/dashboard/action" && req.method === "POST") return await dashboardAction(req);

  return messagePage("Not found", "Nothing here.", 404);
}

async function oauthCallback(req: Request, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) return messagePage("Not authorized", `Twitch said: ${esc(url.searchParams.get("error_description") || error)}`, 400);
  const code = url.searchParams.get("code");
  const flow = checkState(req, url.searchParams.get("state"));
  if (!code || !flow) {
    return messagePage("Link expired", `That sign-in started somewhere else or took too long. <a href="${BASE_URL}/">Start again</a>.`, 400);
  }
  let token;
  try {
    token = await exchangeCode(code, REDIRECT_URI);
  } catch (e) {
    console.error(e);
    return messagePage("Twitch sign-in failed", "Twitch didn't accept the sign-in. Try again.", 502);
  }
  const user = await getUser(token.access_token);
  if (!user) return messagePage("Couldn't identify that account", "Try again.", 502);
  const clearState = cookie(`tc_state_${flow.flow}`, "", 0);
  const headers = new Headers({ "Set-Cookie": clearState });

  if (flow.flow === "login") {
    if (!ADMIN_KEY) return messagePage("Login isn't set up", "The operator hasn't set ADMIN_KEY.", 503);
    await saveModeratedChannels(user.id, token.access_token);
    headers.append("Set-Cookie", await sessionCookie({ login: user.login, id: user.id }));
    headers.set("Location", `${BASE_URL}${flow.next}`);
    return new Response(null, { status: 303, headers });
  }

  if (flow.flow === "bot") {
    if (!isAdmin(await sessionUser(req))) return messagePage("Operators only", "Only the operator can connect the bot account.", 403);
    await setKv("bot_user_id", user.id);
    await setKv("bot_login", user.login);
    await setKv("bot_scope", (token.scope ?? []).join(" "));
    if ((token.scope ?? []).includes("moderator:manage:announcements")) await saveBotToken(token);
    // Now that there's a bot id, every channel can get its chat subscription.
    for (const ch of await listChannels()) await subscribeChannel(ch.broadcaster_id).catch(console.error);
    return page(`<h1>✅ Bot account connected</h1><p><b>${esc(user.display_name)}</b> now speaks as ${crierName()}.</p>
<p><a href="${BASE_URL}/dashboard">Back to the dashboard</a></p>`, { headers });
  }

  // A streamer adding the bot.
  const scope = (token.scope ?? []).join(" ");
  await upsertChannel({
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    scope,
  });
  forgetSchedule(user.id);
  let adEvents = false;
  try {
    adEvents = await subscribeChannel(user.id);
  } catch (e) {
    console.error("Subscribe during install failed:", e);
  }
  // Start out with the right live flag, rather than waiting for stream.online.
  try {
    await setLive(user.id, (await fetchLive([user.id])).has(user.id));
  } catch { /* the next live sync fixes it */ }
  // Signing in comes free with the invite.
  if (ADMIN_KEY) headers.append("Set-Cookie", await sessionCookie({ login: user.login, id: user.id }));
  const botLogin = await getKv("bot_login");
  const botConnected = !!(await getKv("bot_user_id"));
  return page(`<h1>✅ ${crierName()} is in ${esc(user.display_name)}'s channel</h1>
${botConnected ? "" : botMissingCard()}
<p>${adEvents ? "Ad break alerts are on." : "Ad alerts couldn't be switched on yet; the bot will keep trying."}
It only speaks while you're live.</p>
<p>For the highlighted announcement box, make it a mod: <code>/mod ${esc(botLogin ?? "towncrier")}</code>.
Without that, it posts plain chat.</p>
<p><a class="btn" href="${BASE_URL}/my">Manage it</a></p>`, { headers });
}

async function eventSub(req: Request): Promise<Response> {
  const body = await req.text();
  if (!(await verifyEventSub(req, body))) return new Response("Invalid signature", { status: 403 });
  const type = req.headers.get("Twitch-Eventsub-Message-Type");
  const msgId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const data = JSON.parse(body);
  if (type === "webhook_callback_verification") {
    return new Response(data.challenge, { headers: { "Content-Type": "text/plain" } });
  }
  if (type === "revocation") {
    console.log("EventSub revoked:", data.subscription?.type, data.subscription?.status);
    return new Response("");
  }
  if (type !== "notification" || seenBefore(msgId)) return new Response("");
  const ev = data.event ?? {};
  const sub = data.subscription?.type;
  // Answer Twitch fast; do the work after.
  queueMicrotask(async () => {
    try {
      if (sub === "stream.online") {
        console.log(`[${ev.broadcaster_user_login}] went live`);
        await setLive(ev.broadcaster_user_id, true);
        forgetSchedule(ev.broadcaster_user_id);
      } else if (sub === "stream.offline") {
        console.log(`[${ev.broadcaster_user_login}] went offline`);
        await setLive(ev.broadcaster_user_id, false);
      } else if (sub === "channel.ad_break.begin") {
        await onAdBreakBegin(ev, msgId);
      } else if (sub === "channel.chat.message") {
        await handleChat(ev);
      }
    } catch (e) {
      console.error(`EventSub ${sub} failed:`, e);
    }
  });
  return new Response("");
}

// ---- /my ----

async function manageable(user: { login: string; id: string }): Promise<Manageable[]> {
  const all = await listChannels();
  if (isAdmin(user)) return all.map((ch) => ({ ch, canRemove: true }));
  const mods = new Set((await moderatedChannels(user.id)) ?? []);
  return all
    .filter((ch) => ch.broadcaster_id === user.id || mods.has(ch.broadcaster_id))
    .map((ch) => ({ ch, canRemove: ch.broadcaster_id === user.id }))
    .sort((a, b) => Number(b.ch.broadcaster_id === user.id) - Number(a.ch.broadcaster_id === user.id));
}

async function myRoute(req: Request, url: URL): Promise<Response> {
  const user = await sessionUser(req);
  if (!user) return redirect(`${BASE_URL}/auth/login?next=/my`);
  // A mod's list is good for a day; refresh it with a (silent) login.
  if (!isAdmin(user) && (await moderatedChannels(user.id)) === null) return redirect(`${BASE_URL}/auth/login?next=/my`);
  const notices: Record<string, string> = {
    removed: `${crierName()} was removed and its data for that channel deleted.`,
    saved: "Saved.",
  };
  const list = await manageable(user);
  return myPage(
    user.login,
    list,
    list.some((m) => m.ch.broadcaster_id === user.id),
    notices[url.searchParams.get("done") ?? ""] ?? "",
    !!(await getKv("bot_user_id")),
  );
}

async function myAction(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return new Response("Bad origin", { status: 403 });
  const user = await sessionUser(req);
  const form = await req.formData();
  const id = String(form.get("channel") ?? "");
  const action = String(form.get("action") ?? "");
  const ch = await getChannel(id);
  if (!ch || !(await canManage(user, id))) return messagePage("Not allowed", "You can't manage that channel.", 403);
  const back = (req.headers.get("Referer") ?? "").includes("/dashboard") ? "/dashboard" : "/my";
  if (action === "on" || action === "off") await setChannelEnabled(id, action === "on");
  else if (action === "announce_on" || action === "announce_off") await setChannelAnnounce(id, action === "announce_on");
  else if (action === "remove") {
    if (!(user!.id === id || isAdmin(user))) return messagePage("Not allowed", "Only the streamer can remove the bot.", 403);
    await removeChannel(ch);
    return redirect(`${BASE_URL}${back}?done=removed`);
  } else return messagePage("Unknown action", "", 400);
  return redirect(`${BASE_URL}${back}?done=saved`);
}

export async function removeChannel(ch: Channel) {
  await unsubscribeChannel(ch.broadcaster_id);
  await deleteChannel(ch.broadcaster_id);
  forgetSchedule(ch.broadcaster_id);
  console.log(`[${ch.login}] removed`);
}

// ---- /dashboard ----

async function dashboardRoute(req: Request, url: URL): Promise<Response> {
  const user = await sessionUser(req);
  if (!user) return redirect(`${BASE_URL}/auth/login?next=/dashboard`);
  if (!isAdmin(user)) return messagePage("Operators only", `Streamers can manage their channel at <a href="${BASE_URL}/my">/my</a>.`, 403);
  const done = url.searchParams.get("done");
  const channels = await listChannels();
  return dashboardPage({
    admin: user.login,
    botLogin: await getKv("bot_login"),
    botCanChat: ((await getKv("bot_scope")) ?? "").split(/\s+/).includes("user:write:chat"),
    botOn: (await getKv("bot_enabled")) !== "0",
    announceToken: !!JSON.parse((await getKv("bot_token")) || "null")?.refresh_token,
    channels,
    notice: done === "removed" ? "Channel removed." : done ? "Done." : "",
  });
}

async function dashboardAction(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return new Response("Bad origin", { status: 403 });
  if (!isAdmin(await sessionUser(req))) return messagePage("Operators only", "", 403);
  const action = String((await req.formData()).get("action") ?? "");
  if (action === "bot_on" || action === "bot_off") await setKv("bot_enabled", action === "bot_on" ? "1" : "0");
  else if (action === "resync") {
    for (const ch of await listChannels()) await subscribeChannel(ch.broadcaster_id).catch(console.error);
  }
  return redirect(`${BASE_URL}/dashboard?done=1`);
}
