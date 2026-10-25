// Real NSIS old-to-new installation, with a separate app ID, install directory,
// profile, update key and loopback feed. Never installs over the owner's Gather.
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  readFile,
  writeFile,
  stat,
  access,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { createGatherServer } from "../server/app.mjs";
const { signManifest } = createRequire(import.meta.url)(
  "../electron/update-signature.cjs",
);
if (process.platform !== "win32") throw new Error("This check needs Windows.");
const root = resolve("."),
  dir = process.argv[2]
    ? resolve(process.argv[2])
    : await mkdtemp(join(root, ".gather-test-updater-"));
if (!dir.startsWith(join(root, ".gather-test-updater-")))
  throw new Error("Unexpected fixture directory.");
const saved = process.argv[2]
  ? JSON.parse(await readFile(join(dir, "fixture.json"), "utf8"))
  : null;
const fixture = join(dir, "app"),
  data = join(dir, "profile"),
  install = join(dir, "installed");
const product = saved?.product ?? `GatherUpdateFixture${Date.now()}`;
const exe = join(install, `${product}.exe`),
  marker = join(dir, "launches.jsonl");
const backend = createGatherServer({ dataDir: join(dir, "server"), env: {} });
const { port } = await backend.listen(saved?.port ?? 0),
  base = `http://127.0.0.1:${port}`;
let metadata,
  invalidSignature = true,
  downloads = 0,
  app;
const feed = createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  console.log(`Fixture feed: ${req.method} ${pathname}`);
  if (pathname === "/updates/latest.yml") {
    res.setHeader("Content-Type", "text/yaml");
    res.end(
      yaml.dump(
        invalidSignature
          ? { ...metadata, gatherSignature: "A".repeat(86) + "==" }
          : metadata,
      ),
    );
  } else if (pathname === "/updates/Gather-0.0.2-Setup.exe") {
    downloads++;
    res.setHeader("Content-Length", metadata.files[0].size);
    createReadStream(join(fixture, "release", "Gather-0.0.2-Setup.exe")).pipe(
      res,
    );
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((done) =>
  feed.listen(saved?.feedPort ?? 0, "127.0.0.1", done),
);
const feedBase = `http://127.0.0.1:${feed.address().port}/updates/`;
const run = (file, args, cwd = root) =>
  new Promise((yes, no) => {
    const child = spawn(file, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: join(root, "node_modules", ".bin") + ";" + process.env.PATH,
      },
    });
    child.on("error", no);
    child.on("exit", (code) =>
      code === 0 ? yes() : no(new Error(`Fixture process exited ${code}`)),
    );
  });
