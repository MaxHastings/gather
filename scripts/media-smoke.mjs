import { chromium, _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatherServer } from "../server/app.mjs";
import assert from "node:assert/strict";

const dir = await mkdtemp(join(tmpdir(), "gather-sharing-"));
const server = createGatherServer({
  dataDir: join(dir, "server"),
  env: {},
  sessionLimit: 100,
});
const { port } = await server.listen(0),
  base = process.env.GATHER_MEDIA_SERVER || `http://127.0.0.1:${port}`;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error("Use an isolated loopback server for media fixtures.");
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const env = {
  ...process.env,
  GATHER_TEST_DATA: join(dir, "desktop"),
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
let app, friend;
const errors = [];
try {
  const create = async (name) => {
    const r = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.ok(r.ok);
    return { ...(await r.json()), server: base };
  };
  const alice = await create("Max"),
    bob = await create("Jamie");
  const state = await fetch(base + "/api/bootstrap", {
    headers: { Authorization: `Bearer ${alice.token}` },
  }).then((r) => r.json());
  const group = state.groups[0];
  assert.ok(
    (
      await fetch(base + "/api/groups/join", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: group.inviteCode }),
      })
    ).ok,
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone"],
    acceptDownloads: true,
  });
  await context.addInitScript(
    (s) => localStorage.setItem("gather.session", JSON.stringify(s)),
    bob,
  );
  friend = await context.newPage();
  await friend.goto(base);
  app = await electron.launch({
    args: [
      ".",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  await page.evaluate(async (s) => window.desktop.writeSession(s, null), alice);
  await page.reload();
  for (const p of [page, friend]) {
    p.on("pageerror", (e) => errors.push(e.message));
    await expect(p.getByText("Online", { exact: true })).toBeVisible();
  }
  const fixtures = await friend.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#195a89";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "white";
    ctx.font = "28px sans-serif";
    ctx.fillText("Gather friends", 45, 100);
    const results = [];
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
      results.push({
        name: `friends.${type.split("/")[1]}`,
        type,
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
      });
    }
    const stream = canvas.captureStream(10),
      chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/mp4;codecs=avc1.42001E",
    });
    const finished = new Promise((resolve) => {
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = resolve;
    });
    recorder.start();
    const animation = setInterval(() => {
      ctx.fillStyle = "#195a89";
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "white";
      ctx.fillText(`Gather ${Date.now() % 1000}`, 45, 100);
    }, 70);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    clearInterval(animation);
    recorder.stop();
    await finished;
    stream.getTracks().forEach((t) => t.stop());
    results.push({
      name: "friends.mp4",
      type: "video/mp4",
      bytes: [
        ...new Uint8Array(
          await new Blob(chunks, { type: "video/mp4" }).arrayBuffer(),
        ),
      ],
    });
    return results;
  });
  fixtures.push({
    name: "wave.gif",
    type: "image/gif",
    bytes: [...(await readFile("tests/fixtures/one-more-game.gif"))],
  });
  // Valid zero-spectrum MPEG-1 Layer III silence frames, generated locally.
  const mp3Frame = Buffer.alloc(417);
  mp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
  fixtures.push({
    name: "quiet.mp3",
    type: "audio/mpeg",
    bytes: [...Buffer.concat(Array.from({ length: 40 }, () => mp3Frame))],
  });
  fixtures.push({
    name: "notes.txt",
    type: "text/plain",
    bytes: [...Buffer.from("Gather files stay original.\n")],
  });
  fixtures.push({
    name: "empty.zip",
    type: "application/zip",
    bytes: [
      ...Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
    ],
  });
  for (const p of [page, friend])
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 15000,
    });
  let held;
  await page.route("**/api/uploads/*/content", async (route) => {
    if (!held) {
      held = route;
      return;
    }
    await route.abort("failed");
  });
  for (const [index, fixture] of fixtures.entries()) {
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: fixture.name,
        mimeType: fixture.type,
        buffer: Buffer.from(fixture.bytes),
      });
    await expect(
      page.locator(".pending-files").getByText(fixture.name, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(`Sharing ${fixture.name}`);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    if (index === 0) {
      await expect.poll(() => !!held).toBe(true);
      await held.abort("failed");
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await page.unroute("**/api/uploads/*/content");
      await page
        .getByRole("button", { name: "Retry", exact: true })
        .click({ timeout: 1000 })
        .catch(() => {}); // Reconnect may already have resumed it.
    }
    const attachment = friend
      .locator(".attachment")
      .filter({ hasText: fixture.name });
    await expect(attachment).toBeVisible({ timeout: 15000 });
    await attachment.scrollIntoViewIfNeeded();
    if (fixture.type.startsWith("image/"))
      await expect
        .poll(() =>
          attachment.locator("img").evaluate((img) => img.naturalWidth),
        )
        .toBeGreaterThan(0);
    else if (fixture.type.startsWith("audio/")) {
      await expect
        .poll(() =>
          attachment.locator("audio").evaluate((audio) => audio.readyState),
        )
        .toBeGreaterThan(0);
      assert.equal(
        await attachment.locator("audio").evaluate((audio) => audio.paused),
        true,
      );
      await attachment.locator("audio").evaluate((audio) => audio.play());
      await expect
        .poll(() =>
          attachment.locator("audio").evaluate((audio) => audio.currentTime),
        )
        .toBeGreaterThan(0);
      await attachment.locator("audio").evaluate((audio) => audio.pause());
    } else if (fixture.type === "video/mp4") {
      await expect
        .poll(() =>
          attachment.locator("video").evaluate((video) => video.readyState),
        )
        .toBeGreaterThanOrEqual(2);
      const video = attachment.locator("video");
      assert.equal(await video.evaluate((el) => el.paused), true);
      await video.evaluate((el) => el.play());
      await expect
        .poll(() => video.evaluate((el) => el.currentTime))
        .toBeGreaterThan(0.2);
      await video.evaluate((el) => el.pause());
      const position = await video.evaluate((el) => el.currentTime);
      // Keep the paused video outside the viewport past its resource grace period.
      await friend.locator(".message-scroll").evaluate((el) => {
        const spacer = document.createElement("div");
        spacer.id = "media-scroll-fixture";
        spacer.style.height = "3000px";
        spacer.style.flexShrink = "0";
        el.append(spacer);
        el.scrollTop = el.scrollHeight;
      });
      await expect(video).toHaveCount(0, { timeout: 10000 });
      await attachment.scrollIntoViewIfNeeded();
      await expect
        .poll(() => video.evaluate((el) => el.readyState))
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => video.evaluate((el) => el.currentTime))
        .toBeGreaterThanOrEqual(position - 0.1);
      await video.evaluate((el) => el.play());
      await expect
        .poll(() => video.evaluate((el) => el.currentTime))
        .toBeGreaterThan(position);
      await video.evaluate((el) => el.pause());
      await friend
        .locator("#media-scroll-fixture")
        .evaluate((el) => el.remove());
    }
    const download = friend.waitForEvent("download");
    await attachment
      .getByRole(
        fixture.type.startsWith("text/") ||
          fixture.type.startsWith("application/")
          ? "button"
          : "link",
        { name: `Save ${fixture.name}` },
      )
      .click();
    const saved = await download;
    assert.deepEqual(
      await readFile(await saved.path()),
      Buffer.from(fixture.bytes),
    );
    console.log(`PASS: original ${fixture.type} decoded and saved unchanged.`);
    if (index === 0) {
      await page
        .getByRole("button", { name: "Join voice", exact: true })
        .first()
        .click();
      for (const p of [page, friend])
        await expect(
          p.getByText("Voice connected", { exact: true }),
        ).toBeVisible({ timeout: 15000 });
    }
    await mkdir("test-results", { recursive: true });
    await friend
      .locator(".message-scroll")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    if (fixture.type === "image/gif")
      await friend.screenshot({
        path: "test-results/ux-gif-video-dark.png",
        animations: "disabled",
      });
    if (fixture.type === "application/zip")
      await friend.screenshot({
        path: "test-results/ux-audio-files-dark.png",
        animations: "disabled",
      });
  }
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 15000,
    });
  assert.equal(errors.length, 0, errors.join("\n"));
  await mkdir("test-results", { recursive: true });
  await friend.screenshot({ path: "test-results/media-dark.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const exportPath = join(dir, "sharing-history.json");
  await app.evaluate(({ session }, savePath) => {
    globalThis.mediaExportState = "waiting";
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(savePath);
      item.once(
        "done",
        (_event, state) => (globalThis.mediaExportState = state),
      );
    });
  }, exportPath);
  await page
    .getByRole("button", { name: "Export your chat history", exact: true })
    .click();
  await expect
    .poll(() => app.evaluate(() => globalThis.mediaExportState), {
      timeout: 15000,
    })
    .toBe("completed");
  const archive = JSON.parse(await readFile(exportPath, "utf8"));
  assert.equal(archive.files.length, fixtures.length);
  assert.ok(archive.files.every((f) => f.data));
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const sendText = async (p, text) => {
    await p.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await p.getByRole("button", { name: "Send message", exact: true }).click();
  };
  for (const [p, text] of [
    [page, "Ready for one more game? 🎮"],
    [friend, "Absolutely 😂"],
    [page, "😂"],
    [friend, "🎮🔥🎉"],
    [page, "👍🏽 👨‍👩‍👧‍👦 🇺🇸 1️⃣"],
    [friend, "😂😂😂😂😂😂😂"],
  ])
    await sendText(p, text);
  const reactionMessage = friend
    .locator(".message-row")
    .filter({ hasText: "Ready for one more game?" });
  await reactionMessage.hover();
  await reactionMessage
    .getByRole("button", { name: "React to message", exact: true })
    .click();
  await reactionMessage
    .getByRole("button", { name: "Insert 👍", exact: true })
    .click();
  await expect(
    reactionMessage.getByRole("button", {
      name: "👍 reaction, 1",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  const id = await reactionMessage.getAttribute("data-message-id");
  const response = await fetch(`${base}/api/messages/${id}/reactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${alice.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍", active: true }),
  });
  assert.ok(response.ok);
  await expect(
    reactionMessage.getByRole("button", {
      name: "👍 reaction, 2",
      exact: true,
    }),
  ).toBeVisible();
  await reactionMessage.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await friend
    .locator(".message-scroll")
    .evaluate((el) => (el.scrollTop -= 30));
  await friend.screenshot({
    path: "test-results/ux-emoji-reactions-dark.png",
    animations: "disabled",
  });
  await friend.getByRole("button", { name: "Settings", exact: true }).click();
  await friend.getByLabel("Appearance", { exact: true }).selectOption("light");
  await friend
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await friend.screenshot({
    path: "test-results/ux-emoji-reactions-light.png",
    animations: "disabled",
  });
  await friend.getByRole("button", { name: "Settings", exact: true }).click();
  await friend.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await friend
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await sendText(page, "Old-school lobby vibes :)");
  await sendText(
    friend,
    ":msn-winking-smile: :msn-open-mouthed-smile: :msn-red-heart:",
  );
  const classicMessage = friend
    .locator(".message-row")
    .filter({ hasText: "Old-school lobby vibes" });
  await classicMessage.hover();
  await classicMessage
    .getByRole("button", { name: "React to message", exact: true })
    .click();
  await friend.getByRole("tab", { name: "Classic MSN", exact: true }).click();
  await friend
    .getByRole("button", { name: "Insert Thumbs up", exact: true })
    .click();
  await expect(
    classicMessage.getByRole("button", {
      name: ":msn-thumbs-up: reaction, 1",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    friend.locator(".message-bubble.emoji-message .msn-art"),
  ).toHaveCount(3);
  await friend.getByRole("button", { name: "Add emoji", exact: true }).click();
  await friend.getByRole("tab", { name: "Classic MSN", exact: true }).click();
  await expect(
    friend
      .getByRole("tabpanel", { name: "Classic MSN emoticons" })
      .getByRole("button"),
  ).toHaveCount(81);
  await friend.screenshot({
    path: "test-results/ux-classic-msn-dark.png",
    animations: "disabled",
  });
  await friend.getByRole("button", { name: "Add emoji", exact: true }).click();
  await classicMessage.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await friend.screenshot({
    path: "test-results/ux-classic-msn-chat-dark.png",
    animations: "disabled",
  });
  await writeFile(
    "test-results/media-summary.json",
    JSON.stringify(
      {
        formats: fixtures.map((f) => f.type),
        interruptedUploadRetriedOnce: true,
        originalDownloadsVerified: true,
        portableArchiveFiles: archive.files.length,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Electron → Edge PNG/JPEG/WebP/GIF/H.264 MP4, interrupted upload/reload/retry, original downloads, archive originals, and voice after sharing.",
  );
} catch (error) {
  if (friend) {
    const diagnostic = await friend
      .locator(".message-row")
      .evaluateAll((rows) =>
        rows.slice(-12).map((row) => {
          const button = row.querySelector(".reaction-add"),
            b = button?.getBoundingClientRect(),
            hit = b
              ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
              : null;
          return {
            text: row.textContent.slice(0, 100),
            row: row.getBoundingClientRect().toJSON(),
            button: b?.toJSON(),
            hit: hit?.outerHTML.slice(0, 200),
            hover: row.matches(":hover"),
            css: button
              ? {
                  pointer: getComputedStyle(button).pointerEvents,
                  opacity: getComputedStyle(button).opacity,
                }
              : null,
          };
        }),
      )
      .catch(() => []);
    console.log("Toolbar diagnostic", JSON.stringify(diagnostic));
    await friend
      .screenshot({ path: "test-results/media-failure.png", timeout: 5000 })
      .catch(() => {});
  }
  throw error;
} finally {
  await app?.close();
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
