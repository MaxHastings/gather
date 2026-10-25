import { test } from "node:test";
import assert from "node:assert/strict";
import { audioError, captureMicrophone } from "../src/audio.ts";

const microphone = () => {
  const track = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
};
test("missing saved microphone retries default once; permissions never trigger a retry", async () => {
  const constraints = [],
    stream = microphone();
  const result = await captureMicrophone("unplugged", {
    async getUserMedia(config) {
      constraints.push(config);
      if (constraints.length === 1)
        throw new DOMException("Object not found", "NotFoundError");
      return stream;
    },
  });
  assert.equal(result.stream, stream);
  assert.equal(result.deviceId, "default");
  assert.deepEqual(constraints[0].audio.deviceId, { exact: "unplugged" });
  assert.equal(constraints[1].audio.deviceId, undefined);
  let calls = 0;
  await assert.rejects(
    captureMicrophone("private", {
      async getUserMedia() {
        calls++;
        throw new DOMException("Denied", "NotAllowedError");
      },
    }),
    { name: "NotAllowedError" },
  );
  assert.equal(calls, 1);
});
test("audio errors explain absent, denied, busy and unsupported microphones", async () => {
  assert.match(
    audioError(new DOMException("Object not found", "NotFoundError")),
    /No microphone found/,
  );
  assert.match(
    audioError(new DOMException("", "NotAllowedError")),
    /access is blocked/,
  );
  assert.match(
    audioError(new DOMException("", "NotReadableError")),
    /exclusively/,
  );
  await assert.rejects(
    captureMicrophone("default", {}),
    /Microphone access is unavailable/,
  );
  const empty = { getAudioTracks: () => [], getTracks: () => [] };
  await assert.rejects(
    captureMicrophone("default", {
      async getUserMedia() {
        return empty;
      },
    }),
    { name: "NotFoundError" },
  );
});
