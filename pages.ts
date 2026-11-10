// The web pages: home, /my, /dashboard, privacy and terms.

import { BASE_URL, HEADS_UP_MS, SUPPORT_URL } from "./config.ts";
import { crierName, orreryBotPerson } from "./orrery.ts";
import type { Channel } from "./db.ts";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const STYLE = `
:root{--bg:#15100c;--bg2:#1e1611;--card:#241a13;--line:#3a2a1d;--text:#f1e6d6;--muted:#b9a68f;
--gold:#e0a84a;--gold2:#f5c873;--ember:#c9572b;--green:#7fb069;--twitch:#9146ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 Inter,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}
h1,h2,h3{font-family:Cinzel,Georgia,serif;color:var(--gold2);line-height:1.2}
h1{font-size:clamp(32px,7vw,52px);margin:8px 0 4px}
a{color:var(--gold2)}
.muted{color:var(--muted)}
.kicker{font-family:Cinzel,Georgia,serif;letter-spacing:.3em;font-size:13px;color:var(--gold)}
.btn{display:inline-block;background:var(--twitch);color:#fff;border:0;border-radius:10px;padding:10px 18px;
font:600 15px Inter,system-ui,sans-serif;text-decoration:none;cursor:pointer}
.btn.gold{background:var(--gold);color:var(--bg)}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.btn.danger{background:transparent;border:1px solid var(--ember);color:var(--ember)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12.5px;border:1px solid var(--line);color:var(--muted)}
.pill.on{border-color:var(--green);color:var(--green)}
.pill.off{border-color:var(--ember);color:var(--ember)}
.pill.live{background:#e5484d;border-color:#e5484d;color:#fff}
.card.warn{border-color:var(--ember)}
.card.warn h3{color:var(--ember);margin-top:0}
form{display:inline}
ul{padding-left:20px}
code{font-family:ui-monospace,Consolas,monospace;color:var(--gold2)}
footer{margin-top:48px;font-size:14px;color:var(--muted)}
`;

export function page(body: string, opts: { title?: string; status?: number; headers?: HeadersInit } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title ?? crierName())}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📯</text></svg>">
<style>${STYLE}</style></head><body><main>${body}
<footer><a href="${BASE_URL}/">${crierName()}</a> · <a href="${BASE_URL}/my">Manage</a> ·
<a href="${BASE_URL}/privacy">Privacy</a> · <a href="${BASE_URL}/terms">Terms</a> ·
part of <a href="https://tavernworks.dev/">Tavernworks</a></footer></main></body></html>`;
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: opts.status ?? 200, headers });
}

export function messagePage(title: string, text: string, status = 200) {
  return page(`<h1>${esc(title)}</h1><p>${text}</p><p><a href="${BASE_URL}/">Back home</a></p>`, { title, status });
}

export function homePage(botLogin: string | null) {
  const lead = Math.round(HEADS_UP_MS / 1000);
  return page(`
<div class="kicker">TAVERNWORKS</div>
<h1>📯 ${crierName()}</h1>
<p class="muted">A Twitch chat bot that does one thing: ad breaks. Hear ye, hear ye.</p>${orreryBotPerson()?.line ? `\n<p>${esc(orreryBotPerson()!.line)}</p>` : ""}
<div class="card">
<ul>
<li><b>Heads-up</b> about ${lead} seconds before a scheduled ad, with how long it runs and how many snoozes you have left.</li>
<li><b>Snoozed?</b> Chat is told the ads were pushed back, and gets a fresh heads-up later.</li>
<li><b>Ads starting</b> the moment they roll, manual or automatic.</li>
<li><b>Welcome back</b> when they're over.</li>
<li><code>!nextad</code> for anyone who wants to know when the next one is.</li>
</ul>
<p class="muted">Posts as a highlighted announcement when it's a mod in your channel, plain chat otherwise (your choice). Only talks while you're live. Doesn't save your chat.</p>
<p class="row"><a class="btn" href="${BASE_URL}/auth/start">Add ${crierName()} to your channel</a>
<a class="btn ghost" href="${BASE_URL}/my">Manage your channel</a></p>
</div>
<h2>For mods</h2>
<p><code>!crier on</code> / <code>!crier off</code>, <code>!crier announce on</code> / <code>off</code>, and <code>!crier status</code>.
For announcements, make the bot a mod${botLogin ? `: <code>/mod ${esc(botLogin)}</code>` : ""}.</p>`);
}

/** Without a bot account the bot has no one to speak as: no chat
 * subscription, no !nextad, no ad notices. Said wherever someone would
 * otherwise assume it's working. */
export function botMissingCard(forOperator = false) {
  return `<div class="card warn"><h3>⚠️ The bot account isn't connected yet</h3>
