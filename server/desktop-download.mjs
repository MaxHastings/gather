import { readDownloadManifest } from "./desktop-releases.mjs";

// Static files stay below the hosting limit. Stream the unchanged executable
// as one normal download without buffering the whole file in Worker memory.
export async function desktopDownload(
  request,
  assets,
  expectedFilename,
  id = "windows-x64",
) {
  const base = new URL(request.url);
  const directory = id === "windows-x64" ? "/downloads" : `/downloads/${id}`;
  const manifestResponse = await assets.fetch(
    new URL(`${directory}/manifest.json`, base),
  );
  if (!manifestResponse.ok)
    return new Response("This desktop download is not available yet.", {
      status: 503,
    });
  let manifest;
  try {
    manifest = readDownloadManifest(await manifestResponse.json(), id);
  } catch {
    return new Response(
      "This desktop download is unavailable. Please try again later.",
      { status: 503 },
    );
  }
  if (expectedFilename && manifest.filename !== expectedFilename)
    return new Response("This release is no longer available.", {
      status: 404,
    });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${manifest.filename}"`,
    "Content-Length": String(manifest.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Checksum-SHA256": manifest.sha256,
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405 });
  let index = 0,
    partBytes = 0,
    reader;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            if (index === manifest.parts.length) {
              controller.close();
              return;
            }
            const part = manifest.parts[index++];
            const response = await assets.fetch(
              new URL(`${directory}/${part.name}`, base),
            );
            if (!response.ok || !response.body)
              throw new Error("Download part unavailable");
            reader = response.body.getReader();
            partBytes = 0;
          }
          const result = await reader.read();
          if (result.done) {
            if (partBytes !== manifest.parts[index - 1].size)
              throw new Error("Download part is incomplete");
            reader.releaseLock();
            reader = undefined;
            continue;
          }
          partBytes += result.value.byteLength;
          if (partBytes > manifest.parts[index - 1].size)
            throw new Error("Download part exceeds its size");
          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        await reader?.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel() {
      await reader?.cancel();
    },
  });
  return new Response(stream, { headers });
}
