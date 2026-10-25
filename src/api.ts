import type { Session } from "./types";
import { validateSession } from "../server/session-contract.mjs";

export const DEFAULT_SERVER = "http://127.0.0.1:4318";
export function normalizeServer(value: string) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("Use a server address such as https://gather.example.com");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "Shared servers need an HTTPS address to keep your messages and sign-in private.",
    );
  return url.origin;
}
export function parseInvite(value: string): { code: string; server?: string } {
  const input = value.trim();
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/join\/([a-zA-Z0-9_-]+)\/?$/);
    if (!match) throw new Error();
    return { code: match[1], server: normalizeServer(url.origin) };
  } catch {
    if (/^[a-zA-Z0-9_-]{16,64}$/.test(input)) return { code: input };
    throw new Error("Paste a complete Gather invite link or invite code.");
  }
}
export async function request<T>(
  server: string,
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${server}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(12_000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw Object.assign(
      new Error(
        "Can’t reach your server. Check the address and your connection, then try again.",
      ),
      { kind: "network" },
    );
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object")
    throw new Error(
      "The server returned an invalid response. Check the server address and try again.",
    );
  if (!response.ok) {
    if (response.status === 401 && token)
      window.dispatchEvent(
        new CustomEvent("gather:session-expired", { detail: { token } }),
      );
    throw Object.assign(
      new Error(
        payload.error ||
          `Something went wrong (${response.status}). Please try again.`,
      ),
      { status: response.status },
    );
  }
  return payload as T;
}
export function api<T>(session: Session, path: string, options?: RequestInit) {
  return request<T>(session.server, path, options, session.token);
}
export async function saveSession(
  session: Session | null,
  expectedToken: string | null,
) {
  const value = validateSession(session);
  if (window.desktop?.writeSession) {
    await window.desktop.writeSession(value, expectedToken);
    localStorage.removeItem("gather.session");
    return;
  }
  if (
    (readSession()?.token ?? null) !== expectedToken &&
    !(value === null && readSession() === null)
  )
    throw new Error("Your profile changed. Reopen Gather and try again.");
  if (value) localStorage.setItem("gather.session", JSON.stringify(value));
  else localStorage.removeItem("gather.session");
}
let openingSession: Promise<Session | null> | undefined;
export function loadSession(): Promise<Session | null> {
  if (!openingSession)
    openingSession = (async () => {
      if (!window.desktop?.readSession) {
        try {
          const raw = localStorage.getItem("gather.session");
          return raw === null ? null : validateSession(JSON.parse(raw));
        } catch {
          throw new Error(
            "Your saved profile could not be opened and has been kept. Retry, or use your recovery code in another browser profile.",
          );
        }
      }
      const saved = await window.desktop.readSession();
      if (saved.initialized) {
        const value = validateSession(saved.session);
        localStorage.removeItem("gather.session");
        return value;
      }
      const legacy = localStorage.getItem("gather.session");
      if (!legacy) return null;
      let value;
      try {
        value = validateSession(JSON.parse(legacy));
      } catch {
        throw new Error(
          "Your saved profile could not be migrated. Restore it with your recovery code.",
        );
      }
      await saveSession(value, null);
      return value;
    })().finally(() => {
      openingSession = undefined;
    });
  return openingSession;
}
export function readSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem("gather.session") || "null");
    return s &&
      typeof s.token === "string" &&
      s.token.length > 0 &&
      typeof s.user?.id === "string" &&
      s.user.id.length > 0 &&
      typeof s.user?.name === "string" &&
      s.user.name.trim().length > 0
      ? { ...s, server: normalizeServer(s.server) }
      : null;
  } catch {
    return null;
  }
}