<p>Until it is, ${crierName()} can't join chat, answer <code>!nextad</code> or post ad alerts in any channel.</p>
<p class="muted">${
    forOperator
      ? "Click <b>Connect the bot account</b> below and approve it on Twitch <i>as the bot account</i> (switch accounts there if it shows yours). Channels already added start working right away."
      : "That's on the operator's side, not yours. Once it's connected, your channel starts working without adding the bot again."
  }</p></div>`;
}

export type Manageable = { ch: Channel; canRemove: boolean };

function channelCard(m: Manageable, action: string) {
  const c = m.ch;
  const btn = (act: string, label: string, cls = "ghost", confirm = "") =>
    `<form method="post" action="${action}"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ""}>
<input type="hidden" name="channel" value="${esc(c.broadcaster_id)}"><input type="hidden" name="action" value="${act}">
<button class="btn ${cls}">${label}</button></form>`;
  return `<div class="card">
<h3>${esc(c.display_name || c.login)} ${c.is_live ? '<span class="pill live">LIVE</span>' : ""}</h3>
<p class="row">
<span class="pill ${c.enabled ? "on" : "off"}">${c.enabled ? "On" : "Off"}</span>
<span class="pill ${c.announce ? "on" : ""}">${c.announce ? "Announcements" : "Plain chat"}</span>
<span class="pill ${c.refresh_token ? "on" : "off"}">${c.refresh_token ? "Ad schedule connected" : "Ad schedule not connected"}</span>
<span class="pill ${c.ads_subscribed ? "on" : "off"}">${c.ads_subscribed ? "Ad events on" : "Ad events missing"}</span>
</p>
<p class="row">
${c.enabled ? btn("off", "Turn off") : btn("on", "Turn on", "gold")}
${c.announce ? btn("announce_off", "Use plain chat") : btn("announce_on", "Use announcements")}
${m.canRemove ? btn("remove", "Remove from channel", "danger", `Remove ${crierName()} from ${c.login} and delete its data?`) : ""}
</p>
${!c.refresh_token ? `<p class="muted">The streamer needs to <a href="${BASE_URL}/auth/start">add the bot again</a> so it can read the ad schedule.</p>` : ""}
</div>`;
}

export function myPage(login: string, list: Manageable[], ownInstalled: boolean, notice = "", botConnected = true) {
  return page(`
<div class="kicker">MANAGE</div><h1>📯 Your channels</h1>
<p class="muted">Signed in as <b>${esc(login)}</b> · <a href="${BASE_URL}/auth/logout">Log out</a></p>
${notice ? `<div class="card">${notice}</div>` : ""}
${botConnected || !list.length ? "" : botMissingCard()}
${ownInstalled ? "" : `<div class="card"><p>${crierName()} isn't in your channel yet.</p>
<p><a class="btn" href="${BASE_URL}/auth/start">Add ${crierName()} to your channel</a></p></div>`}
${list.map((m) => channelCard(m, `${BASE_URL}/my/action`)).join("")}
${list.length ? "" : '<p class="muted">No channels to manage. Mods: the list comes from Twitch, so channels you were just made a mod in show up after you log in again.</p>'}`, { title: `Manage ${crierName()}` });
}

export function dashboardPage(o: {
  admin: string;
  botLogin: string | null;
  botCanChat?: boolean;
  botOn: boolean;
  announceToken: boolean;
  channels: Channel[];
  notice?: string;
}) {
  const live = o.channels.filter((c) => c.is_live).length;
  const act = (a: string, label: string, cls = "ghost") =>
    `<form method="post" action="${BASE_URL}/dashboard/action"><input type="hidden" name="action" value="${a}"><button class="btn ${cls}">${label}</button></form>`;
  return page(`
