export type DesktopRelease = {
  id: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  status: "stable" | "preview";
  platform: string;
  arch: string;
  label: string;
  suffix: string;
};
export const desktopTargets: Record<
  string,
  { platform: string; arch: string; label: string; suffix: string }
>;
export function downloadFilename(id: string, version: string): string;
export function readDesktopReleases(value: unknown): DesktopRelease[];
