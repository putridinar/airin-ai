/**
 * AIRIN AI — Frontend (Copilot-style UI + multi-thread)
 */

const API = () => window.AIRIN_API || "http://localhost:8788";

const el = {
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("btn-send"),
  file: document.getElementById("file-input"),
  previewArea: document.getElementById("preview-area"),
  imgPreview: document.getElementById("img-preview"),
  clearImg: document.getElementById("btn-clear-img"),
  newChat: document.getElementById("btn-new"),
  github: document.getElementById("btn-github"),
  ghStatus: document.getElementById("gh-status"),
  ghBtnLabel: document.getElementById("gh-btn-label"),
  sessionId: document.getElementById("session-id"),
  online: document.getElementById("online-dot"),
  menu: document.getElementById("btn-menu"),
  closeSidebar: document.getElementById("btn-close-sidebar"),
  overlay: document.getElementById("sidebar-overlay"),
  sidebar: document.getElementById("sidebar"),
  convList: document.getElementById("conv-list"),
  convEmpty: document.getElementById("conv-empty"),
  chatTitle: document.getElementById("chat-title"),
  stage: document.getElementById("stage"),
  greeting: document.getElementById("greeting"),
  chips: document.getElementById("suggestion-chips"),
  modeBadge: document.getElementById("mode-badge"),
  modeBadgeText: document.getElementById("mode-badge-text"),
  userAvatar: document.getElementById("user-avatar"),
  userName: document.getElementById("user-name"),
  userPlan: document.getElementById("user-plan"),
};

const ANON_STORE_KEY = "airin_anon_threads";
const ANON_SESSION_KEY = "airin_anon_session";

let conversations = [];
let activeConvId = null;
let history = [];
let sessionId = null;
let githubToken = localStorage.getItem("airin_github_token") || null;
let githubLogin = null;
let pendingImageBase64 = null;
let busy = false;

function isLoggedIn() {
  return Boolean(githubToken);
}

function authHeaders() {
  return githubToken ? { "X-GitHub-Token": githubToken } : {};
}

function initSessionId() {
  if (isLoggedIn()) {
    sessionId = localStorage.getItem("airin_session") || crypto.randomUUID();
    localStorage.setItem("airin_session", sessionId);
  } else {
    sessionId = sessionStorage.getItem(ANON_SESSION_KEY) || crypto.randomUUID();
    sessionStorage.setItem(ANON_SESSION_KEY, sessionId);
  }
  el.sessionId.textContent = sessionId.slice(0, 8) + "…";
}

function setChatTitle(title) {
  el.chatTitle.textContent = title || "AIRIN";
}

function updateStageEmpty() {
  const empty = history.length === 0;
  el.stage.classList.toggle("is-empty", empty);
}

function updateUserCard() {
  if (isLoggedIn() && githubLogin) {
    el.userName.textContent = githubLogin;
    el.userPlan.textContent = "GitHub · Saved";
    el.userAvatar.textContent = (githubLogin[0] || "U").toUpperCase();
    el.modeBadgeText.textContent = "Saved";
    el.modeBadge.classList.add("saved");
  } else {
    el.userName.textContent = "Guest";
    el.userPlan.textContent = "Anonymous";
    el.userAvatar.textContent = "G";
    el.modeBadgeText.textContent = "Temporary";
    el.modeBadge.classList.remove("saved");
  }
}

function updateGreeting() {
  const name = githubLogin || "";
  el.greeting.textContent = name
    ? `Hai ${name}, ada yang bisa AIRIN bantu?`
    : "Hai, ada yang bisa AIRIN bantu?";
}

/* ── Anon store ── */
function loadAnonStore() {
  try {
    const raw = sessionStorage.getItem(ANON_STORE_KEY);
    if (!raw) return { activeId: null, threads: {} };
    const parsed = JSON.parse(raw);
    return { activeId: parsed.activeId || null, threads: parsed.threads || {} };
  } catch {
    return { activeId: null, threads: {} };
  }
}

function saveAnonStore(store) {
  try {
    sessionStorage.setItem(ANON_STORE_KEY, JSON.stringify(store));
  } catch { /* quota */ }
}

