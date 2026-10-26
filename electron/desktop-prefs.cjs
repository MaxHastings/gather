const fs = require("node:fs");

const defaults = Object.freeze({
  closeToTray: true,
  startOnLogin: false,
  trayHintShown: false,
});

// Small JSON file of desktop-only choices (tray, start on login).
function createDesktopPrefs(file) {
  let values = { ...defaults };
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of Object.keys(defaults))
      if (typeof saved?.[key] === "boolean") values[key] = saved[key];
  } catch {
    // First run or unreadable file: keep defaults.
  }
  return {
    get: () => ({ ...values }),
    set(patch) {
      for (const key of Object.keys(defaults))
        if (typeof patch?.[key] === "boolean") values[key] = patch[key];
      try {
        fs.writeFileSync(file, JSON.stringify(values));
      } catch {
        // A read-only profile still works for this session.
      }
      return { ...values };
    },
  };
}

module.exports = { createDesktopPrefs, defaults };
