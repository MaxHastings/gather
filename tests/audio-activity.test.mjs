import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudioActivity, rms } from "../src/audioActivity.ts";
test("audio activity distinguishes silence, holds briefly, replaces sources and releases monitoring on leave", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const nodes = [],
    activity = [];
  const context = {
    state: "running",
    async resume() {},
    async close() {
      this.state = "closed";
    },
    createMediaStreamSource(stream) {
      const source = {
        connect(analyser) {
          analyser.stream = stream;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      nodes.push(source);
      return source;
    },
    createAnalyser() {
      const analyser = {
        getFloatTimeDomainData(samples) {
          samples.fill(this.stream.level);
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      nodes.push(analyser);
      return analyser;
    },
  };
  const monitor = createAudioActivity(
    (ids) => activity.push([...ids]),
    () => context,
  );
  const stream = { level: 0 };
  monitor.watch("alice", stream);
  t.mock.timers.tick(125);
  assert.deepEqual(activity, []);
  stream.level = 0.1;
  t.mock.timers.tick(125);
  assert.deepEqual(activity.at(-1), ["alice"]);
  stream.level = 0;
  t.mock.timers.tick(125);
  assert.deepEqual(activity.at(-1), ["alice"]);
  t.mock.timers.tick(400);
  assert.deepEqual(activity.at(-1), []);
  monitor.watch("alice", { level: 0.2 });
  assert.equal(nodes[0].disconnected, true);
  assert.equal(nodes[1].disconnected, true);
  t.mock.timers.tick(125);
  assert.deepEqual(activity.at(-1), ["alice"]);
  monitor.stop();
  assert.equal(context.state, "closed");
  assert.ok(nodes.every((node) => node.disconnected));
  const length = activity.length;
  t.mock.timers.tick(10000);
  assert.equal(activity.length, length);
  assert.equal(rms(new Float32Array([0, 0])), 0);
  t.mock.timers.reset();
});