function syncAnonListFromStore() {
  const store = loadAnonStore();
  conversations = Object.values(store.threads)
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      preview: t.preview || "",
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  activeConvId = store.activeId;
  if (activeConvId && store.threads[activeConvId]) {
    history = (store.threads[activeConvId].messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  } else {
    history = [];
    activeConvId = null;
  }
}

function persistAnonActive() {
  if (isLoggedIn()) return;
  const store = loadAnonStore();
  if (!activeConvId) {
    store.activeId = null;
    saveAnonStore(store);
    return;
  }
  const prev = store.threads[activeConvId] || {
    id: activeConvId,
    title: "Chat baru",
    createdAt: new Date().toISOString(),
    messages: [],
  };
  const firstUser = history.find((m) => m.role === "user");
  const title =
    prev.title && prev.title !== "Chat baru"
      ? prev.title
      : (firstUser?.content || "Chat baru").slice(0, 80);
  store.threads[activeConvId] = {
    id: activeConvId,
    title,
    createdAt: prev.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preview: (firstUser?.content || "").slice(0, 80),
    messages: history.slice(-80),
  };
  store.activeId = activeConvId;
  saveAnonStore(store);
  syncAnonListFromStore();
}

/* ── Server API ── */
async function fetchConversationList() {
  if (!githubToken) return;
  const res = await fetch(`${API()}/api/conversations`, { headers: authHeaders() });
  if (!res.ok) throw new Error("list failed");
  const data = await res.json();
  githubLogin = data.login || githubLogin;
  conversations = data.conversations || [];
}

async function fetchConversation(id) {
  const res = await fetch(`${API()}/api/conversations/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.conversation || null;
}

async function apiCreateConversation(title) {
  const res = await fetch(`${API()}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ title: title || "Chat baru" }),
  });
  if (!res.ok) throw new Error("create failed");
  const data = await res.json();
  return data.conversation;
}

async function apiRenameConversation(id, title) {
  const res = await fetch(`${API()}/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.conversation;
}

async function apiDeleteConversation(id) {
  await fetch(`${API()}/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

/* ── Conversation list UI ── */
function renderConvList() {
  el.convList.innerHTML = "";
  if (!conversations.length) {
    el.convEmpty.classList.add("visible");
    return;
  }
  el.convEmpty.classList.remove("visible");

  for (const c of conversations) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conv-item" + (c.id === activeConvId ? " active" : "");
    btn.setAttribute("role", "listitem");
    btn.innerHTML = `
      <span class="conv-title">${escapeHtml(c.title || "Chat baru")}</span>
      <span class="conv-actions">
        <button type="button" class="rename" title="Rename" aria-label="Rename"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="danger delete" title="Hapus" aria-label="Hapus"><i class="fa-solid fa-trash"></i></button>
      </span>
      <span class="conv-preview">${escapeHtml(c.preview || "")}</span>
    `;
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".rename") || e.target.closest(".delete")) return;
      switchConversation(c.id);
      closeSidebar();
    });
    btn.querySelector(".rename")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = prompt("Judul percakapan:", c.title || "");
      if (next == null || !next.trim()) return;
      if (isLoggedIn()) {
        const updated = await apiRenameConversation(c.id, next.trim());
        if (updated) {
          await fetchConversationList();
          if (activeConvId === c.id) setChatTitle(updated.title);
          renderConvList();
        }
      } else {
        const store = loadAnonStore();
        if (store.threads[c.id]) {
          store.threads[c.id].title = next.trim();
          saveAnonStore(store);
          syncAnonListFromStore();
          if (activeConvId === c.id) setChatTitle(next.trim());
          renderConvList();
        }
      }
    });
    btn.querySelector(".delete")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Hapus percakapan ini?")) return;
      if (isLoggedIn()) {
        await apiDeleteConversation(c.id);
        if (activeConvId === c.id) {
          activeConvId = null;
          history = [];
          renderHistoryToUI();
          setChatTitle("AIRIN");
        }
        await fetchConversationList();
        renderConvList();
      } else {
        const store = loadAnonStore();
        delete store.threads[c.id];
        if (store.activeId === c.id) store.activeId = null;
        saveAnonStore(store);
        syncAnonListFromStore();
        if (!activeConvId) {
          history = [];
          renderHistoryToUI();
          setChatTitle("AIRIN");
        }
        renderConvList();
      }
    });
    el.convList.appendChild(btn);
  }
}

async function switchConversation(id) {
  if (!id || id === activeConvId) return;
  activeConvId = id;
  if (isLoggedIn()) {
    const conv = await fetchConversation(id);
    history = (conv?.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setChatTitle(conv?.title || "AIRIN");
  } else {
    const store = loadAnonStore();
    store.activeId = id;
    saveAnonStore(store);
    syncAnonListFromStore();
    const meta = conversations.find((c) => c.id === id);
    setChatTitle(meta?.title || "AIRIN");
  }
  renderHistoryToUI();
  renderConvList();
}

function renderHistoryToUI() {
  el.messages.innerHTML = "";
  updateStageEmpty();
  if (!history.length) return;
  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") {
      addMessage(m.role, m.content);
    }
  }
}

