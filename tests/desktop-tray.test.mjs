import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopPrefs } = require("../electron/desktop-prefs.cjs");
const { createTray } = require("../electron/tray.cjs");

test("desktop choices default to staying in the tray and survive a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "gather-prefs-")), "desktop.json");
  const first = createDesktopPrefs(file);
  assert.deepEqual(first.get(), {
    closeToTray: true,
    startOnLogin: false,
    trayHintShown: false,
  });
  first.set({ startOnLogin: true, closeToTray: "nope", extra: 1 });
  const second = createDesktopPrefs(file);
  assert.equal(second.get().startOnLogin, true);
  assert.equal(second.get().closeToTray, true);
  assert.equal("extra" in second.get(), false);
  writeFileSync(file, "{ not json");
  assert.equal(createDesktopPrefs(file).get().closeToTray, true);
});

test("the tray menu opens, toggles the two choices and quits", () => {
  const calls = [];
  let fake;
  class FakeTray {
    constructor(image) {
      fake = this;
      this.image = image;
      this.handlers = {};
    }
    on(name, fn) {
      this.handlers[name] = fn;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    setToolTip(text) {
      this.tip = text;
    }
    setImage(image) {
      this.image = image;
    }
    destroy() {}
  }
  const images = [];
  const nativeImage = {
    createFromPath: (path) => {
      const image = {
        path,
        addRepresentation() {},
        toPNG: () => Buffer.alloc(0),
      };
      images.push(path);
      return image;
    },
  };
  const Menu = { buildFromTemplate: (template) => template };
  let prefs = { closeToTray: true, startOnLogin: false };
  const tray = createTray(
    { Tray: FakeTray, Menu, nativeImage },
    {
      show: () => calls.push("show"),
      quit: () => calls.push("quit"),
      prefs: () => prefs,
      setPrefs: (patch) => {
        prefs = { ...prefs, ...patch };
        calls.push(patch);
      },
      supportsStartOnLogin: true,
    },
  );
  const instance = tray;
  assert.ok(images.some((path) => path.endsWith("tray-16.png")));
  assert.ok(images.some((path) => path.endsWith("tray-16-unread.png")));
  instance.setUnread(3);
  instance.setUnread(0);
  instance.refresh();
  assert.ok(typeof instance.destroy === "function");
  const labels = () => fake.menu.map((item) => item.label).filter(Boolean);
  assert.deepEqual(labels(), [
    "Open Gather",
    "Keep Gather running when closed",
    "Start Gather when I sign in",
    "Quit Gather",
  ]);
  fake.menu[0].click();
  fake.menu[2].click({ checked: false });
  fake.menu[3].click({ checked: true });
  fake.menu.at(-1).click();
  fake.handlers.click();
  assert.deepEqual(calls, [
    "show",
    { closeToTray: false },
    { startOnLogin: true },
    "quit",
    "show",
  ]);
  instance.setUnread(2);
  assert.equal(fake.tip, "Gather · 2 unread");
  assert.match(fake.image.path, /unread/);
  instance.setUnread(0);
  assert.equal(fake.tip, "Gather");
});
