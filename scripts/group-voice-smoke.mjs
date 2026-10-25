import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { createGatherServer } from "../server/app.mjs";
config({ quiet: true });

const directory = await mkdtemp(path.join(tmpdir(), "gather-group-voice-"));
const audioFile = path.join(directory, "voice.wav");
const rate = 48000,
  samples = rate * 8;
const wave = Buffer.alloc(44 + samples * 2);
wave.write("RIFF", 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(rate, 24);
wave.writeUInt32LE(rate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index++) {
  const time = index / rate;
  const envelope = 0.25 + 0.75 * Math.sin(2 * Math.PI * 2.3 * time) ** 2;
  const signal =
    Math.sin(2 * Math.PI * 193 * time) +
    0.4 * Math.sin(2 * Math.PI * 467 * time);
  wave.writeInt16LE(Math.round(signal * envelope * 7000), 44 + index * 2);
}
await writeFile(audioFile, wave);
const forcedRelay = process.env.GATHER_GROUP_RELAY === "1";
const server = createGatherServer({
  dataDir: path.join(directory, "server"),
  sessionLimit: 100,
  env: forcedRelay ? process.env : {},
});
const { port } = await server.listen(0);
const base = process.env.GATHER_GROUP_SERVER || `http://127.0.0.1:${port}`;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
  throw new Error(
    "Group voice fixtures require an isolated loopback deployment.",
  );
const mode = process.env.GATHER_GROUP_ENGINE || "mixed";
if (!["mixed", "desktop", "browser"].includes(mode))
  throw new Error("Unknown group voice test engine.");
const soak = Number(process.env.GATHER_GROUP_SOAK_SECONDS || 10);
if (!Number.isFinite(soak) || soak < 5 || soak > 3600)
  throw new Error("Group soak must be between 5 and 3600 seconds.");
const args = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${audioFile}`,
];
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args,
});
const apps = [],
  pages = [],
  errors = [];
const report = {
  mode,
  forcedRelay,
  logicalProcessors: cpus().length,
  twoPerson: [],
  fourPerson: [],
  checks: [],
  timings: [],
};
async function api(route, body, token) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Group fixture request failed (${response.status}).`);
  return response.json();
}
function instrument() {
  window.__peers = [];
  window.__sockets = [];
  window.__captures = [];
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(Target, args) {
      const peer = new Target(...args);
      window.__peers.push(peer);
      return peer;
    },
  });
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(Target, args) {
      const socket = new Target(...args),
        send = socket.send.bind(socket);
      socket.send = (raw) => {
        if (typeof raw === "string" && raw.startsWith("{")) {
          const packet = JSON.parse(raw);
          if (window.__dropSignals && packet.event === "signal") return;
          if (window.__dropJoin && packet.event === "voice:join") {
            window.__dropJoin = false;
            return;
          }
        }
        send(raw);
      };
      window.__sockets.push(socket);
      return socket;
    },
  });
  const capture = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await capture(...args);
    window.__captures.push(stream);
    return stream;
  };
  window.__activePeers = () =>
    window.__peers.filter((peer) => peer.connectionState !== "closed");
  window.__remote = (peer) => {
    const tracks = new Set(
      peer.getReceivers().map((receiver) => receiver.track.id),
    );
    return [...document.querySelectorAll("audio[data-gather-audio]")].find(
      (audio) =>
        audio.srcObject?.getAudioTracks().some((track) => tracks.has(track.id)),
    )?.dataset.gatherAudio;
  };
}
async function client(profile, index, forceBrowser = false) {
  let app, page;
  if (
    !forceBrowser &&
    (mode === "desktop" || (mode === "mixed" && index < 2))
  ) {
    const env = {
      ...process.env,
      GATHER_TEST_DATA: path.join(directory, `client-${index}`),
      GATHER_TEST_PORT: String(port),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      ...(process.env.GATHER_GROUP_PACKAGED === "1"
        ? { executablePath: path.resolve("release/win-unpacked/Gather.exe") }
        : {}),
      args: [path.resolve("."), ...args],
      env,
      timeout: 30000,
    });
    apps.push(app);
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.hide()),
    );
    await expect(
      page.getByRole("heading", { name: "Welcome to Gather", exact: true }),
    ).toBeVisible();
    await page.addInitScript(instrument);
    if (index === 0) await renewalFixture(page);
    await page.evaluate(
      ({ profile, base, forcedRelay }) => {
        localStorage.setItem(
          "gather.session",
          JSON.stringify({ ...profile, server: base }),
        );
        if (forcedRelay) localStorage.setItem("gather.relayOnly", "true");
      },
      { profile, base, forcedRelay },
    );
    await page.reload();
  } else {
    const context = await browser.newContext({
      permissions: ["microphone"],
      colorScheme: "dark",
      viewport: { width: 1220, height: 840 },
    });
    await context.addInitScript(instrument);
    await context.addInitScript(
      ({ profile, base, forcedRelay }) => {
        localStorage.setItem(
          "gather.session",
          JSON.stringify({ ...profile, server: base }),
        );
        if (forcedRelay) localStorage.setItem("gather.relayOnly", "true");
      },
      { profile, base, forcedRelay },
    );
    page = await context.newPage();
    if (index === 0) await renewalFixture(page);
    await page.goto(base);
  }
  page.on("pageerror", (error) => errors.push(error.message));
  pages.push(page);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  return { app, page };
}
async function renewalFixture(page) {
  let requests = 0;
  await page.route("**/api/groups/*/ice", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    requests++;
    await page.evaluate((count) => {
      window.__iceRequests = count;
    }, requests);
    await route.fulfill({
      response,
      json:
        requests === 1
          ? { ...data, relayAvailable: true, expiresIn: 12 }
          : data,
    });
  });
}
async function ready(clients, count) {
  for (const { page } of clients) {
    await expect(
      page.getByText("Voice connected", { exact: true }),
    ).toBeVisible({ timeout: 35000 });
    await expect(page.locator(".call-person, .call-tile")).toHaveCount(count);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window
                .__activePeers()
                .filter((peer) => peer.connectionState === "connected").length,
          ),
        { timeout: 35000 },
      )
      .toBe(count - 1);
    expect(
      await page.evaluate(
        () =>
          window.__captures
            .flatMap((stream) => stream.getAudioTracks())
            .filter((track) => track.readyState === "live").length,
      ),
    ).toBe(1);
    expect(await page.locator("audio[data-gather-audio]").count()).toBe(
      count - 1,
    );
  }
}
async function timedReady(scenario, clients, count, started, targetMs) {
  await ready(clients, count);
  const elapsedMs = Date.now() - started;
  report.timings.push({ scenario, elapsedMs, targetMs });
  expect(
    elapsedMs,
    `${scenario} exceeded its pilot timing target`,
  ).toBeLessThan(targetMs);
}
async function sample({ page, app }) {
  const data = await page.evaluate(async () => {
    const peers = await Promise.all(
      window.__activePeers().map(async (peer) => {
        const stats = await peer.getStats();
        let sent = 0,
          received = 0,
          packets = 0,
          lost = 0,
          energy = 0,
          jitter = 0,
          rtt = 0;
        const routes = new Set(),
          codecs = new Set();
        stats.forEach((entry) => {
          if (entry.type === "outbound-rtp" && entry.kind === "audio") {
            sent += entry.bytesSent ?? 0;
            const codec = stats.get(entry.codecId);
            if (codec) codecs.add(codec.mimeType);
          }
          if (entry.type === "inbound-rtp" && entry.kind === "audio") {
            received += entry.bytesReceived ?? 0;
            packets += entry.packetsReceived ?? 0;
            lost += entry.packetsLost ?? 0;
            energy += entry.totalAudioEnergy ?? 0;
            jitter = Math.max(jitter, entry.jitter ?? 0);
          }
          if (entry.type === "transport" && entry.selectedCandidatePairId) {
            const pair = stats.get(entry.selectedCandidatePairId);
            if (pair) {
              rtt = Math.max(rtt, pair.currentRoundTripTime ?? 0);
              for (const id of [
                pair.localCandidateId,
                pair.remoteCandidateId,
              ]) {
                const candidate = stats.get(id);
                if (candidate) routes.add(candidate.candidateType);
              }
            }
          }
        });
        return {
          sent,
          received,
          packets,
          lost,
          energy,
          jitter,
          rtt,
          routes: [...routes],
          codecs: [...codecs],
        };
      }),
    );
    return {
      at: Date.now(),
      peers,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
    };
  });
  if (app)
    data.processes = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((entry) => ({
        type: entry.type,
        cpuPercent: entry.cpu.percentCPUUsage,
        workingSetKB: entry.memory.workingSetSize,
        privateKB: entry.memory.privateBytes,
      })),
    );
  return data;
}
async function measure(clients, seconds) {
  let previous = await Promise.all(clients.map(sample));
  const results = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(5, seconds - elapsed) * 1000),
    );
    const next = await Promise.all(clients.map(sample));
    results.push(
      next.map((current, index) => {
        const old = previous[index],
          duration = (current.at - old.at) / 1000;
        expect(current.peers).toHaveLength(clients.length - 1);
        const summary = {
          sentBitsPerSecond: 0,
          receivedBitsPerSecond: 0,
          packetLoss: 0,
          receivedPackets: 0,
          maxJitterMs: 0,
          maxRttMs: 0,
          heapBytes: current.heapBytes,
          processes: current.processes,
          routes: [],
          codecs: [],
        };
        for (let peer = 0; peer < current.peers.length; peer++) {
          const a = old.peers[peer],
            b = current.peers[peer];
          expect(b.sent - a.sent).toBeGreaterThan(0);
          expect(b.received - a.received).toBeGreaterThan(0);
          expect(b.energy - a.energy).toBeGreaterThan(0);
          if (forcedRelay) expect(b.routes).toContain("relay");
          summary.sentBitsPerSecond += ((b.sent - a.sent) * 8) / duration;
          summary.receivedBitsPerSecond +=
            ((b.received - a.received) * 8) / duration;
          summary.packetLoss += Math.max(0, b.lost - a.lost);
          summary.receivedPackets += Math.max(0, b.packets - a.packets);
          summary.maxJitterMs = Math.max(summary.maxJitterMs, b.jitter * 1000);
          summary.maxRttMs = Math.max(summary.maxRttMs, b.rtt * 1000);
          summary.routes.push(...b.routes);
          summary.codecs.push(...b.codecs);
        }
        return summary;
      }),
    );
    previous = next;
    if (seconds >= 30 && (elapsed + 5) % 30 === 0)
      console.log(
        `PROGRESS: four-party audio still flowing on every connection after ${elapsed + 5}s.`,
      );
  }
  return results;
}
try {
  const profiles = [];
  let group;
  for (const name of ["Alice", "Ben", "Mira", "Theo", "Fifth friend"]) {
    const profile = await api("/api/sessions", {
      name,
      ...(group ? { inviteCode: group.inviteCode } : {}),
    });
    if (!group)
      group = (await api("/api/bootstrap", null, profile.token)).groups[0];
    profiles.push(profile);
  }
  const clients = [];
  for (let index = 0; index < 4; index++)
    clients.push(await client(profiles[index], index));
  let started = Date.now();
  for (const current of clients.slice(0, 2))
    await current.page
      .getByRole("button", { name: "Join voice", exact: true })
      .click();
  await timedReady("two-party join", clients.slice(0, 2), 2, started, 10000);
  report.twoPerson = await measure(clients.slice(0, 2), 5);
  started = Date.now();
  await clients[2].page
    .getByRole("button", { name: "Join voice", exact: true })
    .click();
  await timedReady("third participant", clients.slice(0, 3), 3, started, 10000);
  await clients[3].page.evaluate(() => {
    window.__dropSignals = true;
  });
  await clients[3].page
    .getByRole("button", { name: "Join voice", exact: true })
    .click();
  for (const current of clients.slice(0, 3)) {
    await expect(
      current.page.getByText("Connecting a friend…", { exact: true }),
    ).toBeVisible();
    expect(
      await current.page.evaluate(
        () =>
          window
            .__activePeers()
            .filter((peer) => peer.connectionState === "connected").length,
      ),
    ).toBe(2);
  }
  started = Date.now();
  await clients[3].page.evaluate(() => {
    window.__dropSignals = false;
  });
  await timedReady(
    "delayed fourth participant after signaling resumes",
    clients,
    4,
    started,
    15000,
  );
  await expect
    .poll(() => clients[0].page.evaluate(() => window.__iceRequests), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(2);
  console.log(
    "PASS: mixed four-party voice forms all six connections; a delayed fourth participant does not interrupt the first three.",
  );
  report.fourPerson = await measure(clients, soak);
  report.checks.push(
    "four-party RTP and decoded audio on all twelve directed paths",
    "one microphone per participant",
    "partial connection state",
    "temporary relay settings refresh during the call",
  );
  await mkdir("test-results", { recursive: true });
  await clients[0].page.screenshot({
    path: `test-results/group-voice-${mode}${forcedRelay ? "-relay" : ""}.png`,
  });
  const fifth = await client(profiles[4], 4, true);
  // The header and the voice banner each show a disabled "Voice full" button.
  const full = fifth.page.getByRole("button", {
    name: "Voice full",
    exact: true,
  });
  await expect(full).toHaveCount(2);
  for (const button of await full.all()) await expect(button).toBeDisabled();
  expect(await fifth.page.evaluate(() => window.__captures.length)).toBe(0);
  const aliceTrack = await clients[0].page.evaluate(
    () => window.__captures[0].getAudioTracks()[0].id,
  );
  await clients[0].page
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await clients[0].page
    .getByRole("button", { name: "Deafen", exact: true })
    .click();
  expect(
    await clients[0].page.evaluate(() =>
      [...document.querySelectorAll("audio[data-gather-audio]")].every(
        (audio) => audio.muted,
      ),
    ),
  ).toBe(true);
  await clients[0].page
    .getByRole("button", { name: "Undeafen", exact: true })
    .click();
  await expect(
    clients[0].page.getByRole("button", {
      name: "Unmute microphone",
      exact: true,
    }),
  ).toBeVisible();
  await clients[0].page
    .getByRole("button", { name: "Audio settings", exact: true })
    .click();
  const microphone = await clients[0].page
    .locator("#microphone option")
    .nth(1)
    .getAttribute("value");
  await clients[0].page.evaluate(() => {
    const original = RTCRtpSender.prototype.replaceTrack;
    let calls = 0;
    RTCRtpSender.prototype.replaceTrack = function (track) {
      if (++calls === 2) {
        RTCRtpSender.prototype.replaceTrack = original;
        return Promise.reject(
          new DOMException(
            "Injected partial microphone switch",
            "InvalidStateError",
          ),
        );
      }
      return original.call(this, track);
    };
  });
  await clients[0].page
    .getByLabel("Microphone", { exact: true })
    .selectOption(microphone);
  await expect(clients[0].page.getByRole("alert")).toContainText(
    "previous selection is still in use",
  );
  expect(
    await clients[0].page.evaluate(
      (id) =>
        window.__activePeers().every((peer) =>
          peer
            .getSenders()
            .filter((sender) => sender.track)
            .every((sender) => sender.track.id === id && !sender.track.enabled),
        ),
      aliceTrack,
    ),
  ).toBe(true);
  await expect(
    clients[0].page.getByLabel("Microphone", { exact: true }),
  ).toHaveValue("default");
  await clients[0].page.evaluate(() => {
    const original = RTCRtpSender.prototype.replaceTrack;
    let calls = 0;
    RTCRtpSender.prototype.replaceTrack = function (track) {
      const call = ++calls;
      if (call === 2 || call === 4) {
        if (call === 4) RTCRtpSender.prototype.replaceTrack = original;
        return Promise.reject(
          new DOMException(
            "Injected switch and rollback failure",
            "InvalidStateError",
          ),
        );
      }
      return original.call(this, track);
    };
  });
  await clients[0].page
    .getByLabel("Microphone", { exact: true })
    .selectOption(microphone);
  await expect(clients[0].page.getByRole("alert")).toContainText(
    "Reconnecting with your previous microphone",
  );
  await ready(clients, 4);
  expect(
    await clients[0].page.evaluate(
      (id) =>
        window.__activePeers().every((peer) =>
          peer
            .getSenders()
            .filter((sender) => sender.track)
            .every((sender) => sender.track.id === id && !sender.track.enabled),
        ),
      aliceTrack,
    ),
  ).toBe(true);
  const output = await clients[0].page
    .locator("#speaker option")
    .nth(1)
    .getAttribute("value");
  await clients[0].page.evaluate(() => {
    const original = HTMLMediaElement.prototype.setSinkId;
    let calls = 0;
    HTMLMediaElement.prototype.setSinkId = function (id) {
      if (++calls === 2) {
        HTMLMediaElement.prototype.setSinkId = original;
        return Promise.reject(
          new DOMException("Injected partial output switch", "NotFoundError"),
        );
      }
      return original.call(this, id);
    };
  });
  await clients[0].page
    .getByLabel("Headphones / speakers", { exact: true })
    .selectOption(output);
  await expect(clients[0].page.getByRole("alert")).toContainText(
    "previous output is being restored",
  );
  expect(
    await clients[0].page.evaluate(() =>
      [...document.querySelectorAll("audio[data-gather-audio]")].every(
        (audio) => !audio.sinkId || audio.sinkId === "default",
      ),
    ),
  ).toBe(true);
  await clients[0].page
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await ready(clients, 4);
  report.checks.push(
    "deafen covers every peer",
    "partial microphone and output changes roll back",
    "failed microphone rollback rebuilds audio with the original muted track",
  );
  console.log(
    "PASS: four-party mute/deafen, partial device changes, and rollback failure recover without leaking capture or silently losing one friend’s audio.",
  );
  for (const current of clients.slice(1))
    await current.page.evaluate((alice) => {
      window.__stablePeers = window
        .__activePeers()
        .filter((peer) => window.__remote(peer) !== alice);
    }, profiles[0].user.id);
  started = Date.now();
  await clients[0].page.evaluate(() => {
    window.__dropJoin = true;
    window.__sockets
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .forEach((socket) => socket.close());
  });
  await expect(
    clients[0].page.getByText("Reconnecting voice…", { exact: true }),
  ).toBeVisible();
  await timedReady("dropped rejoin", clients, 4, started, 15000);
  for (const current of clients.slice(1))
    expect(
      await current.page.evaluate(
        () =>
          window.__stablePeers.length === 2 &&
          window.__stablePeers.every(
            (peer) => peer.connectionState === "connected",
          ),
      ),
    ).toBe(true);
  expect(
    await clients[0].page.evaluate(
      () => window.__captures[0].getAudioTracks()[0].id,
    ),
  ).toBe(aliceTrack);
  expect(
    await clients[0].page.evaluate(() =>
      window
        .__activePeers()
        .every((peer) =>
          peer
            .getSenders()
            .every((sender) => !sender.track || !sender.track.enabled),
        ),
    ),
  ).toBe(true);
  console.log(
    "PASS: a dropped rejoin recovers the muted participant without replacing the microphone or the other friends’ working connections.",
  );
  started = Date.now();
  for (const current of clients.slice(0, 2))
    await current.page.evaluate(() =>
      window.__sockets
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .forEach((socket) => socket.close()),
    );
  await timedReady("simultaneous reconnects", clients, 4, started, 15000);
  await expect(
    clients[0].page.getByRole("button", {
      name: "Unmute microphone",
      exact: true,
    }),
  ).toBeVisible();
  const replacement = await client(profiles[0], 5, true);
  await expect(
    replacement.page.getByRole("button", { name: "Join voice", exact: true }),
  ).toBeEnabled();
  started = Date.now();
  await replacement.page
    .getByRole("button", { name: "Join voice", exact: true })
    .click();
  await expect(
    clients[0].page.getByRole("region", {
      name: "Active voice call",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await clients[0].page.evaluate(() =>
      window.__captures.every((stream) =>
        stream.getTracks().every((track) => track.readyState === "ended"),
      ),
    ),
  ).toBe(true);
  await timedReady(
    "full-call device takeover",
    [replacement, ...clients.slice(1)],
    4,
    started,
    10000,
  );
  report.checks.push(
    "fifth caller is blocked before capture",
    "lost rejoin and simultaneous reconnects preserve mute",
    "full-call same-identity takeover stops old capture",
  );
  for (const current of [replacement, ...clients.slice(1)])
    await current.page
      .getByRole("button", { name: "Leave call", exact: true })
      .click();
  for (const current of [replacement, ...clients]) {
    await expect(current.page.locator("audio[data-gather-audio]")).toHaveCount(
      0,
    );
    expect(
      await current.page.evaluate(() =>
        window.__captures.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
    ).toBe(true);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    `test-results/group-voice-${mode}${forcedRelay ? "-relay" : ""}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS: full-call takeover, repeated recovery and capture cleanup. Resource and RTP measurements saved without credentials or candidate addresses.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  const diagnostic = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    await page
      .screenshot({ path: `test-results/group-voice-failure-${index}.png` })
      .catch(() => {});
    diagnostic.push(
      await page
        .evaluate(() => ({
          peers: window.__peers?.map((peer) => ({
            state: peer.connectionState,
            ice: peer.iceConnectionState,
            signaling: peer.signalingState,
          })),
          liveMicrophones: window.__captures
            ?.flatMap((stream) => stream.getAudioTracks())
            .filter((track) => track.readyState === "live").length,
        }))
        .catch(() => ({ unavailable: true })),
    );
  }
  await writeFile(
    "test-results/group-voice-failure.json",
    JSON.stringify(diagnostic, null, 2),
  );
  throw error;
} finally {
  for (const app of apps) await app.close().catch(() => {});
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
