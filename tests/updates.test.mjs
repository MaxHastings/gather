import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  signManifest,
  verifyManifest,
  verifyInstaller,
  newerVersion,
} = require("../electron/update-signature.cjs");
const { createUpdateManager } = require("../electron/updates.cjs");
const privateKey = generateKeyPairSync("ed25519").privateKey;
const encoded = privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64");
const publicKey = createPublicKey(privateKey)
  .export({ type: "spki", format: "pem" })
  .toString();
const data = Buffer.from("fixture installer bytes; never executed");
const manifest = signManifest(
  {
    version: "0.1.3",
    files: [
      {
        url: "Gather-0.1.3-Setup.exe",
        size: data.length,
        sha512: createHash("sha512").update(data).digest("base64"),
      },
    ],
    releaseDate: "2026-10-24T00:00:00.000Z",
  },
  encoded,
);
const trust = { keys: [{ id: manifest.gatherKeyId, publicKey }] };
test("release signatures authenticate a bounded Windows installer and prevent substitution or downgrade", () => {
  assert.equal(verifyManifest(manifest, trust, "0.1.2").version, "0.1.3");
  assert.throws(
    () =>
      verifyManifest(
        { ...manifest, gatherSignature: undefined },
        trust,
        "0.1.2",
      ),
    /signed/,
  );
  assert.throws(
    () => verifyManifest(manifest, { keys: [] }, "0.1.2"),
    /signed/,
  );
  assert.throws(
    () =>
      verifyManifest(
        { ...manifest, releaseDate: "2026-10-25T00:00:00.000Z" },
        trust,
        "0.1.2",
      ),
    /signed/,
  );
  assert.throws(
    () =>
      verifyManifest(
        {
          ...manifest,
          files: [
            { ...manifest.files[0], url: "https://evil.test/payload.exe" },
          ],
        },
        trust,
        "0.1.2",
      ),
    /artifact/,
  );
  assert.throws(
    () =>
      verifyManifest(
        { ...manifest, files: [{ ...manifest.files[0], size: 300_000_001 }] },
        trust,
        "0.1.2",
      ),
    /artifact/,
  );
  assert.throws(
    () =>
      verifyManifest({ ...manifest, packages: { x64: {} } }, trust, "0.1.2"),
    /manifest/,
  );
  assert.throws(() => verifyManifest(manifest, trust, "0.1.3"), /newer/);
  assert.throws(() => verifyManifest(manifest, trust, "1.0.0"), /newer/);
  assert.equal(newerVersion("0.10.0", "0.9.0"), true);
  assert.equal(newerVersion("0.1.3-beta.1", "0.1.2"), false);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gather-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, manifest.files[0].url);
  await writeFile(filename, data);
  class Updater extends EventEmitter {
    calls = 0;
    downloads = 0;
    installs = 0;
    installerPath = filename;
    async checkForUpdates() {
      this.calls++;
      return { updateInfo: manifest };
    }
    async downloadUpdate() {
      this.downloads++;
      return [filename];
    }
    quitAndInstall(...args) {
      this.installs++;
      this.args = args;
    }
  }
  const updater = new Updater(),
    states = [];
  let safe = true;
  const manager = createUpdateManager({
    updater,
    version: "0.1.2",
    trust,
    canRestart: () => safe,
    publish: (s) => states.push(s),
    automatic: false,
  });
  t.after(() => manager.dispose());
  return {
    filename,
    updater,
    manager,
    states,
    active: () => {
      safe = false;
    },
    idle: () => {
      safe = true;
    },
  };
}
test("quiet download never installs on quit and explicit restart requires an idle app and verified cached bytes", async (t) => {
  const f = await fixture(t);
  await f.manager.check();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.disableWebInstaller, true);
  assert.equal(f.manager.status().phase, "ready");
  f.active();
  assert.equal((await f.manager.restart()).ok, false);
  assert.equal(f.updater.installs, 0);
  f.idle();
  assert.equal((await f.manager.restart()).ok, true);
  assert.equal(f.updater.installs, 1);
  assert.deepEqual(f.updater.args, [true, true]);
});
test("untrusted manifests never download; provider outages retry without disabling the app", async (t) => {
  const f = await fixture(t);
  f.updater.checkForUpdates = async () => ({
    updateInfo: { ...manifest, gatherSignature: "invalid" },
  });
  await f.manager.check();
  assert.equal(f.updater.downloads, 0);
  assert.equal(f.manager.status().phase, "error");
  f.updater.checkForUpdates = async () => {
    throw new Error("secret URL/path must not reach UI");
  };
  await f.manager.check();
  assert.doesNotMatch(f.manager.status().error, /secret/);
  f.updater.checkForUpdates = async () => ({ updateInfo: manifest });
  await f.manager.check();
  assert.equal(f.manager.status().phase, "ready");
});
test("updates wait for calls and pause downloading when a call starts", async (t) => {
  const f = await fixture(t);
  f.active();
  await f.manager.check();
  assert.equal(f.manager.status().phase, "waiting");
  assert.equal(f.updater.calls, 0);
  f.idle();
  let started;
  const downloading = new Promise((resolve) => {
    started = resolve;
  });
  let rejectDownload;
  f.updater.checkForUpdates = async () => ({
    updateInfo: manifest,
    cancellationToken: {
      cancel() {
        rejectDownload(new Error("cancelled"));
      },
    },
  });
  f.updater.downloadUpdate = async () => {
    started();
    return new Promise((_resolve, reject) => {
      rejectDownload = reject;
    });
  };
  const check = f.manager.check();
  await downloading;
  f.active();
  f.manager.activityChanged(true);
  await check;
  assert.equal(f.manager.status().phase, "waiting");
  assert.equal(f.updater.installs, 0);
  f.idle();
  f.updater.downloadUpdate = async () => [f.filename];
  await f.manager.check();
  assert.equal(f.manager.status().phase, "ready");
});

test("a modified or replaced cached installer cannot execute", async (t) => {
  const f = await fixture(t);
  await f.manager.check();
  f.idle();
  await writeFile(f.filename, Buffer.from("tampered"));
  await assert.rejects(
    verifyInstaller(f.filename, manifest.files[0]),
    /checksum/,
  );
  assert.equal((await f.manager.restart()).ok, false);
  assert.equal(f.updater.installs, 0);
  assert.equal(f.manager.status().phase, "error");
});
