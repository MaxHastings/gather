import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGatherServer } from "../server/app.mjs";
import { config } from "dotenv";
import { desktopExecutable } from "./desktop-path.mjs";
config({ quiet: true });

const root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), "gather-desktop-"));
// Varying voice-band test audio avoids a steady tone being suppressed as noise.
// This fixture is generated, never recorded from a person.
const audioFile = path.join(dir, "microphone.wav");
const rate = 48000,
  samples = rate * 8;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const t = i / rate,
    phase = t % 0.4;
  const envelope = phase < 0.3 ? Math.sin((Math.PI * phase) / 0.3) : 0;
  const fundamental = 160 + 45 * Math.sin(t * 4);
  const value =
    envelope *
    (0.22 * Math.sin(2 * Math.PI * fundamental * t) +
      0.12 * Math.sin(2 * Math.PI * fundamental * 2.7 * t) +
      0.06 * Math.sin(2 * Math.PI * 1100 * t));
  wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
}
await writeFile(audioFile, wav);
await mkdir(path.join(root, "test-results"), { recursive: true });
const remote = process.env.GATHER_SMOKE_SERVER;
// Chromium's macOS audio sandbox cannot read the generated WAV fixture:
// https://chromium.googlesource.com/chromium/src/+/167f34ae932ed8f702d9127339acbff246b4eb47
// Relax only this utility process in isolated tests. This is not an app option.
const fixtureAudioArgs =
  process.platform === "darwin"
    ? ["--disable-features=AudioServiceSandbox"]
    : [];
if (
  fixtureAudioArgs.length &&
  remote &&
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(remote).hostname)
)
  throw new Error(
    "The macOS WAV fixture requires an isolated loopback server.",
  );
