import { useRef, useState } from "react";
import { Play, Upload, X } from "lucide-react";
import {
  customSoundLimit,
  previewSound,
  readSoundPreferences,
  removeCustomSound,
  saveCustomSound,
  saveSoundPreferences,
  soundEventLabels,
  soundEvents,
  soundPacks,
  type SoundEvent,
  type SoundPreferences,
} from "./sounds";

export function SoundSettings() {
  const [prefs, setPrefs] = useState(readSoundPreferences);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<SoundEvent | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const target = useRef<SoundEvent>("message");
  function save(next: SoundPreferences) {
    try {
      saveSoundPreferences(next);
      setPrefs(next);
      setError("");
    } catch {
      setError("Could not save sound settings. Check available storage.");
    }
  }
  async function choose(file: File | undefined) {
    const event = target.current;
    if (!file) return;
    setBusy(event);
    try {
      await saveCustomSound(event, file);
      save({
        ...prefs,
        custom: [...new Set([...prefs.custom, event])],
        off: prefs.off.filter((e) => e !== event),
      });
      previewSound(event);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t use that sound.");
    } finally {
      setBusy(null);
    }
  }
  async function clear(event: SoundEvent) {
    try {
      await removeCustomSound(event);
    } catch {
      /* The preference below is what decides playback. */
    }
    save({ ...prefs, custom: prefs.custom.filter((e) => e !== event) });
  }
  return (
    <div className="sound-settings">
      <label className="preference-toggle">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => save({ ...prefs, enabled: e.target.checked })}
        />
        <span>Play sounds</span>
      </label>
      <div className="settings-block">
        <label htmlFor="sound-volume">Volume</label>
        <input
          id="sound-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={prefs.volume}
          disabled={!prefs.enabled}
          onChange={(e) => save({ ...prefs, volume: Number(e.target.value) })}
          onPointerUp={() => previewSound("message")}
          onKeyUp={() => previewSound("message")}
        />
      </div>
      <h3>Sound pack</h3>
      <div className="sound-packs" role="radiogroup" aria-label="Sound pack">
        {soundPacks.map((pack) => (
          <div
            key={pack.id}
            className={`sound-pack${prefs.pack === pack.id ? " selected" : ""}`}
          >
            <label>
              <input
                type="radio"
                name="sound-pack"
                checked={prefs.pack === pack.id}
                disabled={!prefs.enabled}
                onChange={() => {
                  save({ ...prefs, pack: pack.id });
                  previewSound("message", pack.id, false);
                }}
              />
              <span>
                <strong>{pack.name}</strong>
                <small>{pack.blurb}</small>
              </span>
            </label>
            <button
              className="icon-button"
              aria-label={`Preview ${pack.name}`}
              title="Preview"
              onClick={() => previewSound("message", pack.id, false)}
            >
              <Play size={14} />
            </button>
          </div>
        ))}
      </div>
      <h3>Events</h3>
      <ul className="sound-events">
        {soundEvents.map((event) => (
          <li key={event}>
            <label className="preference-toggle">
              <input
                type="checkbox"
                checked={!prefs.off.includes(event)}
                disabled={!prefs.enabled}
                onChange={(e) =>
                  save({
                    ...prefs,
                    off: e.target.checked
                      ? prefs.off.filter((x) => x !== event)
                      : [...prefs.off, event],
                  })
                }
              />
              <span>{soundEventLabels[event]}</span>
            </label>
            {prefs.custom.includes(event) && (
              <span className="field-hint">Custom</span>
            )}
            <button
              className="icon-button"
              aria-label={`Preview ${soundEventLabels[event]}`}
              title="Preview"
              onClick={() => previewSound(event)}
            >
              <Play size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={`Choose your own sound for ${soundEventLabels[event]}`}
              title="Use your own sound"
              disabled={busy === event}
              onClick={() => {
                target.current = event;
                picker.current?.click();
              }}
            >
              <Upload size={14} />
            </button>
            {prefs.custom.includes(event) && (
              <button
                className="icon-button"
                aria-label={`Remove custom sound for ${soundEventLabels[event]}`}
                title="Back to the pack sound"
                onClick={() => void clear(event)}
              >
                <X size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <input
        ref={picker}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void choose(file);
        }}
      />
      <p className="field-hint">
        Your own sounds stay on this device. Use a short clip under{" "}
        {customSoundLimit.bytes / 1024} KB and {customSoundLimit.seconds}{" "}
        seconds. Sounds are saved per device.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
