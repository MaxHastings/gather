import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8",
);
function fixture() {
  const origin = "https://gather.example",
    entries = new Map(),
    handlers = {};
  let version = 1,
    assetFailure = false,
    quotaFailure = false,
    hostFailure = false;
  const path = (input) =>
    new URL(typeof input === "string" ? input : input.url, origin).pathname;
  const cache = {
    match: async (input) => entries.get(path(input))?.clone(),
    put: async (input, response) => {
      if (quotaFailure && path(input) === "/")
        throw new Error("Injected cache quota failure");
      entries.set(path(input), response.clone());
    },
    keys: async () =>
      [...entries.keys()].map((value) => new Request(origin + value)),
    delete: async (input) => entries.delete(path(input)),
  };
  const context = vm.createContext({
    Response,
    Request,
    Headers,
    URL,
    TextEncoder,
    AbortSignal,
    caches: { open: async () => cache },
    self: {
      location: { origin },
      navigator: { locks: { request: async (_name, action) => action() } },
      clients: { claim: async () => {} },
      addEventListener: (name, action) => {
        handlers[name] = action;
      },
    },
    fetch: async (input) => {
      const pathname = path(input);
      if (pathname === "/")
        return new Response(
          `<script src="/assets/main-v${version}.js"></script>`,
          {
            status: hostFailure ? 503 : 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      if (pathname === "/asset-manifest.json")
        return Response.json({
          app: {
            file: `assets/main-v${version}.js`,
            css: [`assets/main-v${version}.css`],
          },
        });
      if (assetFailure && pathname.endsWith(".js"))
        return new Response("Unavailable", { status: 503 });
      return new Response(`version ${version}`, {
        headers: {
          "Content-Type": pathname.endsWith(".css")
            ? "text/css"
            : "application/javascript",
          Vary: "Origin",
        },
      });
    },
  });
  vm.runInContext(source, context);
  return {
    entries,
    handlers,
    save: () => context.saveShell(),
    set: (options) => {
      if (options.version !== undefined) version = options.version;
      if (options.assetFailure !== undefined)
        assetFailure = options.assetFailure;
      if (options.quotaFailure !== undefined)
        quotaFailure = options.quotaFailure;
      if (options.hostFailure !== undefined) hostFailure = options.hostFailure;
    },
  };
}
test("offline shell updates preserve a complete previous shell after missing assets or quota failure and bound old versions", async () => {
  const state = fixture();
  await state.save();
  const original = await state.entries.get("/").clone().text();
  state.set({ version: 2, assetFailure: true });
  await assert.rejects(state.save(), /asset unavailable/);
  assert.equal(await state.entries.get("/").clone().text(), original);
  state.set({ assetFailure: false, quotaFailure: true });
  await assert.rejects(state.save(), /quota/);
  assert.equal(await state.entries.get("/").clone().text(), original);
  assert.equal(
    [...state.entries.keys()].some((path) => path.includes("v2")),
    false,
  );
  state.set({ quotaFailure: false });
  await state.save();
  state.set({ version: 3 });
  await state.save();
  assert.equal(
    [...state.entries.keys()].some((path) => path.includes("v1")),
    false,
  );
  assert.equal(state.entries.has("/assets/main-v2.js"), true);
  assert.equal(state.entries.has("/assets/main-v3.js"), true);
  assert.equal(state.entries.size, 6);
});
test("shell caching bypasses private/API/download traffic and serves the last complete shell during host failure", async () => {
  const state = fixture();
  await state.save();
  for (const pathname of [
    "/api/bootstrap",
    "/api/media/private",
    "/realtime",
    "/download/windows",
  ]) {
    let intercepted = false;
    state.handlers.fetch({
      request: {
        url: "https://gather.example" + pathname,
        method: "GET",
        headers: new Headers(),
        mode: "navigate",
      },
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
  }
  state.set({ hostFailure: true });
  let response;
  state.handlers.fetch({
    request: {
      url: "https://gather.example/",
      method: "GET",
      headers: new Headers(),
      mode: "navigate",
    },
    respondWith: (value) => {
      response = value;
    },
    waitUntil: () => {},
  });
  assert.equal((await response).status, 200);
  assert.match(await (await response).text(), /main-v1/);
});
