import { createGatherServer } from "./app.mjs";

const server = createGatherServer();
const address = await server.listen();
console.log(
  `Gather server listening on http://${address.address}:${address.port}`,
);
console.log(
  "Audio relay:",
  process.env.TURN_KEY_ID || process.env.TURN_SHARED_SECRET
    ? "configured"
    : "direct connections only; configure TURN before internet use",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
