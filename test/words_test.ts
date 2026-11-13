// The private helper: solver, OCR token picking, the token
// route, and the tick's offline/tool-missing behaviour. No network
// and no chat anywhere: DB is in memory, and the "channel" is fake.
//   deno task test

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

Deno.env.set("DB_PATH", ":memory:");
const words = await import("../words.ts");
const db = await import("../db.ts");
await db.ensureTables();

Deno.test("word scores match the game's own example", () => {
  // The game's own FAQ example: BARRIER scores 9 (R=1, I=1, E=1, A=1, B=3).
  assertEquals(words.wordScore("barrier"), 9);
  assertEquals(words.wordScore("easily"), 9); // e1 a1 s1 i1 l1 y4
});

Deno.test("solver finds the level-1 words and only uses the rack", async () => {
  const solved = await words.solveLetters("AILESY");
  const names = solved.map((s) => s.word);
  assert(names.includes("easily"), "the full-rack word is there");
  assertEquals(solved[0].word, "easily");
  assert(names.includes("aisle") && names.includes("seal") && names.includes("sly"));
  // Nothing uses a letter the rack doesn't have, or one twice.
  const rack: Record<string, number> = {};
  for (const c of "ailesy") rack[c] = (rack[c] ?? 0) + 1;
  for (const s of solved) {
    const used: Record<string, number> = {};
    for (const c of s.word) used[c] = (used[c] ?? 0) + 1;
    for (const [c, n] of Object.entries(used)) assert((rack[c] ?? 0) >= n, `${s.word} overuses ${c}`);
    assertEquals(s.score, words.wordScore(s.word));
  }
  // Best first.
  for (let i = 1; i < solved.length; i++) assert(solved[i - 1].score >= solved[i].score);
});

const tsvRow = (text: string, left: number, top: number, w: number, h: number, conf: number) =>
  ["5", "1", "1", "1", "1", "1", left, top, w, h, conf, text].join("\t");
const TSV_HEAD = ["level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text"].join("\t");

Deno.test("OCR tokens: big tile letters in, screen text and points out", () => {
  const tiles = ["A", "I", "L", "E", "S", "Y"].map((L, i) => tsvRow(L, 300 + i * 110, 400, 90, 90, 95));
  const tsv = [TSV_HEAD,
    ...tiles,
    tsvRow("B3", 300, 700, 90, 90, 88), // a tile read with its points: letter B
    tsvRow("Chat", 10, 10, 60, 16, 90), // small screen text: not a single letter
    tsvRow("i", 20, 40, 8, 14, 90), // single letter but tiny: under the size floor
    tsvRow("7", 500, 900, 20, 30, 90), // a stray point value on its own
    tsvRow("GO", 900, 100, 120, 40, 90), // two letters: not one tile
  ].join("\n");
  const tokens = words.parseTsvLetters(tsv);
  assertEquals(tokens.map((t) => t.letter).sort().join(""), "ABEILSY");
  assertEquals(words.pickRack(tokens.slice(0, 6)), "AILESY");
});

Deno.test("pickRack reads rows top to bottom", () => {
  const row = (letters: string, top: number, left0: number) =>
    [...letters].map((letter, i) => ({ letter, left: left0 + i * 110, top, width: 90, height: 90, conf: 95 }));
  assertEquals(words.pickRack([...row("DEF", 500, 300), ...row("ABC", 300, 300)]), "ABCDEF");
  assertEquals(words.pickRack([]), "");
});

Deno.test("the private page 404s without the token", async () => {
  const url = new URL("https://crier.tavernworks.dev/w/nope");
  const res = await words.wordsRoute(new Request(url), url, "/w/nope");
  assertEquals(res?.status, 404);
  const token = await words.getWordsToken();
  assert(/^[0-9a-f]{32}$/.test(token), "token is 32 hex chars");
  assertEquals(await words.getWordsToken(), token, "token is stable");
  const okUrl = new URL(`https://crier.tavernworks.dev/w/${token}/data`);
  const ok = await words.wordsRoute(new Request(okUrl), okUrl, `/w/${token}/data`);
  assertEquals(ok?.status, 200);
  const data = await ok!.json();
  assertEquals(data.channels, []);
});

Deno.test("the page's channel picker sets the watched channel", async () => {
  await db.upsertChannel({
    id: "4242", login: "fakechannel", displayName: "Fake",
    accessToken: "x", refreshToken: "y", expiresIn: 3600, scope: "",
  });
  const token = await words.getWordsToken();
  const form = new FormData();
  form.set("channel", "4242");
  const url = new URL(`https://crier.tavernworks.dev/w/${token}/watch`);
  const res = await words.wordsRoute(new Request(url, { method: "POST", body: form }), url, `/w/${token}/watch`);
  assertEquals(res?.status, 303);
  assertEquals(await db.getKv("words_channel"), "4242");
  const dataUrl = new URL(`https://crier.tavernworks.dev/w/${token}/data`);
  const data = await (await words.wordsRoute(new Request(dataUrl), dataUrl, `/w/${token}/data`))!.json();
  assertEquals(data.channels.length, 1);
  assertEquals(data.channels[0].login, "fakechannel");
});

Deno.test("tick: offline channel noted, live channel reports missing tools", async () => {
  await db.upsertChannel({
    id: "4242", login: "fakechannel", displayName: "Fake",
    accessToken: "x", refreshToken: "y", expiresIn: 3600, scope: "",
  });
  await db.setKv("words_channel", "4242");
  await words.tickWords();
  let state = JSON.parse((await db.getKv("words_state:4242"))!);
  assertEquals(state.status, "channel offline");
  await db.setLive("4242", true);
  await words.tickWords();
  state = JSON.parse((await db.getKv("words_state:4242"))!);
  // This machine has no streamlink: the page must say what's missing
  // rather than failing silently.
  assertStringIncludes(state.status, "isn't installed on the host");
});
