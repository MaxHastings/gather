// Older Safari (before 17.4 / 16) lacks these. Missing one would throw inside
// an effect and blank the whole app, so provide minimal equivalents.
if (typeof AbortSignal.timeout !== "function")
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  };
if (typeof AbortSignal.any !== "function")
  AbortSignal.any = (signals: Iterable<AbortSignal>) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      });
    }
    return controller.signal;
  };
