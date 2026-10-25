import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { gifUrl } from "../server/gif-policy.mjs";
import { normalizeGifs } from "../server/gifs.mjs";

const payload = {
  result: true,
  data: {
    has_next: true,
    data: [
      {
        id: 7,
        title: "yes",
        file: {
          md: {
            gif: {
              url: "https://static.klipy.com/a/md.gif",
              width: 300,
              height: 200,
            },
          },
          sm: {
            gif: {
              url: "https://static.klipy.com/a/sm.gif",
              width: 100,
              height: 70,
            },
          },
        },
      },
      { id: 8, file: { md: { gif: { url: "https://evil.example/x.gif" } } } },
      { id: 9 },
    ],
  },
};
test("GIF urls are limited to https Klipy hosts", () => {
  assert.equal(
    gifUrl("https://static.klipy.com/a.gif"),
    "https://static.klipy.com/a.gif",
  );
  for (const bad of [
    "http://static.klipy.com/a.gif",
    "https://klipy.com.evil.example/a.gif",
    "https://u:p@static.klipy.com/a.gif",
    "https://static.klipy.com/a.gif extra words",
    "hello",
    "",
    42,
  ])
    assert.equal(gifUrl(bad), null);
});
test("provider results are normalized and foreign hosts dropped", () => {
  const out = normalizeGifs(payload);
  assert.equal(out.hasNext, true);
  assert.deepEqual(out.results, [
    {
      id: "7",
      title: "yes",
      url: "https://static.klipy.com/a/md.gif",
      preview: "https://static.klipy.com/a/sm.gif",
      width: 100,
      height: 70,
    },
  ]);
  assert.deepEqual(normalizeGifs(null), { results: [], hasNext: false });
});
async function setup(t, env, fetcher) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const domain = createDomain(db, env, {}, { fetch: fetcher });
  const { token } = await domain.handle("POST", "/api/sessions", { name: "A" });
  return { domain, token };
}
test("GIF search is authenticated, keeps the key server-side, and is rate limited", async (t) => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return Response.json(payload);
  };
  const { domain, token } = await setup(
    t,
    { KLIPY_API_KEY: "secret-key" },
    fetcher,
  );
  assert.ok(
    (
      await domain.handle("GET", "/api/bootstrap", {}, token)
    ).capabilities.includes("gif-search-v1"),
  );
  await assert.rejects(
    domain.handle(
      "GET",
      "/api/gifs/search",
      {},
      "nope",
      new URLSearchParams("q=hi"),
    ),
    { status: 401 },
  );
  const found = await domain.handle(
    "GET",
    "/api/gifs/search",
    {},
    token,
    new URLSearchParams("q=cats"),
  );
  assert.equal(found.results.length, 1);
  assert.ok(JSON.stringify(found).indexOf("secret-key") < 0);
  assert.match(
    calls[0],
    /\/secret-key\/gifs\/search\?(?=.*q=cats)(?=.*rating=pg-13)/,
  );
  await domain.handle("GET", "/api/gifs/trending", {}, token);
  assert.match(calls[1], /\/gifs\/trending/);
  assert.deepEqual(
    await domain.handle(
      "GET",
      "/api/gifs/search",
      {},
      token,
      new URLSearchParams("q="),
    ),
    { results: [], hasNext: false },
  );
  for (let i = 0; i < 40; i++)
    await domain.handle("GET", "/api/gifs/trending", {}, token).catch(() => {});
  await assert.rejects(domain.handle("GET", "/api/gifs/trending", {}, token), {
    status: 429,
  });
});
test("without a key GIF search is not advertised and answers 503", async (t) => {
  const { domain, token } = await setup(t, {}, async () =>
    assert.fail("no fetch"),
  );
  assert.ok(
    !(
      await domain.handle("GET", "/api/bootstrap", {}, token)
    ).capabilities.includes("gif-search-v1"),
  );
  await assert.rejects(domain.handle("GET", "/api/gifs/trending", {}, token), {
    status: 503,
  });
});
