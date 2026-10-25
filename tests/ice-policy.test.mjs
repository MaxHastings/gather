import { test } from "node:test";
import assert from "node:assert/strict";
import { iceLifetimeSeconds, iceRenewalDelayMs } from "../src/icePolicy.ts";
test("temporary relay credentials renew before expiry and malformed lifetimes never become permanent", () => {
  assert.equal(iceLifetimeSeconds(), 3600);
  assert.equal(iceRenewalDelayMs(86400), 18 * 60 * 60 * 1000);
  assert.equal(iceRenewalDelayMs(12), 9000);
  for (const value of [0, -1, NaN, Infinity, 86401, "86400", null, 0.5])
    assert.throws(() => iceLifetimeSeconds(value));
});
