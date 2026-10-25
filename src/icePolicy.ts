export function iceLifetimeSeconds(value?: number) {
  // Older compatible servers did not advertise expiry. Refresh conservatively
  // rather than assuming their temporary credentials are permanent.
  if (value === undefined) return 3600;
  if (!Number.isInteger(value) || value < 10 || value > 86400)
    throw new Error("The server returned an invalid audio relay lifetime.");
  return value;
}
export function iceRenewalDelayMs(lifetime: number) {
  return iceLifetimeSeconds(lifetime) * 750;
}