<div class="kicker">OPERATOR</div><h1>📯 Dashboard</h1>
<p class="muted">Signed in as <b>${esc(o.admin)}</b> · <a href="${BASE_URL}/auth/logout">Log out</a></p>
${o.notice ? `<div class="card">${o.notice}</div>` : ""}
${o.botLogin ? "" : botMissingCard(true)}
${o.botLogin && !o.botCanChat ? `<div class="card warn"><h3>⚠️ The bot account can't post in chat</h3>
<p>It was connected without permission to send chat messages, so Twitch refuses its replies and ad notices.</p>
<p class="muted">Click <b>Reconnect the bot account</b> below and approve it on Twitch as <b>${esc(o.botLogin)}</b>.</p></div>` : ""}
<div class="card">
<p class="row"><span class="pill ${o.botLogin ? "on" : "off"}">Bot account: ${esc(o.botLogin ?? "not connected")}</span>
<span class="pill ${o.announceToken ? "on" : "off"}">${o.announceToken ? "Can announce" : "No announcement token"}</span>
<span class="pill ${o.botOn ? "on" : "off"}">${o.botOn ? "Running" : "Paused everywhere"}</span>
<span class="pill">${o.channels.length} channel${o.channels.length === 1 ? "" : "s"}, ${live} live</span></p>
<p class="row"><a class="btn" href="${BASE_URL}/auth/bot-setup">${o.botLogin ? "Reconnect" : "Connect"} the bot account</a>
${o.botOn ? act("bot_off", "Pause everywhere") : act("bot_on", "Resume everywhere", "gold")}
${act("resync", "Re-subscribe all channels")}</p>
<p class="muted">Connect the bot while logged in to Twitch <i>as the bot account</i>.</p>
</div>
${o.channels.map((c) => channelCard({ ch: c, canRemove: true }, `${BASE_URL}/my/action`)).join("")}`, { title: `${crierName()} dashboard` });
}

export function privacyPage() {
  return page(`<h1>Privacy</h1>
<p>${crierName()} stores, for each channel it's added to: the channel's Twitch id and name, the Twitch token the streamer
granted (to read the ad schedule), whether the bot is switched on there, and the time of the last ad break.</p>
<p>It reads chat only to answer its own commands (<code>!nextad</code>, <code>!ads</code>, <code>!crier</code>). Chat messages
are never saved. When you log in to manage a channel, it saves your Twitch id and the list of channels you moderate, for a day.</p>
<p>Removing the bot from your channel (on <a href="${BASE_URL}/my">/my</a>) deletes everything stored for it and
cancels its Twitch subscriptions. You can also disconnect it at Twitch → Settings → Connections.</p>
<p>Questions: <a href="${esc(SUPPORT_URL)}">${esc(SUPPORT_URL)}</a></p>`, { title: "Privacy" });
}

export function termsPage() {
  return page(`<h1>Terms</h1>
<p>${crierName()} is a free hobby project, provided as is, with no guarantee that every ad break gets called out on time.
Twitch's ad schedule can change without notice. Don't rely on it for anything that matters.</p>
<p>You can remove it whenever you like. It may be changed or shut down at any time.</p>
<p>Contact: <a href="${esc(SUPPORT_URL)}">${esc(SUPPORT_URL)}</a></p>`, { title: "Terms" });
}
