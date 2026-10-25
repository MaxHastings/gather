(() => {
  let choice = "system";
  try {
    choice = localStorage.getItem("gather.theme") || "system";
  } catch {}
  document.documentElement.dataset.theme =
    choice === "dark" ||
    (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
})();
