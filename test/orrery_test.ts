// The bot's personality from the Grand Orrery: its person record there
// (name, race, role, line), with the config fallback before any read.
// No network: ORRERY=off, and records are fed in as a read would.
//   deno task test

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("DB_PATH", ":memory:");
Deno.env.set("ORRERY", "off");
const orrery = await import("../orrery.ts");
import type { OrreryEntity } from "../orrery.ts";

const CRIER: OrreryEntity = {
  id: "the-town-crier",
  type: "person",
  name: "The Town Crier",
  status: "decided",
  race: "Halfling",
  sex: "male",
  age: 58,
  role: "Town crier",
  line: "Booming, cheerful and impossible to ignore.",
};

Deno.test("personFromEntities: the Crier's record, formatted as the roster gives it", () => {
  const p = orrery.personFromEntities([
    { id: "someone-else", type: "person", name: "Someone Else", status: "decided", line: "Not the crier." },
    CRIER,
  ]);
  assertEquals(p, {
    name: "The Town Crier",
    race: "Halfling, M, 58",
    role: "Town crier",
    line: "Booming, cheerful and impossible to ignore.",
  });
});

Deno.test("personFromEntities: a pitch isn't canon, and other kinds don't count", () => {
  assertEquals(orrery.personFromEntities([{ ...CRIER, status: "idea" }]), null);
  assertEquals(orrery.personFromEntities([{ ...CRIER, type: "place" }]), null);
  assertEquals(orrery.personFromEntities([]), null);
});

Deno.test("the name falls back until a read lands, then it's the Orrery's", () => {
  assertEquals(orrery.orreryBotPerson(), null);
  assertEquals(orrery.crierName(), "Town Crier");
  assertEquals(orrery.crierPersonality(), "");
  orrery.setOrreryEntitiesForTest([CRIER]);
  assertEquals(orrery.crierName(), "The Town Crier");
  assert(orrery.crierPersonality().includes("Halfling, M, 58, Town crier"));
  assert(orrery.crierPersonality().includes("Booming, cheerful"));
});
