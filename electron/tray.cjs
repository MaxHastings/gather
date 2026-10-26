const path = require("node:path");

// Tray icon with a short menu. Clicking the icon brings Gather back.
function createTray({ Tray, Menu, nativeImage }, options) {
  const { show, quit, prefs, setPrefs, supportsStartOnLogin } = options;
  const image = (name) => {
    const icon = nativeImage.createFromPath(path.join(__dirname, `${name}-16.png`));
    icon.addRepresentation({
      scaleFactor: 2,
      buffer: nativeImage
        .createFromPath(path.join(__dirname, `${name}-32.png`))
        .toPNG(),
    });
    return icon;
  };
  const normal = image("tray");
  const unread = nativeImage.createFromPath(path.join(__dirname, "tray-16-unread.png"));
  unread.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path.join(__dirname, "tray-32-unread.png")).toPNG(),
  });
  const tray = new Tray(normal);
  let count = 0;
  const rebuild = () => {
    const current = prefs();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Gather", click: show },
        { type: "separator" },
        {
          label: "Keep Gather running when closed",
          type: "checkbox",
          checked: current.closeToTray,
          click: (item) => setPrefs({ closeToTray: item.checked }),
        },
        ...(supportsStartOnLogin
          ? [
              {
                label: "Start Gather when I sign in",
                type: "checkbox",
                checked: current.startOnLogin,
                click: (item) => setPrefs({ startOnLogin: item.checked }),
              },
            ]
          : []),
        { type: "separator" },
        { label: "Quit Gather", click: quit },
      ]),
    );
    tray.setToolTip(count > 0 ? `Gather · ${count} unread` : "Gather");
  };
  tray.on("click", show);
  tray.on("double-click", show);
  rebuild();
  return {
    refresh: rebuild,
    setUnread(next) {
      count = next;
      tray.setImage(next > 0 ? unread : normal);
      rebuild();
    },
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray };
