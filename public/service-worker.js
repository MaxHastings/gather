// Only the public application shell belongs here. Chat, credentials, media and
// download responses must never enter the shell cache.
const CACHE = "gather-shell-v1";
const MAX_SHELL_BYTES = 16 * 1024 * 1024;
const staticPath = (path) =>
  /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?|png|ico|svg)$/.test(path);
let saving;
async function saveShell(documentResponse) {
  if (saving) return saving;
  if (!self.navigator.locks)
    throw new Error("Offline shell locking is unavailable.");
  saving = self.navigator.locks
    .request("gather-shell-update", async () => {
      const html = documentResponse
        ? documentResponse.clone()
        : await fetch("/", {
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          });
      if (!html.ok || !html.headers.get("Content-Type")?.includes("text/html"))
        throw new Error("Invalid application shell.");
      if (html.url && new URL(html.url).origin !== self.location.origin)
        throw new Error("Application shell must have the same origin.");
      const text = await html.clone().text();
      if (text.length > 262144)
        throw new Error("Application shell is too large.");
      const manifestResponse = await fetch("/asset-manifest.json", {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!manifestResponse.ok)
        throw new Error("Application manifest unavailable.");
      const manifest = await manifestResponse.json();
      const paths = [
        ...new Set(
          Object.values(manifest)
            .flatMap((entry) => [
              entry.file,
              ...(entry.css || []),
              ...(entry.assets || []),
            ])
            .filter((path) => typeof path === "string")
            .map((path) => "/" + path),
        ),
      ];
      if (
        !paths.length ||
        paths.length > 96 ||
        paths.some((path) => !staticPath(path))
      )
        throw new Error("Invalid application manifest.");
      const referenced = [
        ...text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g),
      ].map((match) => match[1]);
      if (referenced.some((path) => !paths.includes(path)))
        throw new Error("Application changed during shell update.");
      const cache = await caches.open(CACHE);
      const previousResponse = await cache.match("/");
      const previous = JSON.parse(
        previousResponse?.headers.get("X-Gather-Shell-Files") || "[]",
      );
      const oldKeep = new Set(["/", "/theme.js", ...previous.flat()]);
      const prune = async (keep) => {
        for (const request of await cache.keys())
          if (!keep.has(new URL(request.url).pathname))
            await cache.delete(request);
      };
      await prune(oldKeep);
      let bytes = new TextEncoder().encode(text).byteLength;
      const prepared = [];
      for (const path of [...paths, "/theme.js"]) {
        const response = await fetch(path, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Application asset unavailable.");
        const data = await response.arrayBuffer();
        bytes += data.byteLength;
        if (data.byteLength > 4 * 1024 * 1024 || bytes > MAX_SHELL_BYTES)
          throw new Error("Application exceeds offline shell budget.");
        const headers = new Headers(response.headers);
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
        prepared.push([path, new Response(data, { headers })]);
      }
      const versions = [
        paths,
        ...previous.filter(
          (version) => JSON.stringify(version) !== JSON.stringify(paths),
        ),
      ].slice(0, 2);
      const headers = new Headers(html.headers);
      headers.delete("Content-Encoding");
      headers.delete("Content-Length");
      headers.set("X-Gather-Shell-Files", JSON.stringify(versions));
      let committed = false;
      try {
        for (const [path, response] of prepared)
          await cache.put(path, response);
        // HTML and its file manifest commit together as one cache entry. A failed
        // update cannot make the last complete shell point at uncommitted assets.
        await cache.put("/", new Response(text, { headers }));
        committed = true;
        await prune(new Set(["/", "/theme.js", ...versions.flat()]));
      } catch (error) {
        if (!committed) await prune(oldKeep).catch(() => {});
        throw error;
      }
    })
    .finally(() => {
      saving = undefined;
    });
  return saving;
}
self.addEventListener("install", (event) => {
  event.waitUntil(saveShell());
});
self.addEventListener("activate", (event) => {
  // Updates wait for existing clients naturally; never force a call reload.
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    request.headers.has("Authorization")
  )
    return;
  if (
    request.mode === "navigate" &&
    (url.pathname === "/" || /^\/join\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
  ) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          if (response.status >= 500)
            throw new Error("Application host unavailable.");
          if (response.ok)
            event.waitUntil(saveShell(response.clone()).catch(() => {}));
          return response;
        } catch {
          return (
            (await (await caches.open(CACHE)).match("/")) ||
            new Response(
              "Gather has not finished saving for offline use. Reconnect once to open it.",
              {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              },
            )
          );
        }
      })(),
    );
  } else if (staticPath(url.pathname) && !url.search) {
    event.respondWith(
      (async () => {
        // These are public same-origin immutable build assets. CORS middleware
        // can add Vary: Origin even though its value does not change their bytes.
        const cached = await (
          await caches.open(CACHE)
        ).match(request, { ignoreVary: true });
        return cached || fetch(request);
      })(),
    );
  } else if (url.pathname === "/theme.js" && !url.search) {
    event.respondWith(
      fetch(request).catch(
        async () =>
          (await (await caches.open(CACHE)).match("/theme.js")) ||
          Response.error(),
      ),
    );
  }
});
