import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { notificationCandidate } from "../server/notification-policy.mjs";
const { createNotifications } = createRequire(import.meta.url)(
  "../electron/notifications.cjs",
);
const groupId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const input = {
  message: {
    id: messageId,
    groupId,
    userId: "friend",
    name: "Jamie",
    body: "One more?",
    createdAt: 10_000,
  },
  changeKind: "create",
  userId: "me",
  group: { id: groupId, name: "The crew" },
  selected: "another-chat",
  focused: true,
  preferences: { enabled: true, preview: true, muted: [] },
  now: 10_001,
};

test("only timely new messages alert, respecting focus, privacy and per-chat preferences", () => {
  assert.equal(notificationCandidate(input).body, "One more?");
  for (const changeKind of [undefined, "reaction", "edit", "delete"])
    assert.equal(notificationCandidate({ ...input, changeKind }), null);
  assert.equal(
    notificationCandidate({
      ...input,
      message: { ...input.message, userId: "me" },
    }),
    null,
  );
  assert.equal(notificationCandidate({ ...input, selected: groupId }), null);
  assert.ok(
    notificationCandidate({ ...input, selected: groupId, focused: false }),
  );
  assert.equal(notificationCandidate({ ...input, group: undefined }), null);
  assert.equal(notificationCandidate({ ...input, now: 200_000 }), null);
  assert.equal(notificationCandidate({ ...input, now: -100_000 }), null);
  assert.equal(
    notificationCandidate({
      ...input,
      preferences: { ...input.preferences, enabled: false },
    }),
    null,
  );
  assert.equal(
    notificationCandidate({
      ...input,
      preferences: { ...input.preferences, muted: [groupId] },
    }),
    null,
  );
  assert.deepEqual(
    notificationCandidate({
      ...input,
      preferences: { ...input.preferences, preview: false },
    }),
    { groupId, messageId, title: "Gather", body: "New message" },
  );
  assert.equal(
    notificationCandidate({
      ...input,
      message: {
        ...input.message,
        body: "",
        attachments: [{ name: "song.mp3" }],
      },
    }).body,
    "song.mp3",
  );
});

test("native notifications replace per chat, contain OS failures and ignore late callbacks after clear or window destruction", () => {
  const notes = [],
    events = [];
  class FakeNotification extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(options) {
      super();
      this.options = options;
      notes.push(this);
    }
    show() {}
    close() {
      this.closed = true;
      this.emit("close");
    }
  }
  let live = true;
  const manager = createNotifications(FakeNotification, {
    withWindow(action) {
      if (!live) return false;
      action(
        {
          isMinimized: () => true,
          restore() {
            events.push("restore");
          },
          show() {},
          focus() {},
        },
        { send: (...args) => events.push(args) },
      );
      return true;
    },
  });
  const value = { ...notificationCandidate(input), scope: "profile" };
  assert.throws(
    () => manager.show({ ...value, groupId: "../../evil" }),
    /Invalid/,
  );
  assert.equal(manager.show(value), true);
  manager.show(value);
  assert.equal(notes[0].closed, true);
  notes[0].emit("click");
  assert.equal(events.length, 0);
  notes[1].emit("click");
  assert.deepEqual(events, [
    "restore",
    ["notifications:open", { scope: "profile", groupId }],
  ]);
  manager.show(value);
  manager.clear("profile");
  notes[2].emit("click");
  assert.equal(events.length, 2);
  manager.show(value);
  live = false;
  assert.doesNotThrow(() => notes[3].emit("click"));
  manager.show(value);
  assert.doesNotThrow(() => notes[4].emit("failed", "OS refused"));
  manager.dispose();
  class Unsupported extends FakeNotification {
    static isSupported() {
      return false;
    }
  }
  assert.equal(createNotifications(Unsupported, {}).show(value), false);
  class Broken extends FakeNotification {
    show() {
      throw new Error("OS unavailable");
    }
  }
  assert.equal(createNotifications(Broken, {}).show(value), false);
});
