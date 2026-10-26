import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const CONCURRENCY = Math.max(1, Number(process.env.GATHER_CHECK_JOBS) || 3);

async function run(args, env = {}, quiet = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Release check failed (${code}): ${args.join(" ")}` +
                (output ? `\n${output.split("\n").slice(-60).join("\n")}` : ""),
            ),
          ),
    );
  });
}

/**
 * Runs independent checks together. Each one starts its own server on an
 * ephemeral port and its own browser, so they do not share state. Output is
 * held until a check finishes so the logs do not interleave, and every failure
 * is reported at the end instead of only the first.
 */
async function runParallel(checks) {
  const failures = [];
  const queue = [...checks];
  async function worker() {
    while (queue.length) {
      const [args, env] = queue.shift();
      const started = Date.now();
      try {
        await run(args, env, true);
        console.log(
          `PASS ${args[0]} (${Math.round((Date.now() - started) / 1000)}s)`,
        );
      } catch (error) {
        console.error(`FAIL ${args[0]}`);
        failures.push(error);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failures.length)
    throw new Error(failures.map((error) => error.message).join("\n\n"));
}

await stat("release/win-unpacked/Gather.exe");
await run(["node_modules/npm/bin/npm-cli.js", "test"]);
await runParallel([
  [["tests/history-browser.mjs"]],
  [["tests/media-cache-browser.mjs"]],
  [["scripts/identity-smoke.mjs"]],
  [["scripts/session-smoke.mjs"]],
  [["scripts/archive-smoke.mjs"]],
  [["scripts/conversation-tools-smoke.mjs"]],
  [["scripts/avatar-smoke.mjs"]],
  [["scripts/everyday-smoke.mjs"]],
  [["scripts/restore-client-smoke.mjs"]],
  [["scripts/interaction-smoke.mjs"]],
  [["scripts/desktop-downloads-smoke.mjs"]],
  [["scripts/media-smoke.mjs"]],
  [["scripts/storage-smoke.mjs"]],
  [["scripts/notifications-smoke.mjs"]],
  [["scripts/offline-smoke.mjs"]],
  [["scripts/browser-smoke.mjs"]],
]);
// Packaged desktop checks drive the real app window, so they stay one at a time.
await run(["scripts/membership-smoke.mjs"], { GATHER_SMOKE_PACKAGED: "1" });
await run(["scripts/smoke.mjs"], {
  GATHER_SMOKE_PACKAGED: "1",
  GATHER_SMOKE_DROP_OFFERS: "1",
});
await run(["scripts/group-voice-smoke.mjs"], { GATHER_GROUP_PACKAGED: "1" });
await run(["scripts/check-portable.mjs"]);
console.log(
  "PASS: release checks passed for the packaged desktop app and browser client.",
);