const env = {
  ...process.env,
  GATHER_TEST_DATA: data,
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
const launch = async () => {
  app = await electron.launch({
    executablePath: exe,
    env,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
    timeout: 30000,
  });
  return app.firstWindow();
};
try {
  if (!saved) {
    await mkdir(fixture);
    for (const name of ["dist", "electron", "server", "licenses"])
      await cp(join(root, name), join(fixture, name), {
        recursive: true,
        filter: (source) =>
          !source.startsWith(join(root, "dist", "downloads")) &&
          !source.startsWith(join(root, "dist", "updates")),
      });
    await symlink(
      join(root, "node_modules"),
      join(fixture, "node_modules"),
      "junction",
    );
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    pkg.name = product.toLowerCase();
    pkg.build.appId = `com.gather.fixture.${product.toLowerCase()}`;
    pkg.build.productName = product;
    pkg.build.win = {
      ...pkg.build.win,
      executableName: product,
      target: ["nsis"],
    };
    pkg.build.nsis.runAfterFinish = false;
    pkg.build.nsis.createDesktopShortcut = false;
    pkg.build.nsis.createStartMenuShortcut = false;
    pkg.build.publish[0].url = feedBase;
    delete pkg.devDependencies;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(
      join(fixture, "electron", "update-trust.json"),
      JSON.stringify({
        keys: [
          {
            id: createHash("sha256").update(pem).digest("hex").slice(0, 16),
            publicKey: pem,
          },
        ],
      }),
    );
    await writeFile(
      join(fixture, "electron", "config.json"),
      JSON.stringify({ serverUrl: base }),
    );
    // Checkouts with autocrlf carry CRLF; the patch targets below use LF.
    let main = (
      await readFile(join(fixture, "electron", "main.cjs"), "utf8")
    ).replaceAll("\r\n", "\n");
    const replace = (before, after) => {
      assert.ok(
        main.includes(before),
        `Fixture patch target absent: ${before}`,
      );
      main = main.replace(before, after);
    };
    replace(
      "const testing = Boolean(process.env.GATHER_TEST_DATA);",
      `const testing = true; process.env.GATHER_TEST_DATA = ${JSON.stringify(data)}; process.env.GATHER_TEST_PORT = ${JSON.stringify(String(port))};`,
    );
    replace("app.isPackaged &&\n        !testing &&", "app.isPackaged &&");
    replace(
      'url: new URL("/updates/", defaultServer).href,',
      `url: ${JSON.stringify(feedBase)},`,
    );
    replace(
      "updates = createUpdateManager({",
      "updates = createUpdateManager({ automatic: false,",
    );
    replace(
      'await win.loadURL(devUrl || "app://gather/index.html");',
      `await win.loadURL(devUrl || "app://gather/index.html");
      require("node:fs").appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: app.getVersion(), executable: process.execPath, profile: app.getPath("userData") }) + "\\n");
      if(app.getVersion() === "0.0.2" && require("node:fs").existsSync(${JSON.stringify(join(dir, "stop-new"))})) setTimeout(() => app.quit(), 1000);`,
    );
    await writeFile(join(fixture, "electron", "main.cjs"), main);
    for (const version of ["0.0.1", "0.0.2"]) {
      pkg.version = version;
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify(pkg, null, 2),
      );
      await run(process.execPath, [
        "node_modules/electron-builder/cli.js",
        "--projectDir",
        fixture,
        "--win",
        "nsis",
        "--x64",
        "--publish",
        "never",
      ]);
    }
    metadata = yaml.load(
      await readFile(join(fixture, "release", "latest.yml"), "utf8"),
    );
    metadata.files[0].size = (
      await stat(join(fixture, "release", "Gather-0.0.2-Setup.exe"))
    ).size;
    metadata = signManifest(
      metadata,
      privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    );
    await writeFile(
      join(dir, "fixture.json"),
      JSON.stringify({
        product,
        port,
        feedPort: feed.address().port,
        metadata,
      }),
    );
  } else {
    metadata = saved.metadata;
    // The directory guard above confines removal to this disposable fixture.
    assert.equal(resolve(data), join(dir, "profile"));
    await rm(data, { recursive: true, force: true });
    await writeFile(marker, "");
    await rm(join(dir, "stop-new"), { force: true });
  }
  await run(join(fixture, "release", "Gather-0.0.1-Setup.exe"), [
    "/S",
    `/D=${install}`,
  ]);
  await access(exe);
  let page = await launch();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  const session = {
    ...(await backend.domain.handle("POST", "/api/sessions", {
      name: "Upgrade friend",
    })),
    server: base,
  };
  const group = (
    await backend.domain.handle("GET", "/api/bootstrap", {}, session.token)
  ).groups[0];
  const scope = JSON.stringify([base, session.user.id]);
  await page.evaluate((s) => window.desktop.writeSession(s, null), session);
  await page.reload();
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Upgrade friend",
  );
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("History survives the installed upgrade");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await page.evaluate(
          ({ scope, groupId }) =>
            window.desktop.history({ scope, operation: "page", groupId }),
          { scope, groupId: group.id },
        )
      ).messages.some(
        (m) => m.body === "History survives the installed upgrade",
      ),
    )
    .toBe(true);
  const pendingId = randomUUID();
  await page.evaluate(
    ({ scope, groupId, userId, id }) =>
      window.desktop.history({
        operation: "queue",
        scope,
        message: {
          id,
          clientId: id,
          groupId,
          userId,
          name: "Upgrade friend",
          body: "Paused work survives upgrade",
          createdAt: Date.now(),
          sequence: 0,
          status: "failed",
          paused: true,
        },
      }),
    { scope, groupId: group.id, userId: session.user.id, id: pendingId },
  );
  const id = randomUUID(),
    bytes = Array.from(Buffer.from("Original survives upgrade\n"));
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  await page.evaluate(
    async (value) => {
      await window.desktop.media({
        operation: "put",
        ...value,
        data: new Uint8Array(value.bytes),
        pinned: false,
        name: "upgrade.txt",
        type: "text/plain",
      });
      await window.desktop.media({
        operation: "keep",
        scope: value.scope,
        id: value.id,
        active: true,
      });
    },
    { scope, id, bytes, sha256 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.desktop.updateStatus().then((s) => s.phase)),
    )
    .toBe("idle");
  const bad = await page.evaluate(() => window.desktop.checkForUpdates());
  assert.equal(bad.phase, "error");
  assert.equal(
    downloads,
    0,
    "Untrusted metadata must not download an executable",
  );
  invalidSignature = false;
  await page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Active voice call" }),
  ).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.desktop.checkForUpdates())).phase,
    "waiting",
  );
  assert.equal(downloads, 0, "Voice must defer the download");
  await page.getByRole("button", { name: "Leave call", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Active voice call" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.desktop.updateStatus().then((s) => s.phase)),
    )
    .toBe("waiting");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.desktop.checkForUpdates().then((state) => state.phase),
        ),
      { timeout: 60000 },
    )
    .toBe("ready");
  assert.ok(
    downloads <= 1,
    "A valid signed cached installer may be reused without downloading again.",
  );
  await writeFile(join(dir, "stop-new"), "1");
  const closed = app.waitForEvent("close", { timeout: 90000 });
  const restarting = await page.evaluate(() =>
    window.desktop.restartToUpdate(),
  );
  console.log("Fixture restart result", restarting);
  assert.equal(restarting.ok, true);
  await closed;
  app = undefined;
  await expect
    .poll(
      async () =>
        (await readFile(marker, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse)
          .some(
            (v) =>
              v.version === "0.0.2" &&
              v.executable === exe &&
              v.profile === data,
          ),
      { timeout: 90000 },
    )
    .toBe(true);
  // The automatically relaunched fixture exits itself, then is opened under
  // Playwright again to inspect the installed version and durable data.
  await new Promise((done) => setTimeout(done, 2500));
  const { unlink } = await import("node:fs/promises");
  await unlink(join(dir, "stop-new"));
  page = await launch();
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), "0.0.2");
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Upgrade friend",
  );
  const recovered = await page.evaluate(() => window.desktop.readSession());
  assert.equal(recovered.session.token, session.token);
  const messages = await page.evaluate(
    ({ scope, groupId }) =>
      window.desktop.history({ operation: "page", scope, groupId }),
    { scope, groupId: group.id },
  );
  assert.ok(
    messages.messages.some(
      (m) => m.body === "History survives the installed upgrade",
    ),
  );
  const original = await page.evaluate(
    ({ scope, id }) => window.desktop.media({ operation: "get", scope, id }),
    { scope, id },
  );
  assert.deepEqual(Array.from(original), bytes);
  assert.equal(
    (
      await page.evaluate(
        ({ scope, id }) =>
          window.desktop.media({ operation: "entry", scope, id }),
        { scope, id },
      )
    ).kept,
    true,
  );
  const pending = await page.evaluate(
    (scope) => window.desktop.history({ operation: "state", scope }),
    scope,
  );
  assert.ok(
    pending.outbox.some(
      (m) =>
        m.clientId === pendingId &&
        m.paused &&
        m.body === "Paused work survives upgrade",
    ),
  );
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/installed-update.json",
    JSON.stringify(
      {
        from: "0.0.1",
        to: "0.0.2",
        actualNsisUpgrade: true,
        automaticRelaunch: true,
        invalidSignatureRejectedBeforeDownload: true,
        voiceDeferredDownload: true,
        encryptedProfilePreserved: true,
        historyPreserved: true,
        pausedOutboxPreserved: true,
        keptOriginalPreserved: true,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real signed NSIS update installs and relaunches; encrypted identity, history and kept original survive. Invalid signatures download no executable; active voice defers updates.",
  );
} finally {
  await app?.close();
  await backend.close();
  await new Promise((done) => feed.close(done));
  const uninstaller = join(install, `Uninstall ${product}.exe`);
  if (
    await access(uninstaller).then(
      () => true,
      () => false,
    )
  )
    await run(uninstaller, ["/S"]);
  // Leave ignored fixture files for diagnosis; never delete an active install.
}
