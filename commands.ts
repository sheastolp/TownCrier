// Chat commands. Nothing from chat is saved: messages that aren't one of
// these commands are dropped on arrival.
//
//   !nextad, !ads                when the next ad break is (anyone)
//   !crier                       what the bot is
//   !crier on | off              switch it on or off here (broadcaster, mods)
//   !crier announce on | off     announcement box or plain chat (same)
//   !crier status                what it's set to here (same)

import { BASE_URL, COMMAND_COOLDOWN_MS } from "./config.ts";
import { crierName, orreryBotPerson } from "./orrery.ts";
import { getChannel, getKv, setChannelAnnounce, setChannelEnabled } from "./db.ts";
import { nextAdText } from "./ads.ts";
import { postToChat } from "./twitch.ts";

const lastAnswer = new Map<string, number>();

function isMod(event: any): boolean {
  if (event?.chatter_user_id && event.chatter_user_id === event.broadcaster_user_id) return true;
  return (event?.badges ?? []).some((b: any) => b?.set_id === "broadcaster" || b?.set_id === "moderator");
}

export async function handleChat(event: any) {
  const text = String(event?.message?.text ?? "").trim();
  if (!text.startsWith("!")) return;
  const id = String(event?.broadcaster_user_id ?? "");
  if (event?.chatter_user_id && event.chatter_user_id === (await getKv("bot_user_id"))) return;
  const [cmd, ...args] = text.toLowerCase().split(/\s+/);
  if (cmd !== "!nextad" && cmd !== "!ads" && cmd !== "!crier") return;
  const ch = await getChannel(id);
  if (!ch) return;
  const reply = (msg: string) => postToChat(id, msg);

  if (cmd === "!crier" && args.length && isMod(event)) {
    const [sub, val] = args;
    if (sub === "on" || sub === "off") {
      await setChannelEnabled(id, sub === "on");
      return reply(sub === "on" ? `📯 ${crierName()} is on: I'll call out ad breaks here.` : `📯 ${crierName()} is off here. !crier on brings me back.`);
    }
    if (sub === "announce" && (val === "on" || val === "off")) {
      await setChannelAnnounce(id, val === "on");
      return reply(val === "on" ? "📯 Ad notices will go out as announcements (I need to be a mod for that)." : "📯 Ad notices will go out as plain chat messages.");
    }
    if (sub === "status") {
      return reply(
        `📯 ${crierName()} is ${ch.enabled ? "on" : "off"} here; notices as ${ch.announce ? "announcements" : "plain chat"}; ` +
          `ad schedule ${ch.refresh_token ? "connected" : "not connected (re-add the bot)"}. Manage: ${BASE_URL}/my`,
      );
    }
  }

  if (!ch.enabled) return;
  const now = Date.now();
  if (now - (lastAnswer.get(id) ?? 0) < COMMAND_COOLDOWN_MS) return;
  lastAnswer.set(id, now);
  if (cmd === "!crier") {
    const me = orreryBotPerson();
    return reply(`📯 I'm ${crierName()}: I warn chat before ad breaks, call them out, and welcome you back.${me?.line ? ` ${me.line}` : ""} Try !nextad. ${BASE_URL}`);
  }
  await reply(await nextAdText(ch));
}
