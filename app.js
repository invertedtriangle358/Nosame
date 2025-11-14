// =======================
// 1. 設定 (Constants)
// =======================
const MAX_POST_LENGTH = 108;
const EVENT_BUFFER_FLUSH_TIME_MS = 200;
const NOSTR_REQ_LIMIT = 30;
const NOSTR_REQ_SINCE_SECONDS_AGO = 3600;
const DEFAULT_RELAYS = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

let defaultNgWords = []; // JSON からロードされる初期禁句

// =======================
// 2. アプリケーション状態
// =======================
const state = {
  sockets: [],
  subId: null,
  seenEventIds: new Set(),
  reactedEventIds: new Set(),
  relayList: JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS],
  userNgWords: JSON.parse(localStorage.getItem("userNgWords")) || [],
};

// ==================
// 3. DOMキャッシュ
// ==================
const dom = {
  timeline: document.getElementById("timeline"),
  spinner: document.getElementById("subscribeSpinner"),
  relayListEl: document.getElementById("relayList"),
  sidePanel: document.getElementById("sidePanel"),
  panelOverlay: document.getElementById("panelOverlay"),
  composeFull: document.getElementById("composeFull"),
  composeSimple: document.getElementById("composeSimple"),
  composeSidebar: document.getElementById("composeSidebar"),
  charCount: document.getElementById("charCount"),
  charCountSidebar: document.getElementById("charCountSidebar"),
  btnPublish: document.getElementById("btnPublish"),
  btnPublishSimple: document.getElementById("btnPublishSimple"),
  btnPanelToggle: document.getElementById("btnPanelToggle"),
  btnPanelClose: document.getElementById("btnPanelClose"),
  btnAddRelay: document.getElementById("btnAddRelay"),
  btnSaveRelays: document.getElementById("btnSaveRelays"),
  btnScrollLeft: document.getElementById("scrollLeft"),
  btnScrollRight: document.getElementById("scrollRight"),
  relayInput: document.getElementById("relayInput"),
  btnAddNgWord: document.getElementById("btnAddNgWord"),
  btnSaveNgWords: document.getElementById("btnSaveNgWords"),
  ngWordInput: document.getElementById("ngWordInput"),
  ngWordListEl: document.getElementById("ngWordList"),
  relayListContainer: document.getElementById("relayList"),
};

// =======================
// 4. ユーティリティ関数
// =======================
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function isValidRelayUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "wss:" || u.protocol === "ws:") && !!u.hostname;
  } catch {
    return false;
  }
}

function getRelayStatusByUrl(url) {
  const normalized = normalizeUrl(url);
  const ws = state.sockets.find(s => normalizeUrl(s.url) === normalized);
  return ws && ws.readyState === WebSocket.OPEN;
}

function getAllNgWords() {
  return [...new Set([...(defaultNgWords || []), ...state.userNgWords])];
}

function isContentInvalid(text) {
  if (!text) return false;
  if (text.length > MAX_POST_LENGTH) return true;
  const allNg = getAllNgWords();
  const lower = text.toLowerCase();
  return allNg.some(ng => lower.includes(ng.toLowerCase()));
}

async function signEventWithNip07(event) {
  if (!window.nostr) throw new Error("NIP-07拡張機能が必要です。");
  return await window.nostr.signEvent(event);
}

function togglePanel(open) {
  if (!dom.sidePanel || !dom.panelOverlay) return;
  if (open) {
    dom.sidePanel.classList.add("open");
    dom.sidePanel.setAttribute("aria-hidden", "false");
    dom.panelOverlay.hidden = false;
    dom.panelOverlay.addEventListener("click", closePanelOnce);
    // 簡易投稿をクリア
    if (dom.composeSimple) dom.composeSimple.value = "";
  } else {
    dom.sidePanel.classList.remove("open");
    dom.sidePanel.setAttribute("aria-hidden", "true");
    dom.panelOverlay.hidden = true;
    dom.panelOverlay.removeEventListener("click", closePanelOnce);
  }
}
function closePanelOnce() { togglePanel(false); }

// =======================
// 5. NGワード関連
// =======================
function updateNgWordList() {
  if (!dom.ngWordListEl) return;
  dom.ngWordListEl.innerHTML = "";

  // state.userNgWords が表示される（初回ロード時に default をコピーしている）
  state.userNgWords.forEach((word, index) => {
    const row = document.createElement("div");
    row.className = "ng-word-item";

    const input = document.createElement("input");
    input.type = "text";
    input.value = word;
    input.addEventListener("input", e => {
      state.userNgWords[index] = e.target.value;
    });

    const btn = document.createElement("button");
    btn.className = "btn-delete-ng";
    btn.textContent = "✖";
    btn.title = "削除";
    btn.addEventListener("click", () => {
      state.userNgWords.splice(index, 1);
      updateNgWordList();
    });

    row.appendChild(input);
    row.appendChild(btn);
    dom.ngWordListEl.appendChild(row);
  });
}

