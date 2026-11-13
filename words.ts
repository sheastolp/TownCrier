// Words on Stream helper: quietly reads the letters on a stream's
// screen and works out the best words they can make.
//
// Shea asked for this on 2026-11-13, with three hard rules:
//   - it NEVER posts in chat (nothing here can send a chat message;
//     this module doesn't import the chat code at all),
//   - the answers live on a private page only the operator can open
//     (a long random token in the URL, shown on the dashboard),
//   - the words are ordinary English, no proper nouns (the word list
//     is the public-domain ENABLE list, which has none).
//
// How it works: for the one channel the operator picks (on this
// page itself, or with the dashboard's per-channel "Word helper"), a
// timer grabs one frame of the stream with streamlink + ffmpeg (the same tools UndercoverBurn
// hears with), reads the big letter tiles with tesseract, and solves
// the anagram against words.txt. The host service needs permission
// to run those three programs (bot-host/setup.sh grants it) and
// tesseract installed; when either is missing the private page says
// so instead of failing silently.
//
// Words on Stream scores a word as the sum of its letters' values,
// which are the familiar Scrabble ones (the game's own FAQ: B=3,
// A=E=I=R=1). Answers are ranked by that score.

import { BASE_URL, WORDS_OFF } from "./config.ts";
import { getKv, listChannels, setKv } from "./db.ts";
import { esc, page } from "./pages.ts";

const STREAMLINK = Deno.env.get("STREAMLINK_PATH") || "streamlink";
const FFMPEG = Deno.env.get("FFMPEG_PATH") || "ffmpeg";
const TESSERACT = Deno.env.get("TESSERACT_PATH") || "tesseract";

// ---- The word list and the solver ----

export const LETTER_VALUES: Record<string, number> = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
  n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
};

export function wordScore(word: string): number {
  let s = 0;
  for (const ch of word) s += LETTER_VALUES[ch] ?? 0;
  return s;
}

const signature = (word: string) => [...word].sort().join("");

let indexPromise: Promise<Map<string, string[]>> | null = null;
/** Every word in words.txt, grouped by its sorted-letters signature. */
export function loadWordIndex(): Promise<Map<string, string[]>> {
  indexPromise ??= (async () => {
    const text = await Deno.readTextFile(new URL("./words.txt", import.meta.url));
    const index = new Map<string, string[]>();
    for (const raw of text.split("\n")) {
      const w = raw.trim().toLowerCase();
      if (!/^[a-z]{2,}$/.test(w)) continue;
      const sig = signature(w);
      const list = index.get(sig);
      if (list) list.push(w);
      else index.set(sig, [w]);
    }
    return index;
  })();
  return indexPromise;
}

export type SolvedWord = { word: string; score: number };

/** All words that can be made from the rack (each tile used at most
 * as many times as it appears), best first: score, then length. */
export async function solveLetters(letters: string): Promise<SolvedWord[]> {
  const index = await loadWordIndex();
  const rack = [...letters.toLowerCase()].filter((c) => c >= "a" && c <= "z").sort();
  const counts = new Map<string, number>();
  for (const c of rack) counts.set(c, (counts.get(c) ?? 0) + 1);
  const distinct = [...counts.keys()];
  const out: SolvedWord[] = [];
  const sig: string[] = [];
  // Walk every sub-multiset of the rack; each is one signature lookup.
  const walk = (i: number) => {
    if (i === distinct.length) {
      if (sig.length >= 2) {
        const words = index.get(sig.join(""));
        if (words) for (const word of words) out.push({ word, score: wordScore(word) });
      }
      return;
    }
    const ch = distinct[i];
    const max = counts.get(ch)!;
    walk(i + 1);
    for (let n = 0; n < max; n++) {
      sig.push(ch);
      walk(i + 1);
    }
    sig.length -= max;
  };
  walk(0);
  out.sort((a, b) => b.score - a.score || b.word.length - a.word.length || (a.word < b.word ? -1 : 1));
  return out;
}

// ---- Reading the letters off the picture ----

export type LetterToken = { letter: string; left: number; top: number; width: number; height: number; conf: number };

