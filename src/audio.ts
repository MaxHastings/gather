const missingDevice = (error: unknown) =>
  error instanceof Error &&
  (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(
    error.name,
  ) ||
    /object not found|requested device not found/i.test(error.message));

export function audioError(error: unknown): string {
  if (missingDevice(error))
    return "No microphone found. Connect a headset or microphone, then try again.";
  if (error instanceof Error) {
    if (
      ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(
        error.name,
      )
    )
      return "Microphone access is blocked. Allow Gather in your browser or system microphone settings, then try again.";
    if (
      ["NotReadableError", "TrackStartError", "AbortError"].includes(error.name)
    )
      return "Couldn’t open your microphone. Check that it’s connected and isn’t being used exclusively by another app.";
    return error.message;
  }
  return "Couldn’t start audio. Check your microphone and try again.";
}

export async function captureMicrophone(
  preferred: string,
  media:
    Pick<MediaDevices, "getUserMedia"> | undefined = navigator.mediaDevices,
) {
  if (!media?.getUserMedia)
    throw new Error(
      "Microphone access is unavailable. Open Gather in a current browser using HTTPS, or use the desktop app.",
    );
  const capture = async (id: string) => {
    const stream = await media.getUserMedia({
      audio: {
        deviceId: id === "default" ? undefined : { exact: id },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("No microphone found", "NotFoundError");
    }
    return { stream, deviceId: id };
  };
  try {
    return await capture(preferred);
  } catch (error) {
    // Device identifiers can change when a headset is unplugged or permissions reset.
    // Retry only a missing selection; permission and hardware errors need user action.
    if (preferred === "default" || !missingDevice(error)) throw error;
    return capture("default");
  }
}
