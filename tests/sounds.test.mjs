import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSoundPreferences,
  soundEvents,
  soundPacks,
} from "../src/sounds.ts";

test("every pack defines every event with audible, in-range notes", () => {
  assert.ok(soundPacks.length >= 3);
  for (const pack of soundPacks)
    for (const event of soundEvents) {
      const sound = pack.sounds[event];
      assert.ok(sound?.notes.length, `${pack.id}/${event}`);
      for (const note of sound.notes) {
        assert.ok(note.f >= 100 && note.f <= 4000);
        assert.ok(note.d > 0 && note.t >= 0 && (note.g ?? 0.5) <= 1);
      }
    }
});
test("ring packs repeat slower than one ring phrase lasts", () => {
  for (const pack of soundPacks) {
    const ring = pack.sounds.ring;
    const length = Math.max(...ring.notes.map((n) => n.t + n.d));
    assert.ok(ring.loop > length, pack.id);
  }
});
test("stored preferences are coerced to valid values", () => {
  const bad = parseSoundPreferences({
    enabled: false,
    volume: 9,
    pack: "missing",
    off: ["message", "nope"],
    custom: "x",
  });
  assert.deepEqual(bad, {
    enabled: false,
    volume: 1,
    pack: "chime",
    off: ["message"],
    custom: [],
  });
  assert.equal(parseSoundPreferences(null).enabled, true);
  assert.equal(parseSoundPreferences({ volume: "loud" }).volume, 0.7);
});
test("every pack has a tone cutoff and a positive trim per event", () => {
  for (const pack of soundPacks) {
    assert.ok(pack.tone >= 2000 && pack.tone <= 8000, pack.id);
    for (const event of soundEvents)
      assert.ok(
        pack.trim[event] > 0 && pack.trim[event] < 5,
        `${pack.id}/${event}`,
      );
  }
});
