// The web side, called directly (no network to Twitch).   deno task test

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("DB_PATH", ":memory:");
Deno.env.set("ADMIN_KEY", "test-admin-key");
Deno.env.set("EVENTSUB_SECRET", "test-eventsub-secret");
Deno.env.set("PUBLIC_BASE_URL", "https://crier.example");
const { default: handler } = await import("../main.ts");
const db = await import("../db.ts");
const { sessionCookie } = await import("../auth.ts");

const B = "https://crier.example";
const get = (path: string, headers: HeadersInit = {}) => handler(new Request(B + path, { headers, redirect: "manual" }));

Deno.test("pages", async () => {
  assertEquals((await get("/")).status, 200);
  assert((await (await get("/")).text()).includes("Town Crier"));
  assertEquals(await (await get("/health")).text(), "ok");
  assertEquals((await get("/privacy")).status, 200);
  const my = await get("/my");
  assertEquals(my.status, 303);
  assert(my.headers.get("Location")!.includes("/auth/login"));
  const start = await get("/auth/start");
  assertEquals(start.status, 302);
  const loc = new URL(start.headers.get("Location")!);
  assertEquals(loc.searchParams.get("scope"), "channel:bot channel:read:ads");
  assert(loc.searchParams.get("state")!.startsWith("channel."));
});

Deno.test("callback refuses a state this browser didn't start", async () => {
  const res = await get("/auth/callback?code=x&state=channel.abc");
  assertEquals(res.status, 400);
});

async function signed(body: string, type: string) {
  const id = crypto.randomUUID(), ts = new Date().toISOString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-eventsub-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + ts + body)));
  return new Request(B + "/eventsub/callback", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": ts,
      "Twitch-Eventsub-Message-Signature": "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join(""),
      "Twitch-Eventsub-Message-Type": type,
    },
  });
}

Deno.test("eventsub: signature checked, challenge answered, live flag follows", async () => {
  const bad = await handler(new Request(B + "/eventsub/callback", { method: "POST", body: "{}" }));
  assertEquals(bad.status, 403);
  const ok = await handler(await signed(JSON.stringify({ challenge: "abc123" }), "webhook_callback_verification"));
  assertEquals(await ok.text(), "abc123");

  await db.upsertChannel({ id: "42", login: "streamer", displayName: "Streamer", accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "channel:read:ads" });
  await handler(await signed(JSON.stringify({ subscription: { type: "stream.online" }, event: { broadcaster_user_id: "42", broadcaster_user_login: "streamer" } }), "notification"));
  await new Promise((r) => setTimeout(r, 20));
  assertEquals((await db.getChannel("42"))!.is_live, 1);
});

Deno.test("/my: on/off, announcements, remove; strangers refused", async () => {
  const me = { Cookie: (await sessionCookie({ login: "streamer", id: "42" })).split(";")[0], Origin: B };
  await db.setKv("modof:42", JSON.stringify({ at: Date.now(), ids: [] }));
  const page = await (await get("/my", me)).text();
  assert(page.includes("Streamer") && page.includes("Turn off"), page);
  // No bot account yet: say so, rather than look like it's working.
  assert(page.includes("bot account isn't connected"), page);

  const admin = { Cookie: (await sessionCookie({ login: "stonedsheamus", id: "1" })).split(";")[0] };
  const dash = await (await get("/dashboard", admin)).text();
  assert(dash.includes("bot account isn't connected") && dash.includes("Connect the bot account"), dash);

  await db.setKv("bot_user_id", "99");
  await db.setKv("bot_login", "towncrier");
  assert(!(await (await get("/my", me)).text()).includes("bot account isn't connected"));
  assert(!(await (await get("/dashboard", admin)).text()).includes("bot account isn't connected"));
  await db.setKv("bot_user_id", "");
  await db.setKv("bot_login", "");

  const act = (action: string, headers: HeadersInit = me) =>
    handler(new Request(B + "/my/action", { method: "POST", headers, body: new URLSearchParams({ channel: "42", action }), redirect: "manual" }));

  assertEquals((await act("off")).status, 303);
  assertEquals((await db.getChannel("42"))!.enabled, 0);
  await act("on");
  assertEquals((await db.getChannel("42"))!.enabled, 1);
  await act("announce_off");
  assertEquals((await db.getChannel("42"))!.announce, 0);
  await act("announce_on");
  assertEquals((await db.getChannel("42"))!.announce, 1);

  const stranger = { Cookie: (await sessionCookie({ login: "rando", id: "7" })).split(";")[0], Origin: B };
  assertEquals((await act("off", stranger)).status, 403);
  assertEquals((await act("off", { ...me, Origin: "https://evil.example" })).status, 403);

  // Twitch isn't reachable in the test; removal still deletes the data.
  await act("remove");
  assertEquals(await db.getChannel("42"), null);
});