// A tile may come through as just its letter, or with its little
// point value stuck to it ("B3", "10Q"); either way the letter is
// the part that matters.
function letterOf(text: string): string | null {
  const m = text.match(/^([A-Za-z])$/) ?? text.match(/^([A-Za-z])\d{1,2}$/) ?? text.match(/^\d{1,2}([A-Za-z])$/);
  return m ? m[1].toUpperCase() : null;
}

/** Single letters out of tesseract's TSV (sparse-text) output. */
export function parseTsvLetters(tsv: string): LetterToken[] {
  const out: LetterToken[] = [];
  const lines = tsv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("\t");
    if (f.length < 12 || f[0] !== "5") continue;
    const letter = letterOf((f[11] ?? "").trim());
    if (!letter) continue;
    const conf = Number(f[10]);
    const height = Number(f[9]);
    if (!Number.isFinite(conf) || conf < 30 || !(height >= 30)) continue;
    out.push({ letter, left: Number(f[6]), top: Number(f[7]), width: Number(f[8]), height, conf });
  }
  return out;
}

/** The rack from the letter tokens: tiles are the big letters, all
 * about the same size; anything much smaller is screen text. Reading
 * order is rows top to bottom, left to right within a row. */
export function pickRack(tokens: LetterToken[]): string {
  if (!tokens.length) return "";
  const heights = tokens.map((t) => t.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  let kept = tokens.filter((t) => t.height >= median * 0.5);
  // The same tile read twice (overlapping boxes): keep the surer one.
  kept.sort((a, b) => b.conf - a.conf);
  const deduped: LetterToken[] = [];
  for (const t of kept) {
    const cx = t.left + t.width / 2, cy = t.top + t.height / 2;
    if (deduped.some((d) => Math.abs(d.left + d.width / 2 - cx) < 18 && Math.abs(d.top + d.height / 2 - cy) < 18)) continue;
    deduped.push(t);
  }
  if (deduped.length > 16) {
    deduped.sort((a, b) => b.height - a.height);
    deduped.length = 16;
  }
  deduped.sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: LetterToken[][] = [];
  for (const t of deduped) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(t.top - row[0].top) < median * 0.5) row.push(t);
    else rows.push([t]);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows.flat().map((t) => t.letter).join("");
}

