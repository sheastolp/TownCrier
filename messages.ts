// What Town Crier says. One line is picked at random.
// {length}: how long the ads run ("90s", "3 min").
// {time}:   how long until they start ("60 seconds").
// {delay}:  how far a snooze pushed them back ("5 min").

export type Kind = "warning" | "start" | "end" | "snooze";

const TAVERN: Record<Kind, string[]> = {
  warning: [
    "📯 Hear ye! Ads in about {time}, running {length}. Refill the tankard now.",
    "📯 Hear ye, hear ye: an ad break of {length} rolls in ~{time}. Stretch those legs!",
    "📯 The crier rings the bell: ads in {time} for {length}. Grab a snack from the tavern kitchen.",
  ],
  start: [
    "📯 Ad break! {length} of ads rolling now. Stretch your legs, refill the tankard, and we'll be right back.",
    "📯 The bard takes an intermission: {length} of ads starting now. Hydrate, adventurers!",
    "📯 Ads are running ({length}). A short rest for the party; the tale resumes shortly.",
    "📯 {length} ad break underway. Perfect time for a snack from the tavern kitchen.",
  ],
  end: [
    "📯 Ads are over. Welcome back, adventurers! The tale resumes.",
    "📯 The intermission ends. Ads are done; back to the adventure!",
    "📯 Ad break's over. Grab your dice, we march on!",
    "📯 That's the end of the ads. The bard returns to the stage!",
  ],
  snooze: [
    "📯 Belay that! The streamer snoozed the ads for {delay}. As you were.",
    "📯 False alarm, good folk: ads pushed back {delay}. Put the snacks back (or don't).",
    "📯 The ads were sent away for {delay}. The crier will ring again before they come.",
  ],
};

// October only.
const SPOOKY: Record<Kind, string[]> = {
  warning: [
    "🎃 Hear ye! Ads creep in about {time}, running {length}. Grab your candy now.",
    "🦇 Something wicked this way comes in ~{time}: ads, for {length}.",
  ],
  start: [
    "🎃 Ad break! {length} of ads creeping in. Raid the candy bowl before the ghosts do.",
    "👻 The stream is haunted by ads for {length}. Don't go into the basement alone, chat.",
    "🦇 Ads rising from the grave for {length}. Stretch before your legs turn to bones.",
  ],
  end: [
    "👻 The ads have been exorcised. Welcome back!",
    "🎃 And we're back from the dead! Hope you saved some candy, chat.",
  ],
  snooze: [
    "😴 Ads snoozed! The ghosts are back in their coffins for another {delay}.",
    "👻 False alarm, chat: the ads got scared off for {delay}.",
  ],
};

export function linesFor(kind: Kind, now = new Date()): string[] {
  return (now.getMonth() === 9 ? SPOOKY : TAVERN)[kind];
}

export function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** "45s", "90s", "2 min", "3m 30s". */
export function formatLength(seconds: number): string {
  seconds = Math.round(seconds);
  if (seconds <= 0) return "a short";
  if (seconds < 120 && seconds % 60 !== 0) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m} min`;
}

/** "60 seconds", "2 minutes". */
export function formatUntil(ms: number): string {
  const secs = Math.max(5, Math.round(ms / 5000) * 5);
  if (secs < 90) return `${secs} seconds`;
  const m = Math.round(secs / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export function fill(line: string, vars: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (all, k) => vars[k] ?? all);
}

export function message(kind: Kind, vars: Record<string, string>, now = new Date()): string {
  return fill(pick(linesFor(kind, now)), vars);
}
