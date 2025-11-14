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

// ✅ defaultNgWordsのみ残す（userNgWords変数削除）
let defaultNgWords = []; 

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
  relayListEl: document.getElementById("relayList"),
  relayModal: document.getElementById("relayModal"),
  composeArea: document.getElementById("compose"),
  charCount: document.getElementById("charCount"),
  btnPublish: document.getElementById("btnPublish"),
  btnRelayModal: document.getElementById("btnRelayModal"),
  btnCloseModal: document.getElementById("btnCloseModal"),
  btnAddRelay: document.getElementById("btnAddRelay"),
  btnSaveRelays: document.getElementById("btnSaveRelays"),
  btnScrollLeft: document.getElementById("scrollLeft"),
  btnScrollRight: document.getElementById("scrollRight"),
  relayInput: document.getElementById("relayInput"),
  btnNgModal: document.getElementById("btnNgModal"),
  ngModal: document.getElementById("ngModal"),
  btnAddNgWord: document.getElementById("btnAddNgWord"),
  btnSaveNgWords: document.getElementById("btnSaveNgWords"),
  btnCloseNgModal: document.getElementById("btnCloseNgModal"),
  ngWordInput: document.getElementById("ngWordInput"),
  ngWordListEl: document.getElementById("ngWordList"),
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
  return [...new Set([...defaultNgWords, ...state.userNgWords])];
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

function toggleModal(modalEl, open = true) {
  if (!modalEl) return;
  modalEl.style.display = open ? "block" : "none";
  modalEl.setAttribute("aria-hidden", String(!open));
  document.body.style.overflow = open ? "hidden" : "";
}

// =======================
// 5. NGワード関連
// =======================

function updateNgWordList() {
  if (!dom.ngWordListEl) return;
  dom.ngWordListEl.innerHTML = "";

  // --- デフォルトNGワード（削除不可） ---
  defaultNgWords.forEach(word => {
    const row = document.createElement("div");
    row.className = "ng-word-item ng-default";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(word)}" disabled>
      <button disabled style="opacity:0.4;">✖</button>
    `;
    dom.ngWordListEl.appendChild(row);
  });

  // --- ユーザー追加分（編集・削除可） ---
  state.userNgWords.forEach((word, index) => {
    const row = document.createElement("div");
    row.className = "ng-word-item";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(word)}">
      <button class="btn-delete-ng" data-index="${index}">✖</button>
    `;
    row.querySelector("input").addEventListener("input", e => {
      state.userNgWords[index] = e.target.value.trim();
    });
    dom.ngWordListEl.appendChild(row);
  });
}


function addNgWord(word) {
  const trimmed = word.trim().toLowerCase();
  if (!trimmed) return alert("空のNGワードは登録できません。");
  if (state.userNgWords.includes(trimmed)) return alert("すでに登録済みのNGワードです。");

  state.userNgWords.push(trimmed);
  updateNgWordList();
  dom.ngWordInput.value = "";
}

