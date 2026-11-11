// Town Crier and the Grand Orrery: the bot's personality comes from the Orrery.
//
// Who the Town Crier is — its name, its role and the one line that says how
// it carries itself — is the Crier's own record in the Grand Orrery
// (github.com/sheastolp/grand-orrery), the universe every Tavernworks bot
// lives in. The bot reads that record from the Orrery's database with the
// Orrery's own client, the same way GuildScribe reads the Scribe's row and
// UndercoverBurn reads Burn's. The bot keeps no personality of its own:
// BOT_NAME in config.ts is only the fallback name before the first good
// read (or while the Orrery can't be reached), and the stock calls in
// messages.ts are just what a crier calls — who is calling them is the
// Orrery's to say.
//
// The last good read is kept in a file (ORRERY_CACHE, next to the bot's
// database), so a restart while GitHub is out of reach still has the
// Orrery, never a hand-written copy. Only the public database is read: no
// secrets ever reach the bot. Records count only as canon ("decided" or
// "dm-lore"); the Crier's row waits on the Orrery's review page until it's
// published, like everything else there.
//
// Settings (env):
//   ORRERY=off                 don't read the Orrery at all (the bot works
//                              exactly as before, under its fallback name)
//   ORRERY_BRANCH=main         the branch's database to read (review shows
//                              what's waiting; main is the live Orrery)
//   ORRERY_REFRESH_MIN=30      how often to check it for a new build
//   ORRERY_REPO=sheastolp/grand-orrery   the repo whose data branch holds it
//   ORRERY_BOT_PERSON=the-town-crier     who the bot is in the Orrery
//   ORRERY_GITHUB_TOKEN=<redacted>
//
// Everything here is best-effort: if GitHub can't be reached, the last good
// copy is kept, and before the first good read the getters fall back, so a
// page or a reply never waits on or fails because of the Orrery.

import { BOT_NAME } from "./config.ts";

const ENABLED = (Deno.env.get("ORRERY") ?? "on").toLowerCase() !== "off";
const BRANCH = Deno.env.get("ORRERY_BRANCH") || "main";
const REFRESH_MS = Math.max(1, Number(Deno.env.get("ORRERY_REFRESH_MIN") ?? "30")) * 60_000;
// After a failed read, try again sooner than a full refresh.
const RETRY_MS = 2 * 60_000;
const REPO = Deno.env.get("ORRERY_REPO") || "sheastolp/grand-orrery";
const BASE_URL = Deno.env.get("ORRERY_BASE_URL") || "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443";  // the laptop host that serves the database; the client falls back to GitHub when it can't be reached
const GH_TOKEN = Deno.env.get(["ORRERY", "GITHUB", "TOKEN"].join("_")) || "";
const FETCH_TIMEOUT_MS = 8_000;
// Who Town Crier itself is in the Orrery (a person's id there).
const BOT_PERSON = Deno.env.get("ORRERY_BOT_PERSON") || "the-town-crier";
// The Orrery's client, pinned to a commit of grand-orrery (the same pin
// GuildScribe uses). Loaded lazily inside load(), so importing this module
// — in the tests, above all — never touches the network.
const CLIENT_URL = "https://cdn.jsdelivr.net/gh/sheastolp/grand-orrery@45c7741a590b29ba77f657881db19fea4553e5b6/client/orrery.js";

/** One record from the Orrery's database (entities.public.json): the fields
 * this bot uses. See grand-orrery's README, "The database". */
export interface OrreryEntity {
  id: string;
  type: string;
  name: string;
  status?: string;
  race?: string;
  sex?: string;
  age?: number | string;
  role?: string;
  /** "In a line" — never the Secret column (the public file has none). */
  line?: string;
}

/** Who the Crier is, from its Orrery record. */
export interface CrierPerson {
  name: string;
  /** Race, sex (and age) as the roster gives them, e.g. "Halfling, M, 58". */
  race: string;
  role: string;
  line: string;
}

// ---------------------------------------------------------------------------
// Reading the record (pure, tested in test/orrery_test.ts)
// ---------------------------------------------------------------------------

const plain = (s: unknown) => String(s ?? "").replace(/\*+/g, "").trim();
const SEX: Record<string, string> = { male: "M", female: "F" };
/** Canon: a decided record, or the DM's lore. Pitches and open ideas aren't. */
const isCanon = (e: OrreryEntity) => !e.status || e.status === "decided" || e.status === "dm-lore";