const forcedRelay = process.env.GATHER_SMOKE_RELAY === "1";
const server = createGatherServer({
  dataDir: path.join(dir, "server"),
  sessionLimit: 100,
  env: forcedRelay ? process.env : {},
});
const { port } = await server.listen(0);
const localServer = `http://127.0.0.1:${port}`;
const apps = [];
const browsers = [];
const pages = [];
let reported = false;
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const errors = [];
const env = { ...process.env, GATHER_TEST_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
try {
  async function client(name) {
    if (name === "bob" && process.env.GATHER_SMOKE_BROWSER === "1") {
      const browser = await chromium.launch({
        channel: "msedge",
        headless: true,
        args: [
          ...fixtureAudioArgs,
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-audio-capture=${audioFile}`,
        ],
      });
      browsers.push(browser);
      const context = await browser.newContext({ permissions: ["microphone"] });
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(remote || localServer);
      await instrument(page);
      if (forcedRelay)
        await page.evaluate(() =>
          localStorage.setItem("gather.relayOnly", "true"),
        );
      return { page };
    }
    const app = await electron.launch({
      ...(process.env.GATHER_SMOKE_PACKAGED === "1"
        ? { executablePath: desktopExecutable(root) }
        : {}),
      args: [
        root,
        ...fixtureAudioArgs,
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${audioFile}`,
      ],
      env: { ...env, GATHER_TEST_DATA: path.join(dir, name) },
      timeout: 30000,
    });
    apps.push(app);
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version);
    app.process().stderr.on("data", (chunk) => {
      const output = chunk.toString();
      if (output.includes("GATHER_MAIN_UNCAUGHT")) errors.push(output);
    });
    await app.evaluate(() =>
      process.on("uncaughtExceptionMonitor", (error) =>
        console.error("GATHER_MAIN_UNCAUGHT", error.stack),
      ),
    );
    const page = await app.firstWindow();
    pages.push(page);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setBackgroundThrottling(false);
        win.hide();
      }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Welcome to Gather" }),
    ).toBeVisible();
    if (name === "alice") {
      await page.evaluate(() =>
        window.desktop.copyText("Gather native copy check"),
      );
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        "Gather native copy check",
      );
      expect(
        await page.evaluate(() =>
          window.desktop.openExternal("javascript:alert(1)").then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      expect(page.url()).toContain("app://gather/");
      const result = await app.evaluate(async ({ app, BrowserWindow }) => {
        const { createWindowAccess } = process.mainModule.require(
          app.getAppPath() + "/electron/window-access.cjs",
        );
        const closed = new BrowserWindow({ show: false });
        const contents = closed.webContents;
        const access = createWindowAccess(
          () => closed,
          () => true,
        );
        closed.destroy();
        let nativeGetterThrows = false,
          requestAllowed;
        try {
          void closed.webContents;
        } catch {
          nativeGetterThrows = true;
        }
        access.permissionRequest(
          contents,
          "media",
          (value) => {
            requestAllowed = value;
          },
          { mediaTypes: ["audio"] },
        );
        return {
          nativeGetterThrows,
          checkAllowed: access.permissionCheck(
            contents,
            "media",
            "app://gather",
          ),
          requestAllowed,
          windowUsable: access.withWindow(() => {}),
        };
      });
      expect(result).toEqual({
        nativeGetterThrows: true,
        checkAllowed: false,
        requestAllowed: false,
        windowUsable: false,
      });
      console.log(
        "PASS: real destroyed Electron window reproduces the native error; late permission callbacks safely deny access.",
      );
    }
    await instrument(page);
    if (forcedRelay)
      await page.evaluate(() =>
        localStorage.setItem("gather.relayOnly", "true"),
      );
    return { app, page };
  }
  async function instrument(page) {
    await page.evaluate((dropOffers) => {
      window.__dropNextOffer = dropOffers;
      window.__wire = [];
      const Original = window.RTCPeerConnection;
      window.__testPeers = [];
      window.RTCPeerConnection = new Proxy(Original, {
        construct(Target, args) {
          const peer = new Target(...args);
          window.__testPeers.push(peer);
          return peer;
        },
      });
      const OriginalWebSocket = window.WebSocket;
      window.__testSockets = [];
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(Target, args) {
          const socket = new Target(...args);
          socket.addEventListener("message", (event) => {
            if (event.data === "pong") return;
            const packet = JSON.parse(event.data);
            window.__wire.push({
              received: packet.event,
              type: packet.data?.description?.type,
              error: packet.data?.error,
            });
            window.__wire = window.__wire.slice(-40);
          });
          const send = socket.send.bind(socket);
          socket.send = (packet) => {
            if (typeof packet === "string" && packet.startsWith("{")) {
              const data = JSON.parse(packet);
              window.__wire.push({
                sent: data.event,
                type: data.data?.description?.type,
              });
              window.__wire = window.__wire.slice(-40);
              if (
                window.__dropNextOffer &&
                data.event === "signal" &&
                data.data?.description?.type === "offer"
              ) {
                window.__dropNextOffer = false;
                return;
              }
            }
            if (
              window.__dropNextVoiceJoin &&
              typeof packet === "string" &&
              packet.startsWith("{")
            ) {
              const data = JSON.parse(packet);
              if (data.event === "voice:join") {
                window.__dropNextVoiceJoin = false;
                return;
              }
            }
            send(packet);
          };
          window.__testSockets.push(socket);
          return socket;
        },
      });
    }, process.env.GATHER_SMOKE_DROP_OFFERS === "1");
  }
  const a = await client("alice");
  await capture(a.page, {
    path: path.join(root, "test-results/welcome.png"),
  });
  await a.page.getByLabel("Your name").fill("Alice");
  if (remote || port !== 4318) {
    await a.page.getByRole("button", { name: "Server" }).click();
    await a.page
      .getByLabel("Server address", { exact: true })
      .fill(remote || localServer);
  }
  await a.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    a.page.getByRole("heading", { name: "The usual crew", exact: true }),
  ).toBeVisible();
  await expect(a.page.getByText("Online", { exact: true })).toBeVisible();
  await a.page
    .getByRole("button", { name: "Invite a friend", exact: true })
    .first()
    .click();
  const invite = await a.page.getByLabel("Your invite link").inputValue();
  await a.page
    .getByRole("button", { name: "Copy invite link", exact: true })
    .click();
  await expect(
    a.page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  await a.page.getByRole("button", { name: "Close dialog" }).click();
  const b = await client("bob");
  await b.page.evaluate(() =>
    localStorage.setItem("gather.microphone", "missing-headset"),
  );
  await b.page.getByLabel("Your name").fill("Bob");
  await b.page.getByLabel("Invite link", { exact: false }).fill(invite);
  await b.page.getByRole("button", { name: "Join chat" }).click();
  await expect(
    b.page.getByRole("heading", { name: "The usual crew", exact: true }),
  ).toBeVisible();
  await expect(a.page.getByText("2 online", { exact: false })).toBeVisible();
  await a.page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hey! One more game?");
  await a.page.getByRole("button", { name: "Send message" }).click();
  await expect(
    b.page
      .locator(".message-bubble")
      .getByText("Hey! One more game?", { exact: true }),
  ).toBeVisible();
  await b.page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Absolutely. Meet you in voice 👋");
  await b.page
    .getByRole("textbox", { name: "Message", exact: true })
    .press("Enter");
  await expect(
    a.page
      .locator(".message-bubble")
      .getByText("Absolutely. Meet you in voice", { exact: true }),
  ).toBeVisible();
  await expect(
    a.page
      .locator(".message-bubble")
      .getByRole("img", { name: "👋", exact: true }),
  ).toBeVisible();
  console.log("PASS: two independent clients join, send and receive messages.");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await a.page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await expect(a.page.locator("html")).toHaveAttribute("data-theme", "dark");
  await a.page.getByRole("button", { name: "Close dialog" }).click();
  await a.page.evaluate(() => {
    const media = navigator.mediaDevices;
    window.__realCapture = media.getUserMedia.bind(media);
    media.getUserMedia = async () => {
      throw new DOMException("Object not found", "NotFoundError");
    };
  });
  await a.page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect(a.page.getByRole("alert")).toContainText("No microphone found");
  await expect(
    a.page.getByRole("region", { name: "Active voice call" }),
  ).toHaveCount(0);
  await a.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  await a.page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect(a.page.getByRole("alert")).toContainText(
    "Microphone access is blocked",
  );
  await a.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        window.__resolveCapture = async () => {
          const stream = await window.__realCapture({ audio: true });
          window.__cancelledStream = stream;
          resolve(stream);
        };
      });
  });
  await a.page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect
    .poll(() => a.page.evaluate(() => Boolean(window.__resolveCapture)))
    .toBe(true);
  await a.page.getByRole("button", { name: "Leave call", exact: true }).click();
  await a.page.evaluate(() => window.__resolveCapture());
  await expect
    .poll(() =>
      a.page.evaluate(() =>
        window.__cancelledStream
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await expect(
    a.page.getByRole("region", { name: "Active voice call" }),
  ).toHaveCount(0);
  await a.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = window.__realCapture;
  });
  if (await a.page.getByRole("button", { name: "Dismiss notice" }).count())
    await a.page.getByRole("button", { name: "Dismiss notice" }).click();
  console.log(
    "PASS: missing/denied microphone errors are actionable; cancelling a pending capture releases late tracks.",
  );
  await a.page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect(
    a.page.getByText("Waiting for a friend", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await b.page
    .getByRole("button", { name: "Join voice", exact: true })
    .first()
    .click();
  await expect(
    a.page.getByText("Voice connected", { exact: true }),
  ).toBeVisible({ timeout: 25000 });
  await expect(
    b.page.getByText("Voice connected", { exact: true }),
  ).toBeVisible({ timeout: 25000 });
  expect(
    await b.page.evaluate(() => localStorage.getItem("gather.microphone")),
  ).toBe("default");
  console.log(
    "PASS: a stale saved microphone automatically falls back to the working system default.",
  );
  for (const page of [a.page, b.page])
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const pc = window.__testPeers.find(
              (p) => p.connectionState === "connected",
            );
            if (!pc) return false;
            const reports = [...(await pc.getStats()).values()];
            return (
              reports.some(
                (r) =>
                  r.type === "inbound-rtp" &&
                  r.kind === "audio" &&
                  r.packetsReceived > 10,
              ) &&
              reports.some(
                (r) =>
                  r.type === "outbound-rtp" &&
                  r.kind === "audio" &&
                  r.packetsSent > 10,
              )
            );
          }),
        { timeout: 15000 },
      )
      .toBe(true);
  console.log(
    "PASS: real WebRTC audio packets flow both directions (synthetic microphones).",
  );
  for (const page of [a.page, b.page])
    await expect
      .poll(
        () =>
          page.locator(".call-person.speaking, .call-tile.speaking").count(),
        {
          timeout: 10000,
        },
      )
      .toBeGreaterThan(0);
  console.log(
    "PASS: speaking indicators respond to the real captured/received audio.",
  );
  await a.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(880, 700),
  );
  await expect(a.page.locator(".call-people, .stage-tiles")).toBeVisible();
  await expect(
    a.page.getByRole("button", { name: "Leave call", exact: true }),
  ).toBeVisible();
  expect(
    await a.page
      .locator(".call-controls")
      .evaluate(
        (element) => element.getBoundingClientRect().right <= window.innerWidth,
      ),
  ).toBe(true);
  await a.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1220, 840),
  );
  await expect
    .poll(
      () =>
        a.page
          .locator(".call-person.speaking, .call-tile.speaking")
          .filter({ hasText: "Bob" })
          .count(),
      { timeout: 10000 },
    )
    .toBe(1);
  await expect
    .poll(
      () =>
        b.page
          .locator(".call-person.speaking, .call-tile.speaking")
          .filter({ hasText: "Alice" })
          .count(),
      { timeout: 10000 },
    )
    .toBe(1);
  if (forcedRelay) {
    for (const page of [a.page, b.page])
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const pc = window.__testPeers.find(
              (p) => p.connectionState === "connected",
            );
            if (!pc) return false;
            const reports = await pc.getStats();
            return [...reports.values()].some(
              (r) =>
                r.type === "candidate-pair" &&
                r.state === "succeeded" &&
                reports.get(r.localCandidateId)?.candidateType === "relay",
            );
          }),
        )
        .toBe(true);
    console.log("PASS: both clients use actual TURN relay candidates.");
  }
  await a.page
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await expect(
    a.page.locator(
      '.call-person[aria-label="You, muted"], .call-tile[aria-label="You, muted"]',
    ),
  ).not.toHaveClass(/speaking/);
  await expect
    .poll(() =>
      a.page.evaluate(() =>
        window.__testPeers
          .filter((p) => p.connectionState === "connected")
          .every((p) =>
            p
              .getSenders()
              .filter((s) => s.track)
              .every((s) => !s.track.enabled),
          ),
      ),
    )
    .toBe(true);
  await a.page.getByRole("button", { name: "Deafen", exact: true }).click();
  await expect
    .poll(() =>
      a.page.evaluate(() =>
        [...document.querySelectorAll("audio")].every((el) => el.muted),
      ),
    )
    .toBe(true);
  await a.page.getByRole("button", { name: "Undeafen", exact: true }).click();
  await expect(
    a.page.getByRole("button", { name: "Unmute microphone", exact: true }),
  ).toBeVisible();
  console.log(
    "PASS: mute and deafen control the actual media; undeafen preserves previous mute.",
  );
  await a.page
    .getByRole("button", { name: "Audio settings", exact: true })
    .click();
  const microphoneId = await a.page
    .locator("#microphone option")
    .nth(1)
    .getAttribute("value");
  expect(microphoneId).toBeTruthy();
  await a.page.evaluate(() => {
    window.__oldMic = window.__testPeers
      .find((p) => p.connectionState === "connected")
      .getSenders()
      .find((s) => s.track?.kind === "audio").track;
  });
  await a.page
    .getByLabel("Microphone", { exact: true })
    .selectOption(microphoneId);
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const track = window.__testPeers
          .find((p) => p.connectionState === "connected")
          .getSenders()
          .find((s) => s.track?.kind === "audio").track;
        return (
          track !== window.__oldMic &&
          track.readyState === "live" &&
          !track.enabled &&
          window.__oldMic.readyState === "ended"
        );
      }),
    )
    .toBe(true);
  await a.page.evaluate(() => {
    window.__workingMic = window.__testPeers
      .find((p) => p.connectionState === "connected")
      .getSenders()
      .find((s) => s.track?.kind === "audio").track;
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Hardware busy", "NotReadableError");
    };
  });
  await a.page
    .getByLabel("Microphone", { exact: true })
    .selectOption("default");
  await expect(a.page.getByRole("alert")).toContainText(
    "Couldn’t open your microphone",
  );
  expect(await a.page.evaluate(() => window.__workingMic.readyState)).toBe(
    "live",
  );
  await a.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = window.__realCapture;
    window.__workingMic.stop();
    window.__workingMic.dispatchEvent(new Event("ended"));
  });
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const track = window.__testPeers
          .find((p) => p.connectionState === "connected")
          .getSenders()
          .find((s) => s.track?.kind === "audio").track;
        return (
          track !== window.__workingMic &&
          track.readyState === "live" &&
          !track.enabled
        );
      }),
    )
    .toBe(true);
  const speakerId = await a.page
    .locator("#speaker option")
    .nth(1)
    .getAttribute("value");
  await a.page
    .getByLabel("Headphones / speakers", { exact: true })
    .selectOption(speakerId);
  await expect
    .poll(() =>
      a.page.evaluate(
        (id) =>
          [...document.querySelectorAll("audio")].every(
            (el) => el.sinkId === id,
          ),
        speakerId,
      ),
    )
    .toBe(true);
  await a.page
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await a.page.getByRole("button", { name: "Dismiss notice" }).click();
  console.log(
    "PASS: microphone/output changes affect real media; a busy replacement preserves capture; an ended microphone recovers without unmuting.",
  );
  await capture(a.page, {
    path: path.join(root, "test-results/desktop-call.png"),
  });
  // Lose signaling and the backend, then reconnect with the same persisted database.
  const peerCountBefore = await a.page.evaluate(
    () => window.__testPeers.length,
  );
  await a.page.evaluate(() => {
    window.__dropNextVoiceJoin = true;
  });
  let restarted;
  if (remote) await a.page.evaluate(() => window.__testSockets.at(-1).close());
  else {
    await server.close();
    restarted = createGatherServer({
      dataDir: path.join(dir, "server"),
      sessionLimit: 100,
    });
    await restarted.listen(port);
  }
  try {
    await expect
      .poll(() => a.page.evaluate(() => window.__testPeers.length), {
        timeout: 30000,
      })
      .toBeGreaterThan(peerCountBefore);
    await expect(
      a.page.getByText("Voice connected", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      b.page.getByText("Voice connected", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      a.page.getByRole("button", { name: "Unmute microphone", exact: true }),
    ).toBeVisible();
    console.log(
      `PASS: ${remote ? "signaling reconnect" : "server restart"} recovers voice after a dropped rejoin request and preserves mute.`,
    );
    for (
      let cycle = 0;
      cycle < Number(process.env.GATHER_SMOKE_CYCLES || 3);
      cycle++
    ) {
      const count = await a.page.evaluate(() => window.__testPeers.length);
      await a.page.evaluate(() => window.__testSockets.at(-1).close());
      await expect
        .poll(() => a.page.evaluate(() => window.__testPeers.length), {
          timeout: 20000,
        })
        .toBeGreaterThan(count);
      await expect(
        a.page.getByText("Voice connected", { exact: true }),
      ).toBeVisible({ timeout: 25000 });
      await expect(
        b.page.getByText("Voice connected", { exact: true }),
      ).toBeVisible({ timeout: 25000 });
      await expect(
        a.page.getByRole("button", { name: "Unmute microphone", exact: true }),
      ).toBeVisible();
    }
    console.log(
      "PASS: repeated signaling interruptions recover calls while preserving mute.",
    );
    const soakSeconds = Number(process.env.GATHER_SMOKE_SOAK_SECONDS || 0);
    if (soakSeconds > 0) {
      await a.page
        .getByRole("button", { name: "Unmute microphone", exact: true })
        .click();
      const counters = (page) =>
        page.evaluate(async () => {
          const pc = window.__testPeers.find(
            (p) => p.connectionState === "connected",
          );
          const stats = [...(await pc.getStats()).values()];
          return {
            peerId: window.__testPeers.indexOf(pc),
            received: stats
              .filter((r) => r.type === "inbound-rtp" && r.kind === "audio")
              .reduce((n, r) => n + r.packetsReceived, 0),
            sent: stats
              .filter((r) => r.type === "outbound-rtp" && r.kind === "audio")
              .reduce((n, r) => n + r.packetsSent, 0),
          };
        });
      let previous = await Promise.all([a.page, b.page].map(counters));
      for (let elapsed = 0; elapsed < soakSeconds; elapsed += 20) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(20, soakSeconds - elapsed) * 1000),
        );
        const next = await Promise.all([a.page, b.page].map(counters));
        next.forEach((counts, i) => {
          expect(
            counts.peerId,
            "A steady call must not rebuild its peer connection",
          ).toBe(previous[i].peerId);
          expect(counts.received).toBeGreaterThan(previous[i].received + 20);
          expect(counts.sent).toBeGreaterThan(previous[i].sent + 20);
        });
        previous = next;
        console.log(
          `PASS: sustained bidirectional audio at ${Math.min(elapsed + 20, soakSeconds)} seconds.`,
        );
      }
      await a.page
        .getByRole("button", { name: "Mute microphone", exact: true })
        .click();
    }
    // An offline send stays visible and can be retried exactly once after recovery.
    await a.page.route("**/api/groups/*/messages", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await a.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Saved through a connection hiccup.");
    await a.page.getByRole("button", { name: "Send message" }).click();
    await expect(
      a.page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await a.page.unroute("**/api/groups/*/messages");
    await a.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      b.page
        .locator(".message-bubble")
        .getByText("Saved through a connection hiccup.", { exact: true }),
    ).toHaveCount(1);
    console.log(
      "PASS: a failed message remains visible and retry delivers it once.",
    );
    await a.page
      .getByRole("button", { name: "Leave call", exact: true })
      .click();
    await expect(
      a.page.getByRole("region", { name: "Active voice call" }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.__testPeers.every((p) =>
            p
              .getSenders()
              .every((s) => !s.track || s.track.readyState === "ended"),
          ),
        ),
      )
      .toBe(true);
    await b.page
      .getByRole("button", { name: "Leave call", exact: true })
      .click();
    await a.page.reload();
    await expect(a.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      a.page
        .locator(".message-bubble")
        .getByText("Hey! One more game?", { exact: true }),
    ).toBeVisible();
    console.log(
      "PASS: leaving stops microphone tracks; sign-in and history survive reload.",
    );
    await a.page.getByRole("button", { name: "Settings", exact: true }).click();
    await a.app.evaluate(
      ({ session }, savePath) => {
        globalThis.exportState = "waiting";
        session.defaultSession.once("will-download", (_event, item) => {
          globalThis.exportState = "started";
          item.setSavePath(savePath);
          item.once("done", (_event, state) => {
            globalThis.exportState = state;
          });
        });
      },
      path.join(root, "test-results/exported-history.json"),
    );
    await a.page
      .getByRole("button", { name: "Export your chat history", exact: true })
      .click();
    await expect
      .poll(() => a.app.evaluate(() => globalThis.exportState), {
        timeout: 10000,
      })
      .toBe("completed");
    const savedArchive = await readFile(
      path.join(root, "test-results/exported-history.json"),
    );
    expect(JSON.parse(savedArchive.toString("utf8")).format).toBe(
      "gather-archive-v1",
    );
    await a.page
      .getByRole("button", { name: "History & archives", exact: true })
      .click();
    const archiveDialog = a.page.getByRole("dialog", {
      name: "History & archives",
      exact: true,
    });
    await archiveDialog
      .getByLabel("Import history file", { exact: true })
      .setInputFiles({
        name: "desktop-export.json",
        mimeType: "application/json",
        buffer: savedArchive,
      });
    await expect(
      archiveDialog.getByLabel("History source").locator("option"),
    ).toHaveCount(2);
    await archiveDialog
      .getByLabel("Search saved messages", { exact: true })
      .fill("Hey! One more game?");
    await expect(
      archiveDialog.locator(".history-results").getByRole("button"),
    ).toHaveCount(1);
    await archiveDialog.locator(".history-results").getByRole("button").click();
    await expect(archiveDialog.locator("[data-highlight=true]")).toContainText(
      "Hey! One more game?",
    );
    await archiveDialog
      .getByRole("button", { name: "Remove imported copy", exact: true })
      .click();
    await archiveDialog
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(
      archiveDialog.getByLabel("History source").locator("option"),
    ).toHaveCount(1);
    await a.page.getByRole("button", { name: "Close dialog" }).click();
    console.log(
      "PASS: desktop export, local archive import, saved-message search/context and removal preserve live history.",
    );
    await a.page.route("**/api/**", (route) => route.abort());
    await a.page.reload();
    await expect(
      a.page
        .locator(".message-bubble")
        .getByText("Hey! One more game?", { exact: true }),
    ).toBeVisible();
    await a.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Desktop queued after offline restart");
    await a.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      a.page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await a.page.reload();
    await expect(
      a.page
        .locator(".message-bubble")
        .getByText("Desktop queued after offline restart", { exact: true }),
    ).toHaveCount(1);
    await a.page.unroute("**/api/**");
    await a.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(
      b.page
        .locator(".message-bubble")
        .getByText("Desktop queued after offline restart", { exact: true }),
    ).toHaveCount(1, { timeout: 20000 });
    await expect(
      a.page.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    console.log(
      "PASS: native SQLite history and queued messages survive offline reloads and retry exactly once after reconnect.",
    );
    assertNoErrors();
    await capture(a.page, {
      path: path.join(root, "test-results/desktop-chat.png"),
    });
  } catch (error) {
    await reportPeers();
    throw error;
  } finally {
    await Promise.all(apps.map(closeApp));
    apps.length = 0;
    await restarted?.close();
  }
} catch (error) {
  if (!reported) await reportPeers();
  throw error;
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await Promise.all(apps.map(closeApp));
  // The restart test closes the original server first.
  if (server.http.listening) await server.close();
  await rm(dir, { recursive: true, force: true });
}
if (errors.length) throw new Error(errors.join("\n"));
async function reportPeers() {
  reported = true;
  for (let index = 0; index < pages.length; index++) {
    const info = await pages[index]
      .evaluate(async () => ({
        call: document.querySelector(".call-status strong, .stage-state")
          ?.textContent,
        peers: await Promise.all(
          window.__testPeers?.map(async (pc) => ({
            connection: pc.connectionState,
            ice: pc.iceConnectionState,
            signaling: pc.signalingState,
            local: pc.localDescription?.type,
            remote: pc.remoteDescription?.type,
            levels: [...(await pc.getStats()).values()]
              .filter(
                (r) => r.type === "inbound-rtp" || r.type === "media-source",
              )
              .map((r) => ({
                type: r.type,
                audioLevel: r.audioLevel,
                totalAudioEnergy: r.totalAudioEnergy,
              })),
            sources: pc.getReceivers().flatMap((receiver) =>
              receiver.getSynchronizationSources().map((source) => ({
                audioLevel: source.audioLevel,
                age: performance.now() - source.timestamp,
              })),
            ),
          })) || [],
        ),
        wire: window.__wire,
      }))
      .catch(() => ({ closed: true }));
    console.error("TEST CONNECTION DIAGNOSTIC", index, JSON.stringify(info));
  }
}
function assertNoErrors() {
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: no renderer errors. Available screenshots are in test-results/.",
  );
}
async function capture(page, options) {
  // Capturing a hidden native window is best-effort on some compositor setups.
  // Functional assertions still fail normally; browser visual checks are separate.
  await page
    .screenshot({ ...options, animations: "disabled", timeout: 10000 })
    .catch(() =>
      console.warn("Screenshot unavailable for a hidden test window."),
    );
}
async function closeApp(app) {
  const timeout = setTimeout(() => app.process().kill(), 3000);
  try {
    await app.close();
  } catch {
  } finally {
    clearTimeout(timeout);
  }
}
