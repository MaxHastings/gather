// Operator moderation helper. Reads GATHER_ADMIN_TOKEN (and optionally
// PUBLIC_URL) from .env. See OPERATIONS.md, "Reports and moderation".
//
//   node scripts/moderate.mjs reports [open|actioned|dismissed|all]
//   node scripts/moderate.mjs remove-message <messageId>
//   node scripts/moderate.mjs remove-file <uploadId>
//   node scripts/moderate.mjs remove-group <groupId>
//   node scripts/moderate.mjs ban <userId> [--purge] [--block-ip] [reason...]
//   node scripts/moderate.mjs unban <userId>
//   node scripts/moderate.mjs resolve <reportId> <actioned|dismissed>
//   node scripts/moderate.mjs limits [key=value ...]   e.g. signupsPerDay=0 relay=false
import { config } from "dotenv";

config({ quiet: true });
const server = new URL(
  process.env.PUBLIC_URL ||
    "https://gather-friends.max-jacob-hastings.workers.dev",
);
if (!process.env.GATHER_ADMIN_TOKEN)
  throw new Error("Set GATHER_ADMIN_TOKEN in .env first.");
const call = async (method, path, body) => {
  const response = await fetch(new URL(path, server), {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GATHER_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Failed (${response.status})`);
  return data;
};
const [command, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const rest = args.filter((a) => !a.startsWith("--"));
const show = (value) => console.log(JSON.stringify(value, null, 2));
const when = (t) => new Date(t).toISOString();

if (command === "reports") {
  const { reports } = await call(
    "GET",
    `/api/admin/reports?status=${rest[0] ?? "open"}`,
  );
  if (!reports.length) console.log("No reports.");
  for (const r of reports) {
    console.log(`\nReport ${r.id}  [${r.status}]  ${when(r.createdAt)}`);
    console.log(`  reason: ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log(
      `  chat: "${r.groupName}" (${r.groupId})  reporter: ${r.reporterName}`,
    );
    if (r.messageId)
      console.log(
        `  message ${r.messageId} by ${r.targetName} (${r.targetUserId})${r.banned ? " [BANNED]" : ""}`,
      );
    if (r.contact) console.log(`  contact: ${r.contact}`);
    if (r.excerpt) console.log(`  excerpt: ${r.excerpt}`);
    if (r.uploadId) console.log(`  file: ${r.uploadId}`);
    for (const a of r.targetActivity)
      console.log(`  sender ${a.kind}: ${a.ip} at ${when(a.createdAt)}`);
  }
} else if (command === "remove-message")
  show(await call("POST", "/api/admin/remove-message", { messageId: rest[0] }));
else if (command === "remove-file")
  show(await call("POST", "/api/admin/remove-file", { uploadId: rest[0] }));
else if (command === "remove-group")
  show(await call("POST", "/api/admin/remove-group", { groupId: rest[0] }));
else if (command === "ban")
  show(
    await call("POST", "/api/admin/ban", {
      userId: rest[0],
      purge: flags.has("--purge"),
      blockIp: flags.has("--block-ip"),
      reason: rest.slice(1).join(" "),
    }),
  );
else if (command === "unban")
  show(await call("POST", "/api/admin/unban", { userId: rest[0] }));
else if (command === "resolve")
  show(
    await call("POST", "/api/admin/reports/resolve", {
      id: rest[0],
      status: rest[1],
    }),
  );
else if (command === "limits") {
  const changes = {};
  for (const pair of rest) {
    const [key, value] = pair.split("=");
    changes[key] =
      value === "true" ? true : value === "false" ? false : Number(value);
  }
  show(
    Object.keys(changes).length
      ? await call("POST", "/api/admin/limits", changes)
      : await call("GET", "/api/admin/limits"),
  );
} else {
  console.log(
    "Commands: reports, remove-message, remove-file, remove-group, ban, unban, resolve, limits (see the top of this file).",
  );
  process.exitCode = 1;
}