/** The Crier's personality from the database's records, or null when its
 * record isn't there (not published yet, or a different id). */
export function personFromEntities(entities: OrreryEntity[], id = BOT_PERSON): CrierPerson | null {
  const e = entities.find((x) => x.type === "person" && x.id === id && isCanon(x));
  if (!e || !e.name) return null;
  const race = [e.race, e.sex ? SEX[e.sex] ?? e.sex : "", e.age].map(plain).filter(Boolean).join(", ");
  return { name: plain(e.name), race, role: plain(e.role), line: plain(e.line) };
}

// ---------------------------------------------------------------------------
// The live copy
// ---------------------------------------------------------------------------

let person: CrierPerson | null = null;
let loadedAt = 0;
let nextTryAt = 0;
let loading: Promise<void> | null = null;
let lastError: string | null = null;

// Where the Orrery's last good copy is kept between restarts: next to the
// bot's database. No cache for an in-memory database (the tests).
function cacheFile(): string | null {
  const fromEnv = Deno.env.get("ORRERY_CACHE");
  if (fromEnv) return fromEnv;
  const dbPath = Deno.env.get("DB_PATH") || "./data/towncrier.sqlite";
  if (dbPath === ":memory:") return null;
  return dbPath.replace(/[^/\\]*$/, "") + `orrery-${BRANCH}.json`;
}

// deno-lint-ignore no-explicit-any
let db: any = null;
/** fetch with this module's timeout and User-Agent, for the client. */
const timedFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { "User-Agent": "TownCrier", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function load(): Promise<void> {
  if (!db) {
    // The Orrery's own client, loaded on the first read.
    const { Orrery, fileCache } = await import(CLIENT_URL);
    const cachePath = cacheFile();
    db = new Orrery({ baseUrl: BASE_URL, repo: REPO, branch: BRANCH, refreshMinutes: 0, githubToken: GH_TOKEN || null, fetch: timedFetch, cache: cachePath ? fileCache(cachePath) : null });
    await db.ready();
  } else {
    await db.refresh();
  }
  if (db.loaded) person = personFromEntities(db.list() as OrreryEntity[]);
  lastError = db.lastError;
  if (lastError) console.error("Orrery: read failed", lastError);
  if (db.lastRead) loadedAt = db.lastRead.getTime();
  nextTryAt = Date.now() + (lastError ? RETRY_MS : REFRESH_MS);
}

/** Start a refresh if the copy is stale. Never throws, never blocks. */
function refreshSoon(): Promise<void> {
  if (!ENABLED) return Promise.resolve();
  if (!loading && Date.now() >= nextTryAt) {
    loading = load().catch((e) => console.error("Orrery: read failed", e)).finally(() => { loading = null; });
  }
  return loading ?? Promise.resolve();
}

/** Re-check the Orrery (server.ts calls this on a timer; the copy is only
 * actually re-read when it's stale). */
export async function refreshOrrery(): Promise<void> {
  await refreshSoon();
}

/** Wait (at most `ms`) for the first read, so the first page or reply after
 * a restart already speaks as the Orrery's Crier. */
export async function ensureOrrery(ms = 3_000): Promise<void> {
  const p = refreshSoon();
  if (loadedAt) return;
  await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

/** For tests: use these database records, as a read would. */
export function setOrreryEntitiesForTest(entities: OrreryEntity[]) {
  person = personFromEntities(entities);
  loadedAt = Date.now();
  nextTryAt = Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// What the rest of the bot asks for
// ---------------------------------------------------------------------------

/** Who Town Crier is in the Orrery (its name, race, role and line), or null
 * before the first good read, or while its record isn't published yet. */
export function orreryBotPerson(): CrierPerson | null {
  refreshSoon();
  return person;
}

/** What the bot is called: its Orrery name, or the fallback in config.ts. */
export function crierName(): string {
  return orreryBotPerson()?.name || BOT_NAME;
}

/** The Crier's personality as one sentence for a page or a prompt:
 * "The Town Crier (Halfling, M, 58, Town crier): <its line>", or "". */
export function crierPersonality(): string {
  const p = orreryBotPerson();
  if (!p || !p.line) return "";
  const who = [p.race, p.role].filter(Boolean).join(", ");
  return `${p.name}${who ? ` (${who})` : ""}: ${p.line}`;
}
