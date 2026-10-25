// A persistent, loopback-only playground; it never loads production credentials.
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
const server = createGatherServer({ dataDir: ".gather-test-preview", env: {} });
const base = "http://127.0.0.1:18788";
await server.listen(18788, "127.0.0.1");
let group = server.db.prepare("SELECT * FROM groups ORDER BY createdAt LIMIT 1").get();
if (!group) {
  const friend = await server.domain.handle("POST", "/api/sessions", { name: "Jamie" });
  group = (await server.domain.handle("GET", "/api/bootstrap", {}, friend.token)).groups[0];
  const send = body => server.domain.handle("POST", `/api/groups/${group.id}/messages`, { clientId: randomUUID(), body }, friend.token);
  const first = await send("one more game?");
  await send("😀");
  await send("😂 👍 🎉");
  await send("that went well 😂");
  await send(":msn-smile: :msn-thumbs-up:");
  const data = await readFile("tests/fixtures/one-more-game.gif");
  const attachment = { id: randomUUID(), name: "one-more-game.gif", type: "image/gif", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  await server.domain.handle("POST", `/api/groups/${group.id}/uploads`, attachment, friend.token);
  const response = await server.domain.mediaRequest(new Request(`${base}/api/uploads/${attachment.id}/content`, { method: "PUT", headers: { Authorization: `Bearer ${friend.token}` }, body: data }));
  if (!response.ok) throw new Error(`Preview fixture upload failed (${response.status}).`);
  await server.domain.handle("POST", `/api/groups/${group.id}/messages`, { clientId: randomUUID(), body: "us at 2am", attachmentIds: [attachment.id] }, friend.token);
  await server.domain.handle("POST", `/api/messages/${first.id}/reactions`, { emoji: "👍", active: true }, friend.token);
  await server.domain.handle("POST", `/api/messages/${first.id}/reactions`, { emoji: ":msn-thumbs-up:", active: true }, friend.token);
}
console.log(`Gather feature preview: ${base}/join/${group.inviteCode}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void server.close().then(() => process.exit(0)));