function addNgWord(word) {
  const trimmed = (word || "").trim();
  if (!trimmed) return alert("空のNGワードは登録できません。");
  const lower = trimmed.toLowerCase();
  if (state.userNgWords.some(w => w.toLowerCase() === lower)) return alert("すでに登録済みのNGワードです。");

  state.userNgWords.push(trimmed);
  updateNgWordList();
  if (dom.ngWordInput) dom.ngWordInput.value = "";
}

// load NG words from JSON (async)
async function loadNgWords() {
  try {
    const res = await fetch(`./ngwords.json?${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    defaultNgWords = Array.isArray(json) ? json : [];

    // 初回起動時: ローカルストレージに userNgWords が無ければ default をコピー
    const saved = JSON.parse(localStorage.getItem("userNgWords") || "null");
    if (!saved || saved.length === 0) {
      state.userNgWords = [...defaultNgWords];
      localStorage.setItem("userNgWords", JSON.stringify(state.userNgWords));
    } else {
      state.userNgWords = saved;
    }
  } catch (err) {
    console.warn("⚠ NGワードJSONの読み込みに失敗しました:", err);
    // 継続（state.userNgWords には既に何か入っている可能性あり）
  } finally {
    updateNgWordList();
  }
}

// =======================
// 6. リレー関連（UI更新/検証）
function updateRelayModalList() {
  if (!dom.relayListContainer) return;
  dom.relayListContainer.innerHTML = "";

  state.relayList.forEach((url, index) => {
    const row = document.createElement("div");
    row.className = "relay-row";

    const status = document.createElement("span");
    status.className = "relay-status";
    status.textContent = getRelayStatusByUrl(url) ? "🟢" : "🔴";

    const input = document.createElement("input");
    input.type = "text";
    input.value = url;
    input.addEventListener("input", e => {
      state.relayList[index] = e.target.value.trim();
    });

    const btn = document.createElement("button");
    btn.className = "btn-delete-relay";
    btn.textContent = "✖";
    btn.title = "削除";
    btn.addEventListener("click", () => {
      state.relayList.splice(index, 1);
      updateRelayModalList();
    });

    row.appendChild(status);
    row.appendChild(input);
    row.appendChild(btn);
    dom.relayListContainer.appendChild(row);
  });
}

function addRelayUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return alert("URLを入力してください。");
  if (state.relayList.some(u => u.toLowerCase() === trimmed.toLowerCase())) return alert("すでに登録済みのURLです。");
  if (!isValidRelayUrl(trimmed)) return alert("無効なリレーURLです。wss:// または ws:// で始まる必要があります。");

  state.relayList.push(trimmed);
  updateRelayModalList();
  if (dom.relayInput) dom.relayInput.value = "";
}

// ===========================
// 7. Nostrコアロジック (connect / buffer / sendReq / publish)
// ===========================
let relayListUpdateTimer, eventBuffer = [], bufferTimer = null;

function delayedUpdateRelayList() {
  clearTimeout(relayListUpdateTimer);
  relayListUpdateTimer = setTimeout(updateRelayModalList, 150);
}

function connectToRelays() {
  state.sockets.forEach(ws => ws.close());
  state.sockets = [];

  state.relayList.forEach(url => {
    if (!url) return;
    try {
      const ws = new WebSocket(url);
      // store url for status lookup
      ws.url = url;
      state.sockets.push(ws);

      ws.onopen = () => {
        console.log("✅ 接続:", url);
        delayedUpdateRelayList();
        if (state.subId) sendReq(ws);
      };
      ws.onclose = () => { console.log("🔌 切断:", url); delayedUpdateRelayList(); };
      ws.onerror = err => { console.error("❌ エラー:", url, err); delayedUpdateRelayList(); };
      ws.onmessage = handleMessage;
    } catch (e) {
      console.error("接続失敗:", url, e);
    }
  });

  delayedUpdateRelayList();
}

function handleMessage(ev) {
  try {
    const [type, subId, event] = JSON.parse(ev.data);
    if (type !== "EVENT" || !event) return;
    if (state.seenEventIds.has(event.id) || isContentInvalid(event.content)) return;

    state.seenEventIds.add(event.id);
    bufferEvent(event);
  } catch (e) {
    console.error("メッセージ処理失敗:", e, ev.data);
  }
}

function bufferEvent(event) {
  eventBuffer.push(event);
  if (!bufferTimer) bufferTimer = setTimeout(flushEventBuffer, EVENT_BUFFER_FLUSH_TIME_MS);
}

function flushEventBuffer() {
  eventBuffer
    .sort((a, b) => a.created_at - b.created_at)
    .forEach(event => renderEvent(event));
  eventBuffer = [];
  bufferTimer = null;
}

function sendReq(ws) {
  if (!ws || !state.subId) return;
  const filter = {
    kinds: [1],
    limit: NOSTR_REQ_LIMIT,
    since: Math.floor(Date.now() / 1000) - NOSTR_REQ_SINCE_SECONDS_AGO
  };
  const req = ["REQ", state.subId, filter];
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(req));
      console.log("📤 REQ送信:", ws.url, req);
    } catch (e) {
      console.error("REQ送信失敗:", ws.url, e);
    }
  } else {
    ws.addEventListener("open", () => sendReq(ws), { once: true });
  }
}

function publishEvent(event) {
  const payload = JSON.stringify(["EVENT", event]);
  let count = 0;
  state.sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
        console.log(`📤 EVENT送信: ${event.id?.slice?.(0,5) || "?"}... -> ${ws.url}`);
        count++;
      } catch (e) {
        console.error("EVENT送信失敗:", ws.url, e);
      }
    }
  });
  if (count === 0) alert("接続中のリレーがありません。");
}

function startSubscription() {
  state.subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`🚀 購読開始: ${state.subId}`);
  if (dom.spinner) dom.spinner.style.display = "inline-block";

  dom.timeline && (dom.timeline.innerHTML = "");
  state.seenEventIds.clear();
  state.sockets.forEach(sendReq);
}

// ============================
// 8. UIロジック (render + formatContent safe)
const specialWords = [
  { word: "【緊急地震速報】", color: "#e63946" },
];

function formatContent(text) {
  // 1) escape
  let safe = escapeHtml(text || "");
  // 2) colorize special words (escape the word for regex)
  for (const { word, color } of specialWords) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${esc})`, "g");
    safe = safe.replace(re, `<span style="color:${color}">$1</span>`);
  }
  return safe;
}

