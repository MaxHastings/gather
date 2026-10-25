import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
const dir = await mkdtemp(join(tmpdir(), "gather-interaction-"));
const server = createGatherServer({ dataDir: dir, env: {} }),
  { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const api = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const a = {
    ...(await api("POST", "/api/sessions", { name: "Interaction Max" })),
    server: base,
  },
  group = (await api("GET", "/api/bootstrap", {}, a.token)).groups[0];
const b = {
  ...(await api("POST", "/api/sessions", {
    name: "Interaction Jamie",
    inviteCode: group.inviteCode,
  })),
  server: base,
};
const count = Number(process.env.GATHER_INTERACTION_MESSAGES || 1000);
const media = new Map();
for (const n of [10, 210, 410, 610, 810].filter((n) => n < count)) {
  const bytes = await readFile("tests/fixtures/one-more-game.gif"),
    file = {
      id: randomUUID(),
      name: `memory-${n}.gif`,
      type: "image/gif",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  await api("POST", `/api/groups/${group.id}/uploads`, file, a.token);
  const result = await server.domain.mediaRequest(
    new Request(`${base}/api/uploads/${file.id}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}` },
      body: bytes,
    }),
  );
  assert.equal(result.status, 200);
  media.set(n, file.id);
}
for (let i = 0; i < count; i++)
  await api(
    "POST",
    `/api/groups/${group.id}/messages`,
    {
      clientId: randomUUID(),
      body:
        `Message ${i}. ` +
        (i % 11 === 0
          ? "Unicode 日本語 👨‍👩‍👧‍👦 :msn-smile: **hello** https://example.com/a(b). "
          : i % 97 === 0
            ? "A long word " + "x".repeat(1400)
            : "Normal conversation with a few emoji 😂 👍 and some longer text. ".repeat(
                4,
              )),
      ...(media.has(i) ? { attachmentIds: [media.get(i)] } : {}),
    },
    i % 3 === 0 && !media.has(i) ? b.token : a.token,
  );

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const errors = [];
let requests = 0;
try {
  const pages = [];
  for (const session of [a, b]) {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(
      ({ session, id }) => {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(`gather.selected.${session.user.id}`, id);
        window.__tasks = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__tasks.push(e.duration);
        }).observe({ type: "longtask", buffered: true });
        window.__peers = [];
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(Target, args) {
            const pc = new Target(...args);
            window.__peers.push(pc);
            return pc;
          },
        });
      },
      { session, id: group.id },
    );
    const page = await context.newPage();
    page.on("request", () => requests++);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400)
        console.log("HTTP", r.status(), new URL(r.url()).pathname);
    });
    await page.goto(base);
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    pages.push(page);
  }
  const [page, friend] = pages,
    rows = page.locator(".message-row");
  await expect(rows).toHaveCount(50);
  while ((await rows.count()) < count) {
    const before = await rows.count();
    console.log("Paging", before);
    await page
      .getByRole("button", { name: "Load earlier messages", exact: true })
      .click();
    await expect
      .poll(() => rows.count(), { timeout: 10000 })
      .toBeGreaterThan(before);
  }
  for (const p of pages)
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of pages)
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 25000,
    });
  const packets = () =>
    friend.evaluate(async () => {
      let packets = 0;
      for (const pc of window.__peers)
        for (const r of (await pc.getStats()).values())
          if (r.type === "inbound-rtp" && r.kind === "audio")
            packets += r.packetsReceived ?? 0;
      return packets;
    });
  await expect.poll(packets, { timeout: 15000 }).toBeGreaterThan(10);
  const beforePackets = await packets();
  await page.locator(".message-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  await expect(page.locator(".emoji-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heapBefore = (await cdp.send("Performance.getMetrics")).metrics.find(
    (m) => m.name === "JSHeapUsedSize",
  ).value;
  await page.evaluate(() => (window.__tasks = []));
  const open = [];
  for (let i = 0; i < 12; i++) {
    open.push(
      await page.evaluate(async () => {
        const start = performance.now();
        document.querySelector('[aria-label="Add emoji"]').click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      }),
    );
    await expect(page.locator(".emoticon-grid button").first()).toBeVisible();
    expect(await page.locator(".emoticon-grid button").count()).toBeLessThan(
      120,
    );
    await page.keyboard.press("Escape");
  }
  const search = await page.evaluate(async () => {
    document.querySelector('[aria-label="Add emoji"]').click();
    await new Promise(requestAnimationFrame);
    const input = document.querySelector(".emoji-picker input"),
      start = performance.now();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, "party");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  await page.keyboard.press("Escape");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("hello friend");
  await input.evaluate((el) => el.setSelectionRange(6, 6));
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  const selection = await page.evaluate(async () => {
    const start = performance.now();
    document.querySelector('button[aria-label="Insert 😂"]').click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  await expect(input).toHaveValue("hello 😂friend");
  await input.press("Control+z");
  await expect(input).toHaveValue("hello friend");
  const typing = [];
  for (let i = 0; i < 12; i++)
    typing.push(
      await page.evaluate(async (i) => {
        const input = document.querySelector('textarea[aria-label="Message"]'),
          start = performance.now();
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        ).set.call(input, `Typing test ${i}`);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: String(i),
          }),
        );
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      }, i),
    );
  const frames = await page.evaluate(async () => {
    const element = document.querySelector(".message-scroll"),
      gaps = [];
    let last = performance.now();
    for (let i = 0; i < 90; i++) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      element.scrollTop = Math.max(0, element.scrollTop - 180);
    }
    return gaps;
  });
  const report = await page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNodes = 0;
    while (w.nextNode()) textNodes++;
    return {
      elements: document.getElementsByTagName("*").length,
      textNodes,
      longTasks: window.__tasks.length,
      longestTaskMs: Math.max(0, ...window.__tasks),
    };
  });
  const p95 = (a) =>
    [...a].sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1];
  const result = {
    loadedMessages: count,
    pickerOpenMs: open.map(Math.round),
    pickerP95: Math.round(p95(open)),
    typingP95: Math.round(p95(typing)),
    scrollFrameP95: Math.round(p95(frames)),
    ...report,
    searchMs: Math.round(search),
    selectionMs: Math.round(selection),
    requests,
    jsHeapBefore: heapBefore,
    jsHeapAfter: (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "JSHeapUsedSize",
    ).value,
    sqliteBytes:
      server.db.prepare("PRAGMA page_count").get().page_count *
      server.db.prepare("PRAGMA page_size").get().page_size,
    audioContinued: (await packets()) > beforePackets,
    completedAt: new Date().toISOString(),
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/interaction-0.3.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.searchMs < 200, "Picker search exceeds 200ms");
  assert.ok(result.selectionMs < 200, "Selection exceeds 200ms");
  assert.ok(result.pickerP95 < 200, "Warm picker exceeds 200ms");
  assert.ok(result.typingP95 < 200, "Typing exceeds 200ms");
  assert.ok(result.scrollFrameP95 < 50, "Repeated scroll frame stalls");
  assert.ok(result.audioContinued);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: populated history, bounded picker, cursor/undo, measured input/scroll pacing and continuing audio.",
  );
} catch (error) {
  console.log("Fixture errors:", errors);
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    console.log("Visible rows:", await p.locator(".message-row").count());
    console.log(
      await p
        .locator("body")
        .innerText()
        .then((t) => t.slice(-1600)),
    );
    await p
      .screenshot({ path: "test-results/interaction-failure.png" })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
  assert.ok(dir.startsWith(join(tmpdir(), "gather-interaction-")));
  await rm(dir, { recursive: true, force: true });
}
