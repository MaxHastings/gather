const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function createNotifications(Notification, access, icon) {
  const active = new Map();
  function clear(scope) {
    if (typeof scope !== "string" || scope.length > 512)
      throw new Error("Invalid notification scope.");
    for (const [key, item] of active)
      if (item.scope === scope) {
        active.delete(key);
        item.notification.close();
      }
  }
  function dispose() {
    for (const item of active.values()) item.notification.close();
    active.clear();
  }
  function show(value) {
    if (
      !value ||
      typeof value.scope !== "string" ||
      !value.scope.length ||
      value.scope.length > 512 ||
      !UUID.test(value.groupId) ||
      !UUID.test(value.messageId) ||
      typeof value.title !== "string" ||
      !value.title.length ||
      value.title.length > 100 ||
      typeof value.body !== "string" ||
      value.body.length > 300
    )
      throw new Error("Invalid notification.");
    if (!Notification.isSupported()) return false;
    const key = JSON.stringify([value.scope, value.groupId]);
    try {
      active.get(key)?.notification.close();
      const notification = new Notification({
        title: value.title,
        body: value.body,
        icon,
      });
      const item = { scope: value.scope, notification };
      active.set(key, item);
      const remove = () => {
        if (active.get(key) === item) active.delete(key);
      };
      notification.on("failed", remove);
      notification.on("close", remove);
      notification.on("click", () => {
        // A pending OS callback may arrive after sign-out, replacement or quit.
        if (active.get(key) !== item) return;
        remove();
        access.withWindow((window, contents) => {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          contents.send("notifications:open", {
            scope: value.scope,
            groupId: value.groupId,
          });
        });
        notification.close();
      });
      while (active.size > 32) {
        const [oldKey, oldItem] = active.entries().next().value;
        active.delete(oldKey);
        oldItem.notification.close();
      }
      notification.show();
      return true; // Accepted by Electron; OS focus/notification settings still apply.
    } catch {
      active.delete(key);
      return false;
    }
  }
  return { show, clear, dispose, supported: () => Notification.isSupported() };
}
module.exports = { createNotifications };
