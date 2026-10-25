import { chromium, expect } from "@playwright/test";
import { createGatherServer } from "../server/app.mjs";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "gather-browser-"));
const server = createGatherServer({ dataDir: dir, env: {}, sessionLimit: 100 });
const { port } = await server.listen(0);
const base = process.env.GATHER_BROWSER_SERVER || `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const errors = [];
const testPages = [];
await mkdir("test-results", { recursive: true });
try {
  const context = await browser.newContext({
    permissions: ["microphone", "clipboard-read", "clipboard-write"],
    colorScheme: "dark",
  });
  const friendContext = await browser.newContext({
    permissions: ["microphone"],
  });
  const page = await context.newPage(),
    friend = await friendContext.newPage();
  testPages.push(page, friend);
  for (const p of [page, friend]) {
    p.on("pageerror", (error) => errors.push(error.stack));
    await p.addInitScript(() => {
      window.__sockets = [];
      window.__peers = [];
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(Target, args) {
          const socket = new Target(...args);
          const send = socket.send.bind(socket);
          socket.send = (packet) => {
            if (
              window.__holdSignal &&
              typeof packet === "string" &&
              packet.startsWith("{")
            ) {
              const data = JSON.parse(packet);
              if (data.event === "signal") {
                window.__holdSignal = false;
                window.__heldSignalReply = () =>
                  socket.onmessage({
                    data: JSON.stringify({
                      event: "reply",
                      data: {
                        requestId: data.requestId,
                        error: "That person is not in your call.",
                      },
                    }),
                  });
                return;
              }
            }
            send(packet);
          };
          window.__sockets.push(socket);
          return socket;
        },
      });
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(Target, args) {
          const pc = new Target(...args);
          window.__peers.push(pc);
          return pc;
        },
      });
    });
  }
  await page.goto(base + "/?start");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "test-results/dark-welcome.png" });
  await page.getByLabel("Your name", { exact: true }).fill("Browser Alice");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Appearance", { exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "test-results/dark-settings.png" });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  console.log(
    "PASS: dark/system/light themes follow system changes, persist manual choices, and apply before onboarding renders.",
  );
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("gather.session")),
  );
  const api = async (endpoint, body) => {
    const response = await fetch(base + endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Test API failed: ${response.status}`);
    return response.json();
  };
  const group = (await api("/api/bootstrap")).groups[0];
  await page
    .getByRole("button", { name: "Invite a friend", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Copy invite link", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await friend.goto(base + "/join/" + group.inviteCode);
  await expect(friend.getByRole("textbox")).toHaveCount(1);
  await friend.getByLabel("Your name", { exact: true }).fill("Browser Bob");
  await friend.getByRole("button", { name: "Join chat", exact: true }).click();
  await expect(
    friend.getByRole("heading", { name: group.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 online", { exact: false })).toBeVisible();
  console.log(
    "PASS: real Edge browser onboarding, private invite, clipboard and presence.",
  );
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Draft survives switching");
  await expect(friend.locator(".typing-indicator")).toHaveText(
    "Browser Alice is typing",
  );
  await friend.screenshot({ path: "test-results/typing.png" });
  await expect(friend.locator(".typing-indicator")).toHaveText("", {
    timeout: 7000,
  });
  let releaseBootstrap,
    bootstrapHeld = false;
  const heldBootstrap = new Promise((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    bootstrapHeld = true;
    await heldBootstrap;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.__sockets.at(-1).close());
  await expect.poll(() => bootstrapHeld).toBe(true);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByLabel("Chat name", { exact: true }).fill("Second chat");
  await page.getByRole("button", { name: "Create chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Second chat", exact: true }),
  ).toBeVisible();
  const releasedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/bootstrap"),
  );
  releaseBootstrap();
  await releasedResponse;
  await page.unroute("**/api/bootstrap");
  await expect(
    page.getByRole("heading", { name: "Second chat", exact: true }),
  ).toBeVisible();
  const second = (await api("/api/bootstrap")).groups.find(
    (g) => g.name === "Second chat",
  );
  await friend.goto(base + "/join/" + second.inviteCode);
  await expect(
    friend.getByRole("heading", { name: "Second chat", exact: true }),
  ).toBeVisible();
  await friend.goto(base + "/join/" + group.inviteCode);
  await expect(
    friend.getByRole("heading", { name: group.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search conversations" })
    .fill("usual");
  await expect(page.locator(".chat-list .chat-item")).toHaveCount(1);
  await page.locator(".chat-list .chat-item").click();
  await expect(composer).toHaveValue("Draft survives switching");
  await page.reload();
  await expect(composer).toHaveValue("Draft survives switching");
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  await page.getByRole("button", { name: "Insert 🎮", exact: true }).click();
  await composer.press("Enter");
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Draft survives switching", { exact: true }),
  ).toBeVisible();
  await expect(
    friend
      .locator(".message-bubble")
      .getByRole("img", { name: "🎮", exact: true }),
  ).toBeVisible();
  console.log("PASS: chat creation, search, persisted drafts, emoji and send.");
  // Disconnect the receiver while 120 messages accumulate, then wake its connection.
  await friend.route("**/api/realtime-ticket", (route) => route.abort());
  await friend.evaluate(() => window.__sockets.at(-1).close());
  await expect(
    friend.getByText("Reconnecting…", { exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 120; i++)
    await api(`/api/groups/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: `Outage message ${i}`,
    });
  await friend.unroute("**/api/realtime-ticket");
  await friend.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Outage message 119", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(friend.locator(".message-bubble")).toHaveCount(121);
  console.log(
    "PASS: receiver catches all 120 messages across multiple pages after a signaling outage.",
  );
  // Reload starts with the newest page; older pages can be loaded without duplicates.
  await friend.reload();
  await expect(friend.locator(".message-bubble")).toHaveCount(50);
  await friend.locator(".message-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  // Measure and click in one task: late layout (reading-point restore) can move
  // the list between a separate measurement and the click.
  const anchored = await friend
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .evaluate((button) => {
      const element = document.querySelector(".message-row");
      const y = element
        .querySelector(".message-bubble")
        .getBoundingClientRect().top;
      button.click();
      return { id: element.dataset.messageId, y };
    });
  await expect(friend.locator(".message-bubble")).toHaveCount(100);
  const anchoredAfter = await friend
    .locator(`[data-message-id="${anchored.id}"]`)
    .evaluate(
      (element) =>
        element.querySelector(".message-bubble").getBoundingClientRect().top,
    );
  expect(Math.abs(anchoredAfter - anchored.y)).toBeLessThan(3);
  await friend
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(friend.locator(".message-bubble")).toHaveCount(121);
  await expect(
    friend.getByRole("button", { name: "Load earlier messages", exact: true }),
  ).toHaveCount(0);
  // Drafts/outbox survive a reload and send once after connectivity returns.
  await friend.bringToFront();
  if (await friend.locator(".jump-latest").count())
    await friend.locator(".jump-latest").click();
  await friend.locator(".message-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await api(`/api/groups/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    body: "New while reading history",
  });
  await expect(friend.locator(".jump-latest")).toBeVisible();
  await expect(friend.locator(".jump-latest")).toHaveText("1 new message");
  await friend.screenshot({ path: "test-results/new-messages.png" });
  expect(
    await friend
      .locator(".message-scroll")
      .evaluate((element) => element.scrollTop),
  ).toBeLessThan(3);
  await friend.locator(".jump-latest").click();
  await expect(friend.locator(".jump-latest")).toHaveCount(0);
  console.log(
    "PASS: typing expires without a stop event; history loading anchors the same text; unread messages do not steal scroll position.",
  );
  await friend.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await friend
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Queued across reload");
  await friend
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    friend.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await friend.reload();
  await expect(
    friend.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await friend.unroute("**/api/groups/*/messages");
  await friend.evaluate(() => window.__sockets.at(-1).close());
  await expect(
    page
      .locator(".message-bubble")
      .getByText("Queued across reload", { exact: true }),
  ).toHaveCount(1, { timeout: 20000 });
  console.log(
    "PASS: pagination has no gaps/duplicates; persisted outbox automatically retries once after reconnect.",
  );
  for (const p of [page, friend]) {
    await expect(p.getByText("Online", { exact: true })).toBeVisible();
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
    await expect(
      p.getByRole("region", { name: "Active voice call" }),
    ).toBeVisible();
  }
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 25000,
    });
  for (const p of [page, friend])
    await expect
      .poll(() =>
        p.evaluate(async () => {
          const pc = window.__peers.find(
            (p) => p.connectionState === "connected",
          );
          return (
            pc &&
            [...(await pc.getStats()).values()].some(
              (r) =>
                r.type === "inbound-rtp" &&
                r.kind === "audio" &&
                r.packetsReceived > 10,
            )
          );
        }),
      )
      .toBe(true);
  console.log("PASS: two real Edge contexts exchange WebRTC audio packets.");
  await expect
    .poll(() =>
      page
        .locator(".message-bubble")
        .last()
        .evaluate(
          (element) =>
            element.getBoundingClientRect().bottom <=
            element.closest(".message-scroll").getBoundingClientRect().bottom,
        ),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/dark-call.png" });
  const contrast = await page.evaluate(() => {
    const luminance = (css) => {
      const values = css
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((n) => n / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    return [".message-bubble", ".call-status strong, .stage-state", ".chat-preview"].map(
      (selector) => {
        const element = document.querySelector(selector);
        const foreground = luminance(getComputedStyle(element).color);
        const container =
          selector === ".call-status strong, .stage-state"
            ? element.closest(".call-bar, .call-stage")
            : selector === ".chat-preview"
              ? element.closest(".chat-item")
              : element;
        const background = luminance(
          getComputedStyle(container).backgroundColor,
        );
        return {
          selector,
          ratio:
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05),
        };
      },
    );
  });
  contrast.forEach((entry) =>
    expect(
      entry.ratio,
      `Dark theme contrast: ${entry.selector}`,
    ).toBeGreaterThanOrEqual(4.5),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const downloading = page.waitForEvent("download");
  const peerBeforeTheme = await page.evaluate(() =>
    window.__peers.indexOf(
      window.__peers.find((p) => p.connectionState === "connected"),
    ),
  );
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() =>
      window.__peers.indexOf(
        window.__peers.find((p) => p.connectionState === "connected"),
      ),
    ),
  ).toBe(peerBeforeTheme);
  await page
    .getByRole("button", { name: "Export your chat history", exact: true })
    .click();
  const download = await downloading;
  const archive = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(archive.format).toBe("gather-archive-v1");
  expect(archive.groups.find((g) => g.id === group.id).messages).toHaveLength(
    123,
  );
  await page.getByLabel("Your name", { exact: true }).fill("Renamed Alice");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".profile-bar strong")).toHaveText("Renamed Alice");
  await expect(page.getByText("Voice connected", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    friend.getByText("Voice connected", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect(
    await page.evaluate(() =>
      window.__peers.indexOf(
        window.__peers.find((pc) => pc.connectionState === "connected"),
      ),
    ),
  ).toBe(peerBeforeTheme);
  await friend.evaluate(() => {
    window.__holdSignal = true;
    window.__peers
      .find((p) => p.connectionState === "connected")
      .onicecandidate({ candidate: { toJSON: () => ({ candidate: "" }) } });
  });
  await expect
    .poll(() => friend.evaluate(() => Boolean(window.__heldSignalReply)))
    .toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  await expect(
    friend.getByText("Waiting for a friend", { exact: true }),
  ).toBeVisible();
  await friend.evaluate(() => window.__heldSignalReply());
  await expect(
    friend.getByText("Waiting for a friend", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("gather.session")))
    .toBe(null);
  const revoked = await fetch(base + "/api/bootstrap", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(revoked.status).toBe(401);
  console.log(
    "PASS: history export, profile update during voice, and sign-out work; a late signal error cannot revive a departed peer.",
  );
  await friend.getByRole("button", { name: "Leave call", exact: true }).click();
  let writesDuringQuotaFailure = 0;
  await friend.route("**/api/groups/*/messages", async (route) => {
    if (route.request().method() === "POST") writesDuringQuotaFailure++;
    await route.continue();
  });
  await friend.evaluate(() => {
    window.__savedHistoryPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "outbox")
        throw new DOMException("Injected full disk", "QuotaExceededError");
      return window.__savedHistoryPut.apply(this, args);
    };
  });
  await friend
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep my draft when storage fails");
  await friend
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    friend.getByText(
      "Your message could not be saved on this device. Check free storage; your draft has been kept.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    friend.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep my draft when storage fails");
  expect(writesDuringQuotaFailure).toBe(0);
  await friend.evaluate(() => {
    IDBObjectStore.prototype.put = window.__savedHistoryPut;
  });
  await friend.unroute("**/api/groups/*/messages");
  await friend
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Keep my draft when storage fails", { exact: true }),
  ).toBeVisible();
  await expect(
    friend.locator(".message-row").last().locator(".delivery-state"),
  ).toHaveText("Saved to chat");
  await friend.route("**/api/**", (route) => route.abort());
  await friend.reload();
  await expect(
    friend.getByRole("heading", { name: "The usual crew", exact: true }),
  ).toBeVisible();
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Keep my draft when storage fails", { exact: true }),
  ).toBeVisible();
  await friend
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Offline queue after restarting");
  await friend
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    friend.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await friend.reload();
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Offline queue after restarting", { exact: true }),
  ).toHaveCount(1);
  await friend.unroute("**/api/**");
  await friend.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(friend.getByText("Online", { exact: true })).toBeVisible();
  await expect(
    friend.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await expect(
    friend
      .locator(".message-bubble")
      .getByText("Offline queue after restarting", { exact: true }),
  ).toHaveCount(1);
  console.log(
    "PASS: storage failure preserves the draft and sends nothing; cached history and durable outbox survive repeated restarts with the backend unavailable.",
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: browser pass has no uncaught renderer errors.");
} catch (error) {
  for (let index = 0; index < testPages.length; index++) {
    const info = await testPages[index]
      .evaluate(async () => ({
        call: document.querySelector(".call-status strong, .stage-state")?.textContent,
        scroll: (() => {
          const list = document.querySelector(".message-scroll"),
            last = document.querySelectorAll(".message-bubble");
          return list && last.length
            ? {
                top: list.scrollTop,
                height: list.scrollHeight,
                client: list.clientHeight,
                messageBottom:
                  last[last.length - 1].getBoundingClientRect().bottom,
                viewportBottom: list.getBoundingClientRect().bottom,
              }
            : null;
        })(),
        peers: await Promise.all(
          window.__peers.map(async (pc) => ({
            connection: pc.connectionState,
            ice: pc.iceConnectionState,
            signaling: pc.signalingState,
            local: pc.localDescription?.type,
            remote: pc.remoteDescription?.type,
            candidates: [...(await pc.getStats()).values()]
              .filter((r) => r.type === "candidate-pair")
              .map((r) => ({
                state: r.state,
                requestsSent: r.requestsSent,
                responsesReceived: r.responsesReceived,
              })),
          })),
        ),
      }))
      .catch(() => ({ closed: true }));
    console.error("TEST BROWSER DIAGNOSTIC", index, JSON.stringify(info));
    await testPages[index]
      .screenshot({
        path: `test-results/browser-failure-${index}.png`,
        timeout: 5000,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
