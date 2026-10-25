import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, LogOut } from "lucide-react";
import { api } from "./api";
import type { Session } from "./types";
type Device = {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  current: boolean;
  online: boolean;
};
export function IdentitySettings({ session }: { session: Session }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [configured, setConfigured] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    const [recovery, listing] = await Promise.all([
      api<{ configured: boolean }>(session, "/api/recovery"),
      api<{ devices: Device[] }>(session, "/api/devices"),
    ]);
    setConfigured(recovery.configured);
    setDevices(listing.devices);
  }
  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ configured: boolean }>(session, "/api/recovery"),
      api<{ devices: Device[] }>(session, "/api/devices"),
    ])
      .then(([recovery, listing]) => {
        if (active) {
          setConfigured(recovery.configured);
          setDevices(listing.devices);
        }
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.server, session.token]);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <p role="status">
        <LoaderCircle className="spin" size={16} /> Loading…
      </p>
    );
  return (
    <div className="identity-settings">
      <section className="settings-block">
        <h3>Recovery code</h3>
        <p className="field-hint">
          Keep a code in your password manager to restore this profile on
          another computer. Anyone with it can access your chats.
        </p>
        {configured && !code && (
          <p className="field-hint">
            Replacing your code invalidates the previous one.
          </p>
        )}
        {code && (
          <>
            <label htmlFor="recovery-code">Your recovery code</label>
            <input
              id="recovery-code"
              className="recovery-code"
              value={code}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <button
              className="button secondary full"
              onClick={() =>
                void action(async () => {
                  if (window.desktop?.copyRecoveryCode)
                    await window.desktop.copyRecoveryCode(code);
                  else await navigator.clipboard.writeText(code);
                  setCopied(true);
                })
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy recovery code"}
            </button>
            <p className="field-hint">
              This code is shown only now. Replacing it stops the previous code
              from working.
            </p>
          </>
        )}
        <button
          className="button secondary full"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const response = await api<{ code: string }>(
                session,
                "/api/recovery",
                { method: "POST" },
              );
              setCode(response.code);
              setCopied(false);
              setConfigured(true);
            })
          }
        >
          <KeyRound size={16} />
          {configured ? "Replace recovery code" : "Create recovery code"}
        </button>
      </section>
      <section className="settings-block">
        <h3>Signed-in devices</h3>
        <div className="device-list">
          {devices.map((device) => (
            <div className="device-row" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span>
                  {device.current
                    ? "This device"
                    : device.online
                      ? "Connected"
                      : `Last used ${new Date(device.lastSeen).toLocaleDateString()}`}
                </span>
              </div>
              {!device.current && (
                <button
                  className="icon-button"
                  aria-label={`Sign out ${device.name}`}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api(session, "/api/devices/revoke", {
                        method: "POST",
                        body: JSON.stringify({ id: device.id }),
                      });
                      await load();
                    })
                  }
                >
                  <LogOut size={17} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {error && !devices.length && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void action(load)}
        >
          Try again
        </button>
      )}
    </div>
  );
}
