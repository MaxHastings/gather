// Shared by the server and the client: which hosts may serve a GIF that a
// message embeds. Keep in sync with img-src in index.html.
const GIF_HOSTS = ["klipy.com"];
export function gifUrl(value) {
  if (typeof value !== "string" || value.length > 600) return null;
  const text = value.trim();
  if (/\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !GIF_HOSTS.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
