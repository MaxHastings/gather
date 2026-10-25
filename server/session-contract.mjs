// Shared validation only; credentials never enter history, archives or logs.
export function validateSession(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.server !== "string" ||
    value.server.length > 2048 ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,200}$/.test(value.token) ||
    typeof value.user?.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value.user.id,
    ) ||
    typeof value.user.name !== "string" ||
    !value.user.name.trim() ||
    value.user.name.length > 128 ||
    (value.user.avatarId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        value.user.avatarId,
      )) ||
    (value.user.avatarRevision !== undefined &&
      (!Number.isSafeInteger(value.user.avatarRevision) ||
        value.user.avatarRevision < 0))
  )
    throw new Error(
      "The saved profile is invalid. Restore it with your recovery code.",
    );
  const url = new URL(value.server);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("The saved profile has an invalid server address.");
  return {
    server: url.origin,
    token: value.token,
    user: {
      id: value.user.id,
      name: value.user.name,
      ...(value.user.avatarId ? { avatarId: value.user.avatarId } : {}),
      ...(value.user.avatarRevision !== undefined
        ? { avatarRevision: value.user.avatarRevision }
        : {}),
    },
  };
}
