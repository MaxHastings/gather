import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { historyContract } from "./history-contract.mjs";
const source = stripTypeScriptTypes(
  await readFile(new URL("../src/history.ts", import.meta.url), "utf8"),
);
const sources = new Map([["/src/history.js", source]]);
for (const filename of [
  "history-contract.mjs",
  "history-message.mjs",
  "archive-format.mjs",
])
  sources.set(
    `/server/${filename}`,
    await readFile(new URL(`../server/${filename}`, import.meta.url), "utf8"),
  );
const server = createServer((request, response) => {
  if (sources.has(request.url)) {
    response.setHeader("Content-Type", "application/javascript");
    response.end(sources.get(request.url));
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Isolated history contract</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const load = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      window.testHistory = (await import("/src/history.js")).history;
    });
  };
  await load();
  // Install a real version-one IndexedDB fixture before the repository opens
  // it. The upgrade must add archives without deleting existing user data.
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("gather-history", 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        const groups = db.createObjectStore("groups", { keyPath: "key" });
        groups.createIndex("scope", "scope");
        const messages = db.createObjectStore("messages", { keyPath: "key" });
        messages.createIndex("group", ["scope", "groupId", "sequence"]);
        messages.createIndex("scopeSequence", ["scope", "sequence"]);
        messages.createIndex("client", ["scope", "userId", "clientId"], {
          unique: true,
        });
        const outbox = db.createObjectStore("outbox", { keyPath: "key" });
        outbox.createIndex("scope", "scope");
        const cursors = db.createObjectStore("cursors", { keyPath: "key" });
        cursors.createIndex("scope", "scope");
        groups.put({
          key: JSON.stringify(["version-one", "original"]),
          scope: "version-one",
          value: { name: "Original cached conversation" },
        });
        outbox.put({
          key: JSON.stringify(["version-one", "original"]),
          scope: "version-one",
          value: { body: "Original queued message" },
        });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
    });
    const state = await window.testHistory({
      operation: "state",
      scope: "version-one",
    });
    if (
      state.groups[0]?.name !== "Original cached conversation" ||
      state.outbox[0]?.body !== "Original queued message"
    )
      throw new Error("Version-one history was lost during upgrade");
  });
  await historyContract(
    (command) => page.evaluate((value) => window.testHistory(value), command),
    load,
  );
  await page.evaluate(async () => {
    const scope = "cleanup-quota",
      groupId = crypto.randomUUID(),
      message = {
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        groupId,
        userId: crypto.randomUUID(),
        name: "Friend",
        sequence: 1,
        revision: 1,
        createdAt: Date.now(),
        body: "preserved",
        attachments: [
          {
            id: crypto.randomUUID(),
            name: "original.txt",
            type: "application/octet-stream",
            bytes: 1,
            sha256: "a".repeat(64),
          },
        ],
      };
    await window.testHistory({
      operation: "apply",
      scope,
      groupId,
      messages: [message],
      cursor: 1,
      changeCursor: 1,
    });
    const put = IDBObjectStore.prototype.put;
    let failed = false;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "mediaCleanup")
        throw new DOMException("Injected journal quota", "QuotaExceededError");
      return put.apply(this, args);
    };
    const deleted = {
      ...message,
      body: "",
      attachments: undefined,
      deletedAt: Date.now(),
      revision: 2,
    };
    try {
      await window.testHistory({
        operation: "apply",
        scope,
        groupId,
        messages: [deleted],
        changeCursor: 2,
      });
    } catch {
      failed = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    if (!failed) throw new Error("Deletion journal fault did not fail");
    if (
      (await window.testHistory({ operation: "page", scope, groupId }))
        .messages[0].body !== "preserved"
    )
      throw new Error("Deletion escaped failed journal transaction");
    if (
      (await window.testHistory({ operation: "state", scope })).changeCursors[
        groupId
      ] !== 1
    )
      throw new Error("Cursor escaped failed journal transaction");
    if ((await window.testHistory({ operation: "mediaCleanup", scope })).length)
      throw new Error("Partial journal survived rollback");
    await window.testHistory({
      operation: "apply",
      scope,
      groupId,
      messages: [deleted],
      changeCursor: 2,
    });
    if (
      (await window.testHistory({ operation: "mediaCleanup", scope }))[0]
        .attachmentIds[0] !== message.attachments[0].id
    )
      throw new Error("Retry lost attachment cleanup");
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: real Edge IndexedDB history passes the desktop contract, including restart, rollback, scope isolation and pagination.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
