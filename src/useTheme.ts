import { useEffect, useState } from "react";

export type Theme = "system" | "dark" | "light";
const valid = (value: string | null): Theme =>
  value === "dark" || value === "light" ? value : "system";
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return valid(localStorage.getItem("gather.theme"));
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "dark" || (theme === "system" && system.matches)
          ? "dark"
          : "light";
    };
    apply();
    try {
      localStorage.setItem("gather.theme", theme);
    } catch {}
    system.addEventListener("change", apply);
    const sync = (event: StorageEvent) => {
      if (event.key === "gather.theme" || event.key === null)
        setTheme(valid(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => {
      system.removeEventListener("change", apply);
      window.removeEventListener("storage", sync);
    };
  }, [theme]);
  return { theme, setTheme };
}
