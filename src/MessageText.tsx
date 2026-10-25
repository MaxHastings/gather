import { memo, useState, useMemo } from "react";
import { EmojiText } from "./Emoji";
import { messageText, inlineText } from "../server/message-text.mjs";
import { gifUrl } from "../server/gif-policy.mjs";
export const MessageText = memo(function MessageText({
  text,
}: {
  text: string;
}) {
  const blocks = useMemo(() => messageText(text), [text]);
  const [error, setError] = useState("");
  const gif = gifUrl(text);
  if (gif)
    return (
      <img
        className="gif-message"
        src={gif}
        alt="GIF"
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
      />
    );
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "block" ? (
          <pre key={i}>
            <code>{b.value}</code>
          </pre>
        ) : (
          <span key={i}>
            {inlineText(b.value).map((t, j) => {
              if (t.type === "code") return <code key={j}>{t.value}</code>;
              if (t.type === "link")
                return (
                  <a
                    key={j}
                    href={t.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      if (window.desktop) {
                        e.preventDefault();
                        void window.desktop
                          .openExternal(t.value)
                          .catch((failure: Error) => setError(failure.message));
                      }
                    }}
                  >
                    {t.value}
                  </a>
                );
              const body = <EmojiText text={t.value} />;
              return t.type === "bold" ? (
                <strong key={j}>{body}</strong>
              ) : t.type === "italic" ? (
                <em key={j}>{body}</em>
              ) : t.type === "strike" ? (
                <s key={j}>{body}</s>
              ) : (
                <span key={j}>{body}</span>
              );
            })}
          </span>
        ),
      )}
      {error && (
        <small className="form-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
});