function renderEvent(event) {
  if (!dom.timeline) return;
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.dataset.createdAt = event.created_at;

  const isReacted = state.reactedEventIds.has(event.id);

  noteEl.innerHTML = `
    <div class="content">${formatContent(event.content)}</div>
    <div class="meta">
      <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
      <span class="author">${escapeHtml((event.pubkey || "").slice(0,8))}...</span>
    </div>
    <button class="btn-reaction" data-id="${event.id}" ${isReacted ? "disabled" : ""}>${isReacted ? "♥" : "♡"}</button>
  `;

  const btn = noteEl.querySelector(".btn-reaction");
  btn && btn.addEventListener("click", () => handleReactionClick(event));

  const children = Array.from(dom.timeline.children || []);
  const insertPos = children.find(el => Number(el.dataset.createdAt) < event.created_at);
  insertPos ? dom.timeline.insertBefore(noteEl, insertPos) : dom.timeline.appendChild(noteEl);
}

// ============================
// 9. 投稿・リアクション
// ============================
function updateReactionButton(eventId) {
  const btn = document.querySelector(`.btn-reaction[data-id="${eventId}"]`);
  if (btn) { btn.textContent = "❤️"; btn.disabled = true; }
}

async function handlePublish(contentSource) {
  // contentSource: 'full' | 'simple' | 'sidebar'
  let content = "";
  if (contentSource === "full") content = dom.composeFull?.value?.trim() || "";
  else if (contentSource === "simple") content = dom.composeSimple?.value?.trim() || "";
  else content = dom.composeSidebar?.value?.trim() || "";

  if (!content) return alert("本文を入力してください。");
  if (isContentInvalid(content)) return alert("NGワードまたは文字数制限を超えています。");
  if (!window.nostr) return alert("NIP-07対応拡張機能が必要です。");

  try {
    const pubkey = await window.nostr.getPublicKey();
    const newEvent = { kind:1, content, created_at: Math.floor(Date.now()/1000), tags: [], pubkey };
    const signedEvent = await signEventWithNip07(newEvent);
    publishEvent(signedEvent);

    if (!state.seenEventIds.has(signedEvent.id)) {
      state.seenEventIds.add(signedEvent.id);
      renderEvent(signedEvent);
    }

    // clear relevant input(s)
    if (contentSource === "full") { if (dom.composeFull) dom.composeFull.value = ""; if (dom.charCount) dom.charCount.textContent = `0 / ${MAX_POST_LENGTH}`; }
    if (contentSource === "simple") { if (dom.composeSimple) dom.composeSimple.value = ""; }
    if (contentSource === "sidebar") { if (dom.composeSidebar) dom.composeSidebar.value = ""; if (dom.charCountSidebar) dom.charCountSidebar.textContent = `0 / ${MAX_POST_LENGTH}`; }

  } catch (err) {
    console.error("投稿失敗:", err);
    alert(`投稿失敗: ${err.message}`);
  }
}

