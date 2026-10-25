import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { createWindowAccess } = createRequire(import.meta.url)(
  "../electron/window-access.cjs",
);
const trusted = (url) =>
  url === "app://gather/index.html" || url === "app://gather";
test("late permissions, IPC and shortcuts never touch a destroyed BrowserWindow", () => {
  const window = {
    isDestroyed: () => true,
    get webContents() {
      throw new Error("Object has been destroyed");
    },
  };
  const access = createWindowAccess(() => window, trusted);
  assert.equal(access.permissionCheck(null, "media", "app://gather"), false);
  assert.equal(
    access.permissionCheck(
      { isDestroyed: () => true },
      "media",
      "app://gather",
    ),
    false,
  );
  let allowed;
  access.permissionRequest(
    null,
    "media",
    (value) => {
      allowed = value;
    },
    { requestingUrl: "app://gather", mediaTypes: ["audio"] },
  );
  assert.equal(allowed, false);
  assert.equal(access.validSender({ sender: null }), false);
  assert.equal(
    access.withWindow(() => assert.fail("A closed window cannot be used")),
    false,
  );
});
test("destroyed WebContents and disposed sending frames are rejected", () => {
  const contents = {
    isDestroyed: () => true,
    getURL: () => assert.fail("No URL access after destruction"),
  };
  const access = createWindowAccess(
    () => ({ isDestroyed: () => false, webContents: contents }),
    trusted,
  );
  assert.equal(
    access.permissionCheck(contents, "media", "app://gather"),
    false,
  );
  let denied;
  access.permissionRequest(contents, "media", (value) => {
    denied = value;
  });
  assert.equal(denied, false);
  contents.isDestroyed = () => false;
  assert.equal(
    access.validSender({
      sender: contents,
      get senderFrame() {
        throw new Error("Frame disposed");
      },
    }),
    false,
  );
});
test("only the live trusted main window gets audio and sanitized clipboard writes", () => {
  const contents = {
    isDestroyed: () => false,
    getURL: () => "app://gather/index.html",
  };
  let window = { isDestroyed: () => false, webContents: contents };
  const access = createWindowAccess(() => window, trusted);
  assert.equal(
    access.permissionCheck(contents, "media", "app://gather", {
      mediaType: "audio",
    }),
    true,
  );
  assert.equal(
    access.permissionCheck(contents, "media", "app://gather", {
      mediaType: "video",
    }),
    false,
  );
  assert.equal(
    access.permissionCheck(contents, "clipboard-read", "app://gather"),
    false,
  );
  assert.equal(
    access.permissionCheck(
      contents,
      "clipboard-sanitized-write",
      "app://gather",
    ),
    true,
  );
  assert.equal(
    access.permissionCheck(contents, "media", "https://untrusted.example"),
    false,
  );
  assert.equal(
    access.permissionCheck(contents, "media", "app://gather", {
      isMainFrame: false,
    }),
    false,
  );
  for (const [mediaTypes, expected] of [
    [["audio"], true],
    [["video"], false],
    [[], false],
  ]) {
    let allowed;
    access.permissionRequest(
      contents,
      "media",
      (value) => {
        allowed = value;
      },
      { requestingUrl: "app://gather", mediaTypes },
    );
    assert.equal(allowed, expected);
  }
  window = null;
  assert.equal(access.permissionCheck(null, "media", "app://gather"), false);
});