// fetch処理を専用のasync関数に切り出す
async function loadNgWords() {
  try {
    const res = await fetch(`./ngwords.json?${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    console.log("✅ NGワードJSONを読み込みました:", json);
    defaultNgWords = json; // グローバル変数を更新

    // 初回のみ userNgWords を初期化
    const saved = JSON.parse(localStorage.getItem("userNgWords") || "null");
    if (!saved || saved.length === 0) {
      state.userNgWords = [...json];
      localStorage.setItem("userNgWords", JSON.stringify(state.userNgWords));
    } else {
      state.userNgWords = saved;
    }

  } catch (err) {
    console.warn("⚠ NGワードJSONの読み込みに失敗しました:", err);
    // エラーが発生しても、デフォルトNGワードが空の状態でアプリの実行を継続する
  }
}

const specialWords = [
  { word: "【緊急地震速報】", color: "#e63946" },
];

function formatContent(text) {
  // ① HTMLタグをすべてエスケープ
  let safeText = escapeHtml(text);

  // ② 特定ワードの色変更（安全な状態で行う）
  for (const { word, color } of specialWords) {
    const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g");
    safeText = safeText.replace(regex, `<span style="color:${color}">$1</span>`);
  }

  return safeText;
}

// =======================
// 6. リレー関連
// =======================
function updateRelayModalList() {
  if (!dom.relayListEl) return;
  dom.relayListEl.innerHTML = "";

  state.relayList.forEach((url, index) => {
    const row = document.createElement("div");
    row.className = "relay-row";
    const status = getRelayStatusByUrl(url) ? "🟢" : "🔴";
    row.innerHTML = `
      <span class="relay-status">${status}</span>
      <input type="text" value="${escapeHtml(url)}">
      <button class="btn-delete-relay" data-index="${index}">✖</button>
    `;
    row.querySelector("input").addEventListener("input", e => {
      state.relayList[index] = e.target.value.trim();
    });
    dom.relayListEl.appendChild(row);
  });
}

function addRelayUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return alert("URLを入力してください。");
  if (state.relayList.some(u => u.toLowerCase() === trimmed.toLowerCase())) {
    return alert("すでに登録済みのURLです。");
  }
  if (!isValidRelayUrl(trimmed)) {
    return alert("無効なリレーURLです。wss:// または ws:// で始まる必要があります。");
  }
  state.relayList.push(trimmed);
  updateRelayModalList();
  dom.relayInput.value = "";
}

// ===========================
// 7. Nostrコアロジック
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
      state.sockets.push(ws);

      ws.onopen = () => {
        console.log("✅ 接続:", url);
        delayedUpdateRelayList();
        if (state.subId) sendReq(ws);
      };
      ws.onclose = () => {
        console.log("🔌 切断:", url);
        delayedUpdateRelayList();
      };
      ws.onerror = err => {
        console.error("❌ エラー:", url, err);
        delayedUpdateRelayList();
      };
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
  // 200 を定数に置き換え
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
    // 30 と 3600 を定数に置き換え
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
        console.log(`📤 EVENT送信: ${event.id.slice(0, 5)}... -> ${ws.url}`);
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

  dom.timeline.innerHTML = "";
  state.seenEventIds.clear();

  state.sockets.forEach(sendReq);
}

// ============================
// 8. UIロジック
// ============================
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.dataset.createdAt = event.created_at;

  const isReacted = state.reactedEventIds.has(event.id);
  noteEl.innerHTML = `
    <div class="content">${formatContent(event.content)}</div>
    <div class="meta">
      <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
      <span class="author">${escapeHtml(event.pubkey.slice(0, 8))}...</span>
    </div>
    <button class="btn-reaction" data-id="${event.id}" ${isReacted ? "disabled" : ""}>
      ${isReacted ? "♥" : "♡"}
    </button>
  `;

  noteEl.querySelector(".btn-reaction")
    .addEventListener("click", () => handleReactionClick(event));

  const children = Array.from(dom.timeline.children);
  const insertPos = children.find(el => Number(el.dataset.createdAt) < event.created_at);
  insertPos ? dom.timeline.insertBefore(noteEl, insertPos) : dom.timeline.appendChild(noteEl);

}

// ============================
// 9. 投稿・リアクション
// ============================
function updateReactionButton(eventId) {
  const btn = document.querySelector(`.btn-reaction[data-id="${eventId}"]`);
  if (btn) {
    btn.textContent = "❤️";
    btn.disabled = true;
  }
}

async function handlePublishClick() {
  const content = dom.composeArea.value.trim();
  if (!content) return alert("本文を入力してください。");
  if (isContentInvalid(content)) return alert("NGワードまたは文字数制限を超えています。");
  if (!window.nostr) return alert("NIP-07対応拡張機能が必要です。");

  try {
    const pubkey = await window.nostr.getPublicKey();
    const newEvent = {
      kind: 1,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey,
    };
    const signedEvent = await signEventWithNip07(newEvent);
    publishEvent(signedEvent);

    if (!state.seenEventIds.has(signedEvent.id)) {
      state.seenEventIds.add(signedEvent.id);
      renderEvent(signedEvent);
    }

    dom.composeArea.value = "";
    dom.charCount.textContent = `0 / ${MAX_POST_LENGTH}`;
  } catch (err) {
    console.error("投稿失敗:", err);
    alert(`投稿失敗: ${err.message}`);
  }
}

async function handleReactionClick(targetEvent) {
  if (state.reactedEventIds.has(targetEvent.id)) return;

  try {
    const pubkey = await window.nostr.getPublicKey();
    const reactionEvent = {
      kind: 7,
      content: "+",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
      pubkey,
    };

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
  dom.btnPublish?.addEventListener("click", handlePublishClick);

  // --- モダール共通 ---
  dom.btnRelayModal?.addEventListener("click", () => {
    toggleModal(dom.relayModal, true);
    updateRelayModalList();
  });
  dom.btnCloseModal?.addEventListener("click", () => toggleModal(dom.relayModal, false));

  dom.btnNgModal?.addEventListener("click", () => {
    toggleModal(dom.ngModal, true);
    updateNgWordList();
  });
  dom.btnCloseNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, false));

  // ESCで全モダールを閉じる
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      [dom.relayModal, dom.ngModal].forEach(m => toggleModal(m, false));
    }
  });

  // 背景クリックで閉じる
  document.querySelectorAll(".modal").forEach(modal => {
    modal.addEventListener("click", e => {
      if (e.target === modal) toggleModal(modal, false);
    });
  });

  // --- リレー操作 ---
  dom.btnAddRelay?.addEventListener("click", () => addRelayUrl(dom.relayInput.value));
  dom.relayListEl?.addEventListener("click", e => {
    if (e.target.classList.contains("btn-delete-relay")) {
      state.relayList.splice(Number(e.target.dataset.index), 1);
      updateRelayModalList();
    }
  });
  dom.btnSaveRelays?.addEventListener("click", () => {
    state.relayList = state.relayList.filter(url => url);
    localStorage.setItem("relays", JSON.stringify(state.relayList));
    alert("リレー設定を保存しました。再接続します。");
    toggleModal(dom.relayModal, false);
    connectToRelays();
    startSubscription();
  });

  // --- NGワード操作 ---
  dom.btnAddNgWord?.addEventListener("click", () => addNgWord(dom.ngWordInput.value));
  dom.ngWordListEl?.addEventListener("click", e => {
    if (e.target.classList.contains("btn-delete-ng")) {
      state.userNgWords.splice(Number(e.target.dataset.index), 1);
      updateNgWordList();
    }
  });

  dom.btnSaveNgWords?.addEventListener("click", () => {
    state.userNgWords = state.userNgWords.filter(w => w.trim());
    localStorage.setItem("userNgWords", JSON.stringify(state.userNgWords));
    alert("NGワードを保存しました。");
    updateNgWordList(); // ✅ 追加：即時反映
  });

  // --- タイムライン操作 ---
  dom.btnScrollLeft?.addEventListener("click", () =>
    dom.timeline.scrollBy({ left: -300, behavior: "smooth" })
  );
  dom.btnScrollRight?.addEventListener("click", () =>
    dom.timeline.scrollBy({ left: 300, behavior: "smooth" })
  );

  dom.composeArea?.addEventListener("input", e => {
    const len = e.target.value.length;
    dom.charCount.textContent = `${len} / ${MAX_POST_LENGTH}`;
    dom.charCount.style.color = len > MAX_POST_LENGTH ? "red" : "";
  });
}

// ============================
// 11. アプリ起動
// ============================
window.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();

  // ⚠ NGワードの読み込みが完了するまで待つ
  await loadNgWords(); 

  // 読み込み完了後に接続と購読を開始する
  connectToRelays();
  startSubscription();
});
