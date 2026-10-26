// Tab title, favicon and desktop badge that mirror the unread total.
const BASE_TITLE = "Gather";
let baseIcon: HTMLLinkElement | null = null;
let originalHref = "";
let dotHref = "";

function dotIcon(): Promise<string> {
  if (dotHref) return Promise.resolve(dotHref);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve("");
      ctx.drawImage(image, 0, 0, 64, 64);
      ctx.beginPath();
      ctx.arc(48, 16, 14, 0, Math.PI * 2);
      ctx.fillStyle = "#e5484d";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      dotHref = canvas.toDataURL("image/png");
      resolve(dotHref);
    };
    image.onerror = () => resolve("");
    image.src = originalHref;
  });
}

let latest = 0;
export function showUnreadAttention(count: number) {
  latest = count;
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${BASE_TITLE}` : BASE_TITLE;
  void window.desktop?.setUnreadCount?.(count).catch(() => {});
  baseIcon ??= document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!baseIcon) return;
  originalHref ||= baseIcon.href;
  if (count <= 0) {
    baseIcon.href = originalHref;
    return;
  }
  void dotIcon().then((href) => {
    if (baseIcon && latest > 0 && href) baseIcon.href = href;
  });
}
