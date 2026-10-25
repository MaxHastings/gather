import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseArchive } from "../server/archive-format.mjs";

function fixture() {
  const user = { id: randomUUID(), name: "Alice" };
  const group = {
    id: randomUUID(),
    name: "Friday friends",
    createdAt: 1234,
    members: [user],
    inviteCode: "private-invite-do-not-export",
  };
  return {
    format: "gather-export-v1",
    exportedAt: new Date().toISOString(),
    user,
    groups: [
      {
        ...group,
        messages: [
          {
            id: randomUUID(),
            clientId: randomUUID(),
            sequence: 1,
            groupId: group.id,
            userId: user.id,
            name: user.name,
            body: "An ordinary saved conversation",
            createdAt: 1234,
          },
        ],
      },
    ],
  };
}
test("archives preserve readable history while excluding credentials and invitation capabilities", () => {
  const input = fixture();
  input.token = "secret-session-fixture";
  input.user.recoveryCode = "secret-recovery-fixture";
  input.groups[0].messages[0].token = "secret-message-fixture";
  const archive = parseArchive(input);
  const serialized = JSON.stringify(archive);
  assert.equal(archive.format, "gather-archive-v1");
  assert.equal(
    archive.groups[0].messages[0].body,
    input.groups[0].messages[0].body,
  );
  for (const secret of [
    input.token,
    input.user.recoveryCode,
    input.groups[0].inviteCode,
    input.groups[0].messages[0].token,
  ])
    assert.equal(serialized.includes(secret), false);
  assert.deepEqual(parseArchive(JSON.parse(serialized)), archive);
});
test("malformed identities, impossible dates, duplicate ordering and future media fail before import", () => {
  const changes = [
    (a) => {
      a.user.id = [a.user.id];
    },
    (a) => {
      a.groups[0].id = [a.groups[0].id];
    },
    (a) => {
      a.groups[0].createdAt = Number.MAX_SAFE_INTEGER;
    },
    (a) => {
      a.groups[0].messages[0].createdAt = Number.MAX_SAFE_INTEGER;
    },
    (a) => {
      a.groups[0].messages[0].sequence = Number.MAX_SAFE_INTEGER;
    },
    (a) => {
      a.groups[0].messages[0].status = "sending";
    },
    (a) => {
      a.groups[0].messages[0].name = "";
    },
    (a) => {
      a.groups[0].messages.push({
        ...a.groups[0].messages[0],
        id: randomUUID(),
        clientId: randomUUID(),
      });
    },
    (a) => {
      a.features = ["text", "unknown-required-feature"];
    },
    (a) => {
      a.groups[0].messages[0].attachments = [{ filename: "lost.mp4" }];
    },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => parseArchive(input));
  }
});