async function handleReactionClick(targetEvent) {
  if (state.reactedEventIds.has(targetEvent.id)) return;
  try {
    const pubkey = await window.nostr.getPublicKey();
    const reactionEvent = { kind:7, content:"+", created_at: Math.floor(Date.now()/1000), tags:[["e", targetEvent.id], ["p", targetEvent.pubkey]], pubkey };
    const signedEvent = await signEventWithNip07(reactionEvent);
    publishEvent(signedEvent);
    state.reactedEventIds.add(targetEvent.id);
    updateReactionButton(targetEvent.id);
  } catch (err) {
    console.error("リアクション失敗:", err);
    alert(`リアクション失敗: ${err.message}`);
  }
}

// ============================
// 10. イベントリスナー・初期化
// ============================
function setupEventListeners() {
  // panel toggle
  dom.btnPanelToggle?.addEventListener("click", () => togglePanel(true));
  dom.btnPanelClose?.addEventListener("click", () => togglePanel(false));

  // panel overlay handled in togglePanel

  // relay controls
  dom.btnAddRelay?.addEventListener("click", () => addRelayUrl(dom.relayInput.value));
  dom.btnSaveRelays?.addEventListener("click", () => {
    state.relayList = state.relayList.filter(u => u && u.trim());
    localStorage.setItem("relays", JSON.stringify(state.relayList));
    alert("リレー設定を保存しました。再接続します。");
    togglePanel(false);
    connectToRelays();
    startSubscription();
  });

  // ng word controls
  dom.btnAddNgWord?.addEventListener("click", () => addNgWord(dom.ngWordInput.value));
  dom.btnSaveNgWords?.addEventListener("click", () => {
    state.userNgWords = state.userNgWords.map(w => w.trim()).filter(Boolean);
    localStorage.setItem("userNgWords", JSON.stringify(state.userNgWords));
    updateNgWordList();
    alert("NGワードを保存しました。");
  });

  // simple publish
  dom.btnPublishSimple?.addEventListener("click", () => handlePublish("simple"));
  // full publish (panel)
  dom.btnPublish?.addEventListener("click", () => handlePublish("full"));

  // sidebar publish (vertical)
  const sidebarPublishBtn = document.getElementById("btnPublish"); // id reused for panel; keep behavior safe
  // note: sidebar vertical publish could be same id in original; user kept only panel publish id; keep sidebar publish via keyboard or not.

  // timeline scrolling
  dom.btnScrollLeft?.addEventListener("click", () => dom.timeline.scrollBy({ left:-300, behavior:"smooth" }));
  dom.btnScrollRight?.addEventListener("click", () => dom.timeline.scrollBy({ left:300, behavior:"smooth" }));

  // char counters
  dom.composeFull?.addEventListener("input", e => {
    const len = e.target.value.length;
    if (dom.charCount) dom.charCount.textContent = `${len} / ${MAX_POST_LENGTH}`;
    dom.charCount.style.color = len > MAX_POST_LENGTH ? "red" : "";
  });
  dom.composeSidebar?.addEventListener("input", e => {
    const len = e.target.value.length;
    if (dom.charCountSidebar) dom.charCountSidebar.textContent = `${len} / ${MAX_POST_LENGTH}`;
    dom.charCountSidebar.style.color = len > MAX_POST_LENGTH ? "red" : "";
  });

  // allow Enter key to submit simple compose
  dom.composeSimple?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); handlePublish("simple"); }
  });
}

// ============================
// 11. アプリ起動
// ============================
window.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadNgWords();           // 必ず先に NG ワードを読み込む（初期化）
  updateRelayModalList();
  connectToRelays();
  startSubscription();
});
