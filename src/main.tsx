import "./compat";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./themes.css";
import "./history.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if (import.meta.env.PROD && !window.desktop && "serviceWorker" in navigator)
  void navigator.serviceWorker
    .register("/service-worker.js", { updateViaCache: "none" })
    .catch(() => {
      // Browser policy or storage can disable offline startup; live chat still works.
    });