async function grabFrameJpeg(login: string): Promise<Uint8Array<ArrayBuffer>> {
  const sl = new Deno.Command(STREAMLINK, {
    args: ["--stdout", `https://twitch.tv/${login}`, "best"],
    stdout: "piped",
    stderr: "null",
  });
  const ff = new Deno.Command(FFMPEG, {
    args: ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
      "-vf", "scale=1280:-2", "-f", "mjpeg", "-q:v", "4", "pipe:1"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const slp = sl.spawn();
  const ffp = ff.spawn();
  slp.stdout.pipeTo(ffp.stdin).catch(() => {});
  const killer = setTimeout(() => {
    try { slp.kill(); } catch { /* already gone */ }
    try { ffp.kill(); } catch { /* already gone */ }
  }, 25_000);
  try {
    const out = await ffp.output();
    if (out.code !== 0 || out.stdout.length < 2000) {
      throw new Error(`frame grab failed (ffmpeg code ${out.code}, ${out.stdout.length} bytes)`);
    }
    return out.stdout;
  } finally {
    clearTimeout(killer);
    try { slp.kill(); } catch { /* already gone */ }
  }
}

async function ocrJpeg(jpeg: Uint8Array<ArrayBuffer>): Promise<string> {
  const p = new Deno.Command(TESSERACT, {
    args: ["stdin", "stdout", "--psm", "11", "tsv"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(jpeg);
  await w.close();
  const out = await p.output();
  if (out.code !== 0) throw new Error(`tesseract failed (code ${out.code})`);
  return new TextDecoder().decode(out.stdout);
}

function toolProblem(e: unknown): string | null {
  if (e instanceof Deno.errors.PermissionDenied || (e as Error)?.name === "PermissionDenied") {
    return "the bot's service isn't allowed to run streamlink/ffmpeg/tesseract yet (the host setup grants it)";
  }
  if (e instanceof Deno.errors.NotFound || (e as Error)?.name === "NotFound") {
    return "streamlink, ffmpeg or tesseract isn't installed on the host";
  }
  return null;
}

// ---- State ----

export type WordsState = {
  login: string;
  letters: string;
  words: SolvedWord[];
  total: number;
  status: string;
  manual: boolean;
  updatedAt: number;
};

const frames = new Map<string, Uint8Array<ArrayBuffer>>();
const runtime = new Map<string, { pending: string; pendingCount: number; lastToolLogAt: number; lastManual: string }>();

async function saveState(id: string, state: WordsState) {
  await setKv(`words_state:${id}`, JSON.stringify(state));
}

async function getState(id: string): Promise<WordsState | null> {
  try {
    return JSON.parse((await getKv(`words_state:${id}`)) || "null");
  } catch {
    return null;
  }
}

async function solveAndSave(id: string, login: string, letters: string, manual: boolean, status: string) {
  const all = await solveLetters(letters);
  await saveState(id, {
    login,
    letters,
    words: all.slice(0, 120),
    total: all.length,
    status,
    manual,
    updatedAt: Date.now(),
  });
  console.log(`[words] ${login}: letters ${[...letters].join(" ")} -> ${all.length} words (best: ${all[0]?.word ?? "none"})`);
}

/** One pass over every channel the helper is switched on for. Called
 * on a timer from server.ts; does nothing at all when no channel has
 * it on, and never touches chat. */
export async function tickWords(): Promise<void> {
  if (WORDS_OFF) return;
  const watchedId = await getWatchedChannelId();
  if (!watchedId) return;
  const ch = (await listChannels()).find((c) => c.broadcaster_id === watchedId);
  if (ch) await tickChannel(ch);
}

async function tickChannel(ch: Awaited<ReturnType<typeof listChannels>>[number]): Promise<void> {
    const rt = runtime.get(ch.broadcaster_id) ?? { pending: "", pendingCount: 0, lastToolLogAt: 0, lastManual: "" };
    runtime.set(ch.broadcaster_id, rt);
    const prev = await getState(ch.broadcaster_id);

    // Letters typed in by hand on the private page win over the
    // screen, and pause the camera until they're cleared.
    const manual = ((await getKv(`words_manual:${ch.broadcaster_id}`)) ?? "").toUpperCase();
    if (manual) {
      if (manual !== rt.lastManual) {
        rt.lastManual = manual;
        await solveAndSave(ch.broadcaster_id, ch.login, manual, true, "letters typed in by hand");
      }
      return;
    }
    rt.lastManual = "";

    if (!ch.is_live) {
      if (prev?.status !== "channel offline") {
        await saveState(ch.broadcaster_id, {
          login: ch.login, letters: prev?.letters ?? "", words: prev?.words ?? [],
          total: prev?.total ?? 0, status: "channel offline", manual: false, updatedAt: Date.now(),
        });
      }
      return;
    }

    let jpeg: Uint8Array<ArrayBuffer>;
    try {
      jpeg = await grabFrameJpeg(ch.login);
    } catch (e) {
      await noteProblem(ch.broadcaster_id, ch.login, prev, rt, e, "couldn't grab a frame of the stream");
      return;
    }
    frames.set(ch.broadcaster_id, jpeg);

    let rack: string;
    try {
      rack = pickRack(parseTsvLetters(await ocrJpeg(jpeg)));
    } catch (e) {
      await noteProblem(ch.broadcaster_id, ch.login, prev, rt, e, "couldn't read the frame");
      return;
    }

    if (rack.length < 4) {
      if (prev && prev.status !== "no letters on screen right now") {
        await saveState(ch.broadcaster_id, { ...prev, status: "no letters on screen right now", updatedAt: Date.now() });
      }
      rt.pending = "";
      rt.pendingCount = 0;
      return;
    }
    // A new rack has to read the same way twice running before it's
    // believed: one misread frame shouldn't replace good answers.
    if (prev && rack === prev.letters && !prev.manual) {
      if (prev.status !== "watching") await saveState(ch.broadcaster_id, { ...prev, status: "watching", updatedAt: Date.now() });
      rt.pending = "";
      rt.pendingCount = 0;
      return;
    }
    if (rack === rt.pending) rt.pendingCount++;
    else {
      rt.pending = rack;
      rt.pendingCount = 1;
    }
    if (rt.pendingCount >= 2) {
      rt.pending = "";
      rt.pendingCount = 0;
      await solveAndSave(ch.broadcaster_id, ch.login, rack, false, "watching");
    }
}

async function noteProblem(id: string, login: string, prev: WordsState | null, rt: { lastToolLogAt: number }, e: unknown, what: string) {
  const problem = toolProblem(e);
  const status = problem ?? `${what} — retrying`;
  if (prev?.status !== status) {
    await saveState(id, {
      login, letters: prev?.letters ?? "", words: prev?.words ?? [], total: prev?.total ?? 0,
      status, manual: false, updatedAt: Date.now(),
    });
  }
  if (Date.now() - rt.lastToolLogAt > 10 * 60_000) {
    rt.lastToolLogAt = Date.now();
    console.log(`[words] ${login}: ${what}: ${(e as Error)?.message ?? e}${problem ? ` (${problem})` : ""}`);
  }
}

// ---- The private page ----

/** The one channel the helper watches, picked on the private page
 * (or from the dashboard). Empty means it watches nothing. */
export async function getWatchedChannelId(): Promise<string> {
  return (await getKv("words_channel")) ?? "";
}

export async function setWatchedChannelId(id: string) {
  await setKv("words_channel", id);
}

/** The token for the private URL. Made once, kept in the database,
 * and shown to the operator on the dashboard. */
export async function getWordsToken(): Promise<string> {
  let token = await getKv("words_token");
  if (!token) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await setKv("words_token", token);
  }
  return token;
}

export function wordsUrl(token: string): string {
  return `${BASE_URL}/words/${token}`;
}

async function enabledChannelStates(): Promise<(WordsState & { id: string })[]> {
  const id = await getWatchedChannelId();
  if (!id) return [];
  const ch = (await listChannels()).find((c) => c.broadcaster_id === id);
  if (!ch) return [];
  const state = (await getState(id)) ?? {
    login: ch.login, letters: "", words: [], total: 0,
    status: "waiting for the first look", manual: false, updatedAt: 0,
  };
  return [{ id, ...state }];
}

/** Serves /words/<token> and its data/frame/form endpoints. Returns
 * null when the path isn't this module's. */
export async function wordsRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (!path.startsWith("/words/")) return null;
  const parts = path.split("/").filter(Boolean); // words, token, rest?
  const token = await getWordsToken();
  if (parts[1] !== token) return new Response("Not found", { status: 404 });
  const sub = parts[2] ?? "";

  if (sub === "data") {
    return Response.json({ channels: await enabledChannelStates(), at: Date.now() });
  }
  if (sub === "frame") {
    const id = url.searchParams.get("ch") ?? "";
    const jpeg = frames.get(id);
    if (!jpeg) return new Response("No frame yet", { status: 404 });
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  }
  if (sub === "watch" && req.method === "POST") {
    const form = await req.formData();
    const id = String(form.get("channel") ?? "");
    const ch = (await listChannels()).find((c) => c.broadcaster_id === id);
    await setWatchedChannelId(ch ? id : "");
    if (ch) {
      const rt = runtime.get(id);
      if (rt) { rt.pending = ""; rt.pendingCount = 0; }
      await saveState(id, {
        login: ch.login, letters: "", words: [], total: 0,
        status: ch.is_live ? "waiting for the first look" : "channel offline",
        manual: false, updatedAt: Date.now(),
      });
      console.log(`[words] now watching ${ch.login}`);
    }
    return new Response(null, { status: 303, headers: { Location: wordsUrl(token) } });
  }
  if (sub === "set" && req.method === "POST") {
    const form = await req.formData();
    const id = String(form.get("channel") ?? "");
    const letters = String(form.get("letters") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16);
    const ch = (await listChannels()).find((c) => c.broadcaster_id === id);
    if (ch && letters.length >= 2) {
      await setKv(`words_manual:${id}`, letters);
      const rt = runtime.get(id);
      if (rt) rt.lastManual = ""; // make the next tick resolve at once
      await solveAndSave(id, ch.login, letters, true, "letters typed in by hand");
    }
    return new Response(null, { status: 303, headers: { Location: wordsUrl(token) } });
  }
  if (sub === "clear" && req.method === "POST") {
    const form = await req.formData();
    const id = String(form.get("channel") ?? "");
    await setKv(`words_manual:${id}`, "");
    return new Response(null, { status: 303, headers: { Location: wordsUrl(token) } });
  }
  if (sub !== "") return new Response("Not found", { status: 404 });

  const channels = await listChannels();
  const watchedId = await getWatchedChannelId();
  const watched = channels.find((c) => c.broadcaster_id === watchedId);
  return page(`
<div class="kicker">PRIVATE</div><h1>🔤 Words on Stream helper</h1>
<p class="muted">Only this link can see this page. Nothing here is ever posted in chat.</p>
<div id="out"><p class="muted">Loading…</p></div>
<div class="card"><h3>Watching</h3>
${channels.length ? channels.map((c) => `<p class="row"><b>${esc(c.login)}</b> ${c.is_live ? '<span class="pill live">LIVE</span>' : '<span class="pill">offline</span>'} ${c.broadcaster_id === watchedId ? '<span class="pill on">Watching</span>' : `<form method="post" action="${wordsUrl(token)}/watch"><input type="hidden" name="channel" value="${esc(c.broadcaster_id)}"><button class="btn ghost">Watch this channel</button></form>`}</p>`).join("") : '<p class="muted">The bot is not in any channel yet.</p>'}
${watched ? `<form method="post" action="${wordsUrl(token)}/watch"><input type="hidden" name="channel" value=""><p><button class="btn ghost">Stop watching</button></p></form>` : '<p class="muted">Pick a channel and the helper reads its stream whenever it is live.</p>'}
</div>
${watched ? `<div class="card"><h3>Letters not reading right?</h3>
<form method="post" action="${wordsUrl(token)}/set">
<input type="hidden" name="channel" value="${esc(watched.broadcaster_id)}">
<p class="row"><input name="letters" placeholder="e.g. AILESY" maxlength="16" style="text-transform:uppercase">
<button class="btn gold">Use these letters</button></p></form>
<form method="post" action="${wordsUrl(token)}/clear">
<input type="hidden" name="channel" value="${esc(watched.broadcaster_id)}">
<p class="row"><button class="btn ghost">Back to reading the screen</button></p></form>
<p class="muted">Typed letters pause the screen reading until you switch back.</p></div>` : ""}
<script>
const TOKEN = ${JSON.stringify(token)};
const esc = (s) => String(s ?? "").replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let loadedOnce = false;
async function load() {
  const out = document.getElementById("out");
  let d;
  try {
    const r = await fetch("/words/" + TOKEN + "/data", { cache: "no-store" });
    d = await r.json();
  } catch (e) {
    if (!loadedOnce) out.innerHTML = '<div class="card">Could not load — retrying every few seconds…</div>';
    return;
  }
  loadedOnce = true;
  if (!d.channels.length) { out.innerHTML = '<div class="card">No channel picked yet — choose one under <b>Watching</b> below.</div>'; return; }
  out.innerHTML = d.channels.map((c) => {
    const groups = {};
    for (const w of c.words) (groups[w.word.length] ??= []).push(w);
    const lens = Object.keys(groups).map(Number).sort((a, b) => b - a);
    return '<div class="card"><h3>' + esc(c.login) + ' <span class="pill">' + esc(c.status) + '</span></h3>' +
    (c.letters ? '<p style="font-size:28px;letter-spacing:.35em">' + esc(c.letters) + '</p>' : '<p class="muted">No letters yet.</p>') +
    '<p class="muted">' + c.total + ' words fit' + (c.words.length < c.total ? ' (best ' + c.words.length + ' shown)' : '') +
    (c.updatedAt ? ' — updated ' + new Date(c.updatedAt).toLocaleTimeString() : '') + '</p>' +
    '<p><img src="/words/" + TOKEN + "/frame?ch=' + encodeURIComponent(c.id) + '&t=' + d.at + '" style="max-width:100%;border-radius:8px" onerror="this.parentElement.style.display=\'none\'"></p>' +
    lens.map((n) => '<p><b>' + n + ' letters</b><br>' + groups[n].map((w) => esc(w.word) + ' <span class="muted">' + w.score + '</span>').join(' — ') + '</p>').join("") +
    '</div>';
  }).join("");
}
load();
setInterval(load, 5000);
</script>`, { title: "Words helper (private)" });
}