/* ── Sidebar mobile ── */
function openSidebar() {
  el.sidebar.classList.add("open");
  el.overlay.classList.add("visible");
  el.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("sidebar-open");
}
function closeSidebar() {
  el.sidebar.classList.remove("open");
  el.overlay.classList.remove("visible");
  el.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sidebar-open");
}
function toggleSidebar() {
  if (el.sidebar.classList.contains("open")) closeSidebar();
  else openSidebar();
}
el.menu?.addEventListener("click", toggleSidebar);
el.closeSidebar?.addEventListener("click", closeSidebar);
el.overlay?.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el.sidebar.classList.contains("open")) closeSidebar();
});

/* ── OAuth hash ── */
(function consumeHashToken() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const token = params.get("github_token");
  if (token) {
    githubToken = token;
    localStorage.setItem("airin_github_token", token);
    history.replaceState(null, "", location.pathname + location.search);
  }
})();

/* ── Health ── */
async function ping() {
  try {
    const r = await fetch(`${API()}/health`);
    el.online.classList.toggle("ok", r.ok);
    el.online.classList.toggle("err", !r.ok);
  } catch {
    el.online.classList.add("err");
    el.online.classList.remove("ok");
  }
}
ping();
setInterval(ping, 30000);

/* ── Messages ── */
function addMessage(role, content, extra = {}) {
  updateStageEmpty();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const roleIcon =
    role === "user"
      ? '<i class="fa-solid fa-user"></i> '
      : role === "assistant"
        ? '<i class="fa-solid fa-sparkles"></i> '
        : "";
  const roleLabel =
    role === "user" ? "Kamu" : role === "assistant" ? "AIRIN" : "";
  let html = roleLabel ? `<div class="role">${roleIcon}${roleLabel}</div>` : "";
  html += formatContent(content);
  if (extra.image) {
    html += `<img class="chat-img" src="${extra.image}" alt="Gambar terkirim" />`;
  }
  if (extra.tools?.length) {
    html +=
      '<div style="margin-top:0.5rem">' +
      extra.tools
        .map(
          (t) =>
            `<span class="tool-badge"><i class="fa-solid fa-wrench"></i> ${escapeHtml(t.name)}</span>`
        )
        .join("") +
      "</div>";
  }
  div.innerHTML = html;
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  el.stage.classList.remove("is-empty");
  return div;
}

function addSystem(text) {
  addMessage("system", text);
}

function formatContent(text) {
  if (!text) return "";
  let s = escapeHtml(text);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const label = (lang || "code").toLowerCase();
    return (
      `<div class="code-block">` +
      `<div class="code-block-header">` +
      `<span class="code-lang">${label}</span>` +
      `<button type="button" class="code-copy" title="Copy" aria-label="Copy code">` +
      `<i class="fa-regular fa-copy"></i>` +
      `</button>` +
      `</div>` +
      `<pre><code class="lang-${label}">${code.trim()}</code></pre>` +
      `</div>`
    );
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\n/g, "<br>");
  return s;
}

