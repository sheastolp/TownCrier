// The database: one local SQLite file (DB_PATH, default
// ./data/towncrier.sqlite). Rows come back as objects keyed by column.

import { openLocalSqlite } from "./local_sqlite.ts";

const db = openLocalSqlite(Deno.env.get("DB_PATH") || "./data/towncrier.sqlite", "object");
export const sqlite = { execute: db.execute, batch: db.batch };

let ready: Promise<void> | null = null;
export function ensureTables(): Promise<void> {
  ready ??= createTables().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function createTables() {
  // One row per channel the bot was added to: who they are, their token
  // (to read the ad schedule), and whether the bot is switched on there.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channels (
    broadcaster_id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    display_name TEXT,
    added_at INTEGER NOT NULL,
    is_live INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    announce INTEGER NOT NULL DEFAULT 1,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT '',
    ads_subscribed INTEGER NOT NULL DEFAULT 0,
    subscribe_tried_at INTEGER NOT NULL DEFAULT 0
  )`);
  // One row per channel: where its ad breaks stand.
  //   warned_for          next_ad_at (ms) the heads-up was posted for
  //   warned_at           when that heads-up went out
  //   snooze_noticed_for  warned_for value a snooze notice was posted for
  //   last_ad_at          the most recent break on record (ms)
  //   break_id            the running break (EventSub message id, or
  //                       "schedule:<ms>" for one found on the schedule)
  //   break_ends_at       when its welcome-back is due; 0 once posted
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS ad_state (
    broadcaster_id TEXT PRIMARY KEY,
    warned_for INTEGER NOT NULL DEFAULT 0,
    warned_at INTEGER NOT NULL DEFAULT 0,
    snooze_noticed_for INTEGER NOT NULL DEFAULT 0,
    last_ad_at INTEGER NOT NULL DEFAULT 0,
    last_ad_duration INTEGER NOT NULL DEFAULT 0,
    break_id TEXT NOT NULL DEFAULT '',
    break_ends_at INTEGER NOT NULL DEFAULT 0
  )`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
}

export async function getKv(key: string): Promise<string | null> {
  const { rows } = await sqlite.execute("SELECT value FROM kv WHERE key = ?", [key]);
  return rows.length ? String(rows[0].value ?? "") : null;
}

export async function setKv(key: string, value: string) {
  await sqlite.execute(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// ---- Channels ----

export type Channel = {
  broadcaster_id: string;
  login: string;
  display_name: string | null;
  added_at: number;
  is_live: number;
  enabled: number;
  announce: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number;
  scope: string;
  ads_subscribed: number;
  subscribe_tried_at: number;
};

function toChannel(row: any): Channel {
  return {
    ...row,
    is_live: Number(row.is_live),
    enabled: Number(row.enabled),
    announce: Number(row.announce),
    token_expires_at: Number(row.token_expires_at),
    ads_subscribed: Number(row.ads_subscribed),
    subscribe_tried_at: Number(row.subscribe_tried_at),
  };
}

export async function getChannel(id: string): Promise<Channel | null> {
  const { rows } = await sqlite.execute("SELECT * FROM channels WHERE broadcaster_id = ?", [id]);
  return rows.length ? toChannel(rows[0]) : null;
}

export async function listChannels(where = "1 = 1"): Promise<Channel[]> {
  const { rows } = await sqlite.execute(`SELECT * FROM channels WHERE ${where} ORDER BY login`);
  return rows.map(toChannel);
}

export async function setChannelEnabled(id: string, on: boolean) {
  await sqlite.execute("UPDATE channels SET enabled = ? WHERE broadcaster_id = ?", [on ? 1 : 0, id]);
}

/** On: notices go out as the highlighted announcement box (when the bot is
 * a mod there). Off: always plain chat. */
export async function setChannelAnnounce(id: string, on: boolean) {
  await sqlite.execute("UPDATE channels SET announce = ? WHERE broadcaster_id = ?", [on ? 1 : 0, id]);
}

/** Adds (or refreshes) a channel after the streamer's invite. The on/off
 * switch survives a re-invite. */
export async function upsertChannel(c: {
  id: string;
  login: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}) {
  await sqlite.execute(
    `INSERT INTO channels (broadcaster_id, login, display_name, added_at, access_token, refresh_token, token_expires_at, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET
       login = excluded.login, display_name = excluded.display_name,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at, scope = excluded.scope`,
    [c.id, c.login, c.displayName, Date.now(), c.accessToken, c.refreshToken, Date.now() + c.expiresIn * 1000, c.scope],
  );
}

export async function saveChannelToken(id: string, access: string | null, refresh: string | null, expiresIn: number) {
  await sqlite.execute(
    "UPDATE channels SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE broadcaster_id = ?",
    [access, refresh, access ? Date.now() + expiresIn * 1000 : 0, id],
  );
}

export async function setAdsSubscribed(id: string, on: boolean) {
  await sqlite.execute(
    "UPDATE channels SET ads_subscribed = ?, subscribe_tried_at = ? WHERE broadcaster_id = ?",
    [on ? 1 : 0, Date.now(), id],
  );
}

/** Flips the live flag. A stream ending drops any break or warning in
 * flight, so nothing posts into an offline chat. */
export async function setLive(id: string, live: boolean) {
  await sqlite.execute("UPDATE channels SET is_live = ? WHERE broadcaster_id = ?", [live ? 1 : 0, id]);
  if (!live) {
    await sqlite.execute(
      `UPDATE ad_state SET warned_for = 0, warned_at = 0, snooze_noticed_for = 0, break_id = '', break_ends_at = 0
       WHERE broadcaster_id = ?`,
      [id],
    );
  }
}

/** Deletes everything stored for a channel. The caller cancels its
 * EventSub subscriptions first. */
export async function deleteChannel(id: string) {
  await sqlite.execute("DELETE FROM channels WHERE broadcaster_id = ?", [id]);
  await sqlite.execute("DELETE FROM ad_state WHERE broadcaster_id = ?", [id]);
}

// ---- Ad state ----

export type AdState = {
  warned_for: number;
  warned_at: number;
  snooze_noticed_for: number;
  last_ad_at: number;
  last_ad_duration: number;
  break_id: string;
  break_ends_at: number;
};

export async function getAdState(id: string): Promise<AdState> {
  await sqlite.execute("INSERT OR IGNORE INTO ad_state (broadcaster_id) VALUES (?)", [id]);
  const { rows } = await sqlite.execute("SELECT * FROM ad_state WHERE broadcaster_id = ?", [id]);
  const r = rows[0];
  return {
    warned_for: Number(r.warned_for),
    warned_at: Number(r.warned_at),
    snooze_noticed_for: Number(r.snooze_noticed_for),
    last_ad_at: Number(r.last_ad_at),
    last_ad_duration: Number(r.last_ad_duration),
    break_id: String(r.break_id ?? ""),
    break_ends_at: Number(r.break_ends_at),
  };
}

/** Runs a conditional UPDATE on ad_state; true when it changed a row. Every
 * notice is claimed this way first, so each one posts at most once. */
export async function claimAdState(id: string, set: string, where: string, args: unknown[]): Promise<boolean> {
  await sqlite.execute("INSERT OR IGNORE INTO ad_state (broadcaster_id) VALUES (?)", [id]);
  const r = await sqlite.execute(
    `UPDATE ad_state SET ${set} WHERE (${where}) AND broadcaster_id = ?`,
    [...(args as any[]), id],
  );
  return r.rowsAffected > 0;
}
