import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AnimatedGradientText,
  AnimatedGridPattern,
  BorderBeam,
  KineticText,
  ShineBorder,
  TypingAnimation,
} from "./components/magic-ui.jsx";
import "../styles.css";

const suggestions = [
  {
    label: "Redesign UI Tailwind",
    prompt: "Redesign landing page dengan Tailwind CSS modern minimal",
  },
  {
    label: "Deploy Worker TS",
    prompt: "Jelaskan cara deploy Cloudflare Worker TypeScript step by step",
  },
  {
    label: "Cari berita tech",
    prompt: "Cari berita teknologi terbaru hari ini",
  },
  {
    label: "Review repo GitHub",
    prompt: "Review struktur repo GitHub saya dan sarankan improvement",
  },
  {
    label: "Scaffold Next.js",
    prompt: "Buatkan struktur folder project Next.js + Cloudflare Workers",
  },
  {
    label: "Analisis screenshot",
    prompt: "Analisis screenshot UI dan generate kode HTML Tailwind",
  },
];

export default function App() {
  const [modeInfoOpen, setModeInfoOpen] = useState(false);
  const [greeting, setGreeting] = useState("Hai, ada yang bisa AIRIN bantu?");
  const [dialogQueue, setDialogQueue] = useState([]);
  const dialogQueueRef = useRef([]);

  const showDialog = useCallback((type, message, options = {}) => {
    return new Promise((resolve) => {
      const dialog = {
        id: crypto.randomUUID(),
        type,
        message: String(message),
        title: options.title || (type === "confirm" ? "Konfirmasi" : "Informasi"),
        confirmLabel: options.confirmLabel || "Lanjutkan",
        cancelLabel: options.cancelLabel || "Batal",
        resolve,
      };
      dialogQueueRef.current = [...dialogQueueRef.current, dialog];
      setDialogQueue(dialogQueueRef.current);
    });
  }, []);

  const settleDialog = useCallback((result) => {
    const [dialog, ...remaining] = dialogQueueRef.current;
    if (!dialog) return;
    dialogQueueRef.current = remaining;
    setDialogQueue(remaining);
    dialog.resolve(result);
  }, []);

  useEffect(() => {
    const originalConfirm = window.confirm;
    const originalAlert = window.alert;
    window.setAirinGreeting = setGreeting;
    window.airinConfirm = (message, options) =>
      showDialog("confirm", message, options);
    window.airinAlert = (message, options) =>
      showDialog("alert", message, options);
    window.confirm = (message, options) =>
      showDialog("confirm", message, options);
    window.alert = (message, options) => {
      void showDialog("alert", message, options);
    };
    window.animateAirinReply = (element, text, onComplete) => {
      const root = createRoot(element);
      root.render(
        <TypingAnimation
          text={text}
          onComplete={() => {
            window.setTimeout(() => {
              root.unmount();
              onComplete();
            }, 0);
          }}
        />,
      );
    };
    import("../app.js");
    return () => {
      delete window.setAirinGreeting;
      delete window.airinConfirm;
      delete window.airinAlert;
      window.confirm = originalConfirm;
      window.alert = originalAlert;
      delete window.animateAirinReply;
    };
  }, [showDialog]);

  useEffect(() => {
    if (!modeInfoOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") setModeInfoOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modeInfoOpen]);

  useEffect(() => {
    if (!dialogQueue.length) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        settleDialog(dialogQueue[0].type === "confirm" ? false : undefined);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dialogQueue, settleDialog]);

  return (
    <>
      <a className="skip-link" href="#messages">
        Langsung ke chat
      </a>
      <div
        id="sidebar-overlay"
        className="sidebar-overlay"
        aria-hidden="true"
      />

      <div id="app">
        <aside id="sidebar" aria-label="Navigasi AIRIN AI">
          <div className="sidebar-top">
            <div className="brand-row">
              <div className="brand">
                <span className="brand-mark" aria-hidden="true">
                  ✦
                </span>
                <span className="brand-name">
                  <AnimatedGradientText>AIRIN</AnimatedGradientText>
                </span>
              </div>
              <button
                id="btn-close-sidebar"
                className="icon-btn btn-close-sidebar"
                aria-label="Tutup menu"
                type="button"
              >
                <i className="fa-solid fa-xmark" />
              </button>
            </div>

            <button id="btn-new" className="nav-item nav-primary" type="button">
              <i className="fa-regular fa-pen-to-square" />
              <span>New chat</span>
            </button>

            <div className="side-divider" />

            <div className="conv-section">
              <div className="conv-label">Conversations</div>
              <p id="conv-empty" className="conv-empty">
                Percakapan dengan AIRIN akan muncul di sini.
              </p>
              <div id="conv-list" className="conv-list" role="list" />
            </div>
          </div>

          <div className="sidebar-bottom">
            <button id="btn-github" className="nav-item" type="button">
              <i className="fa-brands fa-github" />
              <span id="gh-btn-label">Connect GitHub</span>
            </button>
            <p id="gh-status" className="gh-status">
              Belum connect
            </p>
            <div className="user-card">
              <div className="user-avatar" id="user-avatar" aria-hidden="true">
                A
              </div>
              <div className="user-meta">
                <div className="user-name" id="user-name">
                  Guest
                </div>
                <div className="user-plan" id="user-plan">
                  Anonymous
                </div>
              </div>
              <span
                id="online-dot"
                className="dot"
                title="Status backend"
                role="status"
              />
            </div>
            <p id="session-id" className="session-id">
              —
            </p>
          </div>
        </aside>

        <main id="main">
          <AnimatedGridPattern />
          <header id="topbar">
            <button
              id="btn-menu"
              className="icon-btn"
              aria-label="Buka menu"
              type="button"
            >
              <i className="fa-solid fa-bars" />
            </button>
            <span className="top-title" id="chat-title">
              AIRIN
            </span>
            <button
              className="temp-badge"
              id="mode-badge"
              type="button"
              aria-haspopup="dialog"
              aria-controls="mode-info-dialog"
              aria-label="Jelaskan mode penyimpanan Temporary"
              onClick={() => setModeInfoOpen(true)}
            >
              <i className="fa fa-microchip" aria-hidden="true" />
              <span id="mode-badge-text">Qwen</span>
            </button>

          </header>

          <div id="stage" className="stage is-empty">
            <div id="empty-state" className="empty-state">
              <div className="hero-mark" aria-hidden="true">
                <span>✦</span>
              </div>
              <p className="hero-eyebrow">
                <AnimatedGradientText>YOUR AI COMPANION</AnimatedGradientText>
              </p>
              <KineticText text={greeting} className="greeting" id="greeting" />
            </div>

            <div
              id="messages"
              className="messages"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
            />

            <div className="composer-wrap">
              <div id="preview-area" className="preview-area hidden">
                <img id="img-preview" alt="Pratinjau gambar" />
                <button
                  id="btn-clear-img"
                  className="icon-btn danger"
                  title="Hapus gambar"
                  type="button"
                  aria-label="Hapus gambar"
                >
                  <i className="fa-solid fa-xmark" />
                </button>
              </div>

              <div className="composer-box" id="composer">
                <ShineBorder />
                <BorderBeam />
                <textarea
                  id="input"
                  rows="1"
                  placeholder="Message AIRIN"
                  autoFocus
                  aria-label="Pesan ke AIRIN"
                />
                <div className="composer-toolbar">
                  <div className="toolbar-left">
                    <label
                      className="img-btn"
                      title="Upload gambar"
                      aria-label="Upload gambar"
                    >
                      <i className="fa-solid fa-plus" />
                      <input
                        type="file"
                        id="file-input"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                      />
                    </label>
                    <label className="pill-btn model-mode-control" title="Pilih model untuk chat">
                      <i className="fa-solid fa-wand-magic-sparkles" />
                      <select
                        id="model-mode"
                        aria-label="Mode model"
                        defaultValue="smart"
                      >
                        <option value="smart">Smart</option>
                        <option value="coder">Coder</option>
                      </select>
                    </label>
                  </div>
                  <button
                    id="btn-send"
                    className="send-btn"
                    title="Kirim"
                    aria-label="Kirim pesan"
                    type="button"
                  >
                    <i className="fa-solid fa-arrow-up" />
                  </button>
                </div>
              </div>

              <div className="suggestion-chips" id="suggestion-chips">
                {suggestions.map(({ label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    className="chip"
                    data-prompt={prompt}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <p className="disclaimer">
                AIRIN adalah AI dan bisa membuat kesalahan. Cek info penting
                secara mandiri.
              </p>
            </div>
          </div>
        </main>
      </div>

      {modeInfoOpen && (
        <div
          className="mode-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModeInfoOpen(false);
          }}
        >
          <section
            id="mode-info-dialog"
            className="mode-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-dialog-title"
            aria-describedby="mode-dialog-description"
          >
            <div className="mode-dialog-icon" aria-hidden="true">
              <i className="fa-solid fa-clock" />
            </div>
            <button
              className="icon-btn mode-dialog-close"
              type="button"
              aria-label="Tutup penjelasan mode"
              onClick={() => setModeInfoOpen(false)}
            >
              <i className="fa-solid fa-xmark" />
            </button>
            <p className="mode-dialog-eyebrow">MODE PENYIMPANAN</p>
            <h2 id="mode-dialog-title">Temporary</h2>
            <p id="mode-dialog-description">
              Kamu sedang menggunakan AIRIN sebagai tamu. Percakapan disimpan
              sementara di sesi browser ini dan tidak tersinkron ke akun.
            </p>
            <div className="mode-dialog-note">
              <i className="fa-solid fa-circle-info" aria-hidden="true" />
              Riwayat sementara dapat hilang saat sesi browser berakhir. Hubungkan
              GitHub untuk menyimpan dan membuka kembali percakapan dari akunmu.
            </div>
            <button
              className="mode-dialog-action"
              type="button"
              onClick={() => setModeInfoOpen(false)}
            >
              Mengerti
            </button>
          </section>
        </div>
      )}

      {dialogQueue.length > 0 && (
        <div
          className="global-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              settleDialog(dialogQueue[0].type === "confirm" ? false : undefined);
            }
          }}
        >
          <section
            className="global-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="global-dialog-title"
            aria-describedby="global-dialog-message"
          >
            <div className="global-dialog-icon" aria-hidden="true">
              <i
                className={
                  dialogQueue[0].type === "confirm"
                    ? "fa-solid fa-circle-question"
                    : "fa-solid fa-circle-info"
                }
              />
            </div>
            <h2 id="global-dialog-title">{dialogQueue[0].title}</h2>
            <p id="global-dialog-message">{dialogQueue[0].message}</p>
            <div className="global-dialog-actions">
              {dialogQueue[0].type === "confirm" && (
                <button
                  className="global-dialog-cancel"
                  type="button"
                  onClick={() => settleDialog(false)}
                >
                  {dialogQueue[0].cancelLabel}
                </button>
              )}
              <button
                className="global-dialog-confirm"
                type="button"
                autoFocus
                onClick={() =>
                  settleDialog(
                    dialogQueue[0].type === "confirm" ? true : undefined,
                  )
                }
              >
                {dialogQueue[0].type === "confirm"
                  ? dialogQueue[0].confirmLabel
                  : "Mengerti"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