/* Copy button on code blocks (event delegation) */
el.messages?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  const block = btn.closest(".code-block");
  const codeEl = block?.querySelector("pre code");
  if (!codeEl) return;
  const text = codeEl.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add("copied");
    const icon = btn.querySelector("i");
    if (icon) {
      icon.classList.remove("fa-copy", "fa-regular");
      icon.classList.add("fa-solid", "fa-check");
    }
    btn.title = "Copied";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.title = "Copy";
      if (icon) {
        icon.classList.remove("fa-solid", "fa-check");
        icon.classList.add("fa-regular", "fa-copy");
      }
    }, 1600);
  } catch {
    /* fallback select */
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setBusy(v) {
  busy = v;
  el.send.disabled = v;
  el.input.disabled = v;
  const box = document.getElementById("composer");
  if (box) box.classList.toggle("is-typing", Boolean(v));
}

function showTyping() {
  el.stage.classList.remove("is-empty");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.id = "typing";
  div.innerHTML =
    '<div class="role"><i class="fa-solid fa-sparkles"></i> AIRIN</div><div class="typing"><span></span><span></span><span></span></div>';
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
}

function hideTyping() {
  document.getElementById("typing")?.remove();
}

/* ── Send ── */
async function send() {
  const text = el.input.value.trim();
  if ((!text && !pendingImageBase64) || busy) return;

  if (!activeConvId) {
    await createNewChat(false);
  }

  const userDisplay = text || "(gambar)";
  addMessage("user", userDisplay, {
    image: pendingImageBase64 ? el.imgPreview.src : null,
  });

  history.push({ role: "user", content: text || "[image uploaded]" });
  if (!isLoggedIn()) persistAnonActive();

  el.input.value = "";
  autoResize();

  const payload = {
    message: text || "Analisis gambar ini.",
    history: history.slice(0, -1).slice(-10),
    sessionId,
    conversationId: activeConvId || undefined,
    githubToken: githubToken || undefined,
  };
  if (pendingImageBase64) payload.imageBase64 = pendingImageBase64;

  clearImage();
  setBusy(true);
  showTyping();

  try {
    const res = await fetch(`${API()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    hideTyping();

    if (!res.ok) {
      const detail = data.detail || data.error || res.status;
      const hint = data.hint ? ` ${data.hint}` : "";
      addSystem(`Error: ${detail}${hint}`);
      return;
    }

    const reply = data.reply || "(kosong)";
    history.push({ role: "assistant", content: reply });
    addMessage("assistant", reply, { tools: data.toolCalls });

    if (data.conversationId) activeConvId = data.conversationId;
    if (data.conversationTitle) setChatTitle(data.conversationTitle);

    if (isLoggedIn()) {
      await fetchConversationList();
      renderConvList();
    } else {
      persistAnonActive();
      renderConvList();
    }
  } catch (err) {
    hideTyping();
    addSystem(`Gagal connect ke backend: ${err.message}. Cek AIRIN_API.`);
  } finally {
    setBusy(false);
    el.input.focus();
  }
}

/* ── Image ── */
function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageBase64 = reader.result;
    el.imgPreview.src = reader.result;
    el.previewArea.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  pendingImageBase64 = null;
  el.imgPreview.src = "";
  el.previewArea.classList.add("hidden");
  el.file.value = "";
}

/* ── GitHub ── */
function updateGhStatus() {
  if (githubToken) {
    el.ghStatus.innerHTML =
      '<i class="fa-solid fa-circle-check" style="color:#4ade80"></i> Connected' +
      (githubLogin ? ` · ${escapeHtml(githubLogin)}` : "");
    if (el.ghBtnLabel) el.ghBtnLabel.textContent = "Disconnect GitHub";
  } else {
    el.ghStatus.textContent = "Belum connect (anon · temporary)";
    if (el.ghBtnLabel) el.ghBtnLabel.textContent = "Connect GitHub";
  }
  updateUserCard();
  updateGreeting();
}

el.github.addEventListener("click", () => {
  if (githubToken) {
    githubToken = null;
    githubLogin = null;
    localStorage.removeItem("airin_github_token");
    history = [];
    conversations = [];
    activeConvId = null;
    initSessionId();
    updateGhStatus();
    syncAnonListFromStore();
    renderConvList();
    renderHistoryToUI();
    setChatTitle("AIRIN");
    return;
  }
  window.location.href = `${API()}/auth/github`;
});

/* ── New chat ── */
async function createNewChat(showWelcome = true) {
  history = [];
  if (isLoggedIn()) {
    const conv = await apiCreateConversation("Chat baru");
    activeConvId = conv.id;
    await fetchConversationList();
  } else {
    activeConvId = crypto.randomUUID();
    const store = loadAnonStore();
    const now = new Date().toISOString();
    store.threads[activeConvId] = {
      id: activeConvId,
      title: "Chat baru",
      createdAt: now,
      updatedAt: now,
      preview: "",
      messages: [],
    };
    store.activeId = activeConvId;
    saveAnonStore(store);
    syncAnonListFromStore();
  }
  setChatTitle("Chat baru");
  el.messages.innerHTML = "";
  updateStageEmpty();
  renderConvList();
  if (showWelcome) {
    /* empty state greeting is enough */
  }
}

el.newChat.addEventListener("click", async () => {
  await createNewChat(true);
  closeSidebar();
  el.input.focus();
});

/* ── Suggestion chips ── */
el.chips?.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const prompt = chip.getAttribute("data-prompt");
  if (!prompt) return;
  el.input.value = prompt;
  autoResize();
  el.input.focus();
  send();
});

/* ── Events ── */
el.send.addEventListener("click", send);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
el.input.addEventListener("input", autoResize);
function autoResize() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
}

el.file.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});
el.clearImg.addEventListener("click", clearImage);

document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) handleFile(f);
      break;
    }
  }
});

/* ── Boot ── */
(async function boot() {
  initSessionId();
  updateGhStatus();

  if (isLoggedIn()) {
    try {
      await fetchConversationList();
      if (conversations.length) {
        activeConvId = conversations[0].id;
        const conv = await fetchConversation(activeConvId);
        history = (conv?.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        setChatTitle(conv?.title || conversations[0].title);
      } else {
        activeConvId = null;
        history = [];
        setChatTitle("AIRIN");
      }
    } catch (e) {
      console.warn(e);
    }
  } else {
    syncAnonListFromStore();
    if (activeConvId) {
      const meta = conversations.find((c) => c.id === activeConvId);
      setChatTitle(meta?.title || "AIRIN");
    } else {
      setChatTitle("AIRIN");
    }
  }

  renderConvList();
  renderHistoryToUI();
  updateGhStatus();
  updateStageEmpty();
})();
