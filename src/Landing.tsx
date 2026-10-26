import { Link2, MessageCircle, Mic, ShieldCheck } from "lucide-react";
import { DesktopDownloads } from "./DesktopDownloads";

// First screen for a stranger who opens the site without an invite.
export function Landing({
  onStart,
  onRestore,
}: {
  onStart: () => void;
  onRestore: () => void;
}) {
  return (
    <main className="landing">
      <section className="landing-hero">
        <a className="landing-nav-link" href="/download">
          Download
        </a>
        <div className="brand landing-brand">
          <span className="brand-mark">
            <MessageCircle size={23} fill="currentColor" strokeWidth={0} />
            <i />
            <i />
          </span>
          <span>
            gather<span className="brand-period">.</span>
          </span>
        </div>
        <h1>A quieter place for your people.</h1>
        <p className="landing-lede">
          Private chat and voice for a small group of friends. Send one link and
          your crew is in a call in seconds. No servers, no channels, no account
          forms.
        </p>
        <div className="landing-actions">
          <button className="button primary landing-cta" onClick={onStart}>
            Start a group in your browser
          </button>
          <DesktopDownloads hero onDownload={() => {}} />
        </div>
        <button className="text-button" onClick={onRestore}>
          Already use Gather? Restore your profile
        </button>
      </section>
      <section className="landing-points" aria-label="What Gather is">
        <div>
          <Link2 size={20} />
          <h2>One link to join</h2>
          <p>
            Pick a name, share the invite, and your friends are in. It works in
            any modern browser.
          </p>
        </div>
        <div>
          <Mic size={20} />
          <h2>Voice that keeps up</h2>
          <p>
            Hop on a call with up to four friends. Calls reconnect on their own
            when your network blips.
          </p>
        </div>
        <div>
          <MessageCircle size={20} />
          <h2>Chat that never loses messages</h2>
          <p>
            Messages wait safely if you go offline and send when you are back.
            Photos, GIFs, replies and reactions included.
          </p>
        </div>
        <div>
          <ShieldCheck size={20} />
          <h2>Small on purpose</h2>
          <p>
            No feeds, ads or public discovery. Chats are private to the people
            you invite. They are not end-to-end encrypted.
          </p>
        </div>
      </section>
      <section className="landing-apps" id="downloads">
        <h2>Download the desktop app</h2>
        <p>
          Gather runs right in your browser on Mac, Windows, Linux, iPhone and
          Android. On a phone, add it to your Home Screen for an app-like feel.
          Desktop apps are available for Windows, Mac and Linux.
        </p>
        <div className="desktop-download">
          <DesktopDownloads all onDownload={() => {}} />
        </div>
      </section>
      <footer className="landing-legal">
        <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·{" "}
        <a href="/report">Report a problem</a>
      </footer>
    </main>
  );
}
