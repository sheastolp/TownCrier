# 📯 Town Crier

A Twitch chat bot that does one thing: ad breaks. Served at
crier.tavernworks.dev, for any number of channels.

It merges the ad-break alerts that used to live in two bots:
GuildScribe (`dnd-twitch-bot/adalerts.ts`) and UndercoverBurn (`ads.ts`).

| Notice | When | From |
|--------|------|------|
| Heads-up | ~60 s before Twitch's next scheduled ad, once per ad, with the streamer's snoozes left | both (UndercoverBurn's timing, GuildScribe's snooze count) |
| Snoozed | the ad moved later after the heads-up without running; re-warns for the new time | UndercoverBurn |
| Ads starting | `channel.ad_break.begin`, manual or automatic | both |
| Welcome back | when the break's time is up (Twitch has no end event); dropped if 5+ min late | both |
| Missed break | `last_ad_at` on the schedule is newer than the last break on record: logged, and announced if still running and no event will | GuildScribe |

Lines are tavern-flavoured, spooky in October (`messages.ts`).

## For streamers and mods

- **Add it:** https://crier.tavernworks.dev → *Add Town Crier to your
  channel*. That grants `channel:bot` (talk in your chat without being a mod)
  and `channel:read:ads` (read your ad schedule, get ad-break events).
- **Manage it:** https://crier.tavernworks.dev/my (log in with Twitch). The
  broadcaster and their Twitch mods can turn it **on/off** and switch
  **announcements on/off**; the broadcaster can **remove** it (deletes the
  channel's data and Twitch subscriptions).
- **Announcements:** with announcements on, notices go out as the
  highlighted announcement box, which needs the bot to be a mod there. Not a
  mod, or announcements off: plain chat.
- **Chat:** `!nextad` / `!ads` for anyone. Broadcaster and mods:
  `!crier on`, `!crier off`, `!crier announce on|off`, `!crier status`.
- It only talks while the channel is live, and never saves chat.

## For the operator

- `/dashboard` (logins in `ADMIN_TWITCH_LOGINS`, plus `stonedsheamus`):
  connect the bot account, pause/resume everywhere, re-subscribe every
  channel, and the same on/off/announce/remove for any channel.
- **One-time setup:** create a Twitch app with redirect
  `https://crier.tavernworks.dev/auth/callback`, fill in `.env`, start it,
  log in to Twitch in your browser *as the bot account*, open `/dashboard`
  and click *Connect the bot account* (grants `user:bot user:read:chat
  moderator:manage:announcements`). Then add channels from the home page.

## How it runs

One Deno process (`server.ts`) on the Yoga laptop, like the other bots
(see tavernworks `bot-host/README.md`): web on `127.0.0.1:8804` through the
Cloudflare Tunnel, SQLite in `DB_PATH`.

- `ads.ts`, the engine: a tick every 5 s over every live, switched-on
  channel. Each channel's ad schedule is fetched every 30 s, every 10 s when
  an ad is close. Each notice is claimed with a conditional UPDATE before it
  posts, so it goes out at most once. Channels are independent: one
  failing doesn't hold up the others.
- Live status comes from `stream.online/offline`, re-checked against Twitch
  at start-up and every 5 minutes, so a restart mid-stream carries on.
- A missing ad-break subscription is retried every 30 min, so nobody has to
  re-add the bot.
- Twitch's rate limits: the schedule is read with each streamer's own
  token, so it scales per channel; chat posts go through the app token.

```sh
deno task start   # serve + engine
deno task check   # type-check (the laptop's updater runs this before restarting)
deno task test    # engine against a fake clock and Twitch, plus the web side
```

| File | What |
|------|------|
| `server.ts` | the process: HTTP, the tick, live sync |
| `main.ts` | routes: OAuth, EventSub, `/my`, `/dashboard` |
| `ads.ts` | the ad engine |
| `commands.ts` | `!nextad`, `!crier …` |
| `twitch.ts` | tokens, EventSub, ad schedule, posting |
| `auth.ts` | sign-in, mods, OAuth state |
| `db.ts`, `local_sqlite.ts` | storage |
| `messages.ts`, `pages.ts`, `config.ts` | words, HTML, settings |
