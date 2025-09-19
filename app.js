// 1. 設定 (Constants)
const MAX_POST_LENGTH = 108;
const NG_WORDS = [
  "キチガイ", "ガイジ", "ケンモ", "嫌儲", "右翼", "左翼", "ウヨ", "サヨ", "パヨク",
  "与党", "野党", "在日", "クルド", "死ね", "殺す", "クソ", "ログボ", "チカラコブ", "スジャータ", "ｴﾄﾞｳｨﾝ", "かまどのお菓子", "fuck", "shit",
  "sex", "porn", "gay", "ass", "dick", "pussy", "CP", "mempool", "Bottlesky",
  "http://", "https://"
];
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

// =======================
// 2. アプリケーション状態
// =======================
const state = {
  sockets: [],
  subId: null,
  seenEventIds: new Set(),
  reactedEventIds: new Set(),
  relayList: JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS],
};

// イベントバッファ
let eventBuffer = [];
let bufferTimer = null;

// ==================
// 3. DOMキャッシュ
// ==================
const dom = {
  timeline: document.getElementById("timeline"),
  spinner: document.getElementById("subscribeSpinner"),
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
};

// =======================
// 4. ユーティリティ関数
// =======================

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
  );
}

function isContentInvalid(text) {
  if (!text) return false;
  if (text.length > MAX_POST_LENGTH) return true;
  const lower = text.toLowerCase();
  return NG_WORDS.some(ng => lower.includes(ng.toLowerCase()));
}

function getRelayStatusByUrl(url) {
  const ws = state.sockets.find(s => s.url === url);
  return ws && ws.readyState === WebSocket.OPEN;
}

async function signEventWithNip07(event) {
  if (!window.nostr) throw new Error("NIP-07拡張機能が必要です。");
  return await window.nostr.signEvent(event);
}

// ===========================
// 5. Nostrコアロジック
// ===========================

function connectToRelays() {
  state.sockets.forEach(ws => ws.close());
  state.sockets = [];

  state.relayList.forEach(url => {
    if (!url) return;
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("✅ 接続:", url);
        updateRelayModalList();
        if (state.subId) sendReq(ws);
      };

      ws.onmessage = handleMessage;
      ws.onclose = () => { console.log("🔌 切断:", url); updateRelayModalList(); };
      ws.onerror = err => { console.error("❌ エラー:", url, err); updateRelayModalList(); };

      state.sockets.push(ws);
    } catch (e) {
      console.error("接続失敗:", url, e);
    }
  });

  updateRelayModalList();
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
  if (!bufferTimer) bufferTimer = setTimeout(flushEventBuffer, 200);
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

  const filter = { kinds: [1], limit: 50, since: Math.floor(Date.now() / 1000) - 3600 };
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
  dom.spinner.style.display = "block";

  dom.timeline.innerHTML = "";
  state.seenEventIds.clear();

  state.sockets.forEach(sendReq);
  setTimeout(() => (dom.spinner.style.display = "none"), 2000);
}

// ============================
// 6. UIロジック
// ============================

function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.dataset.createdAt = event.created_at;

  const isReacted = state.reactedEventIds.has(event.id);
  const buttonHtml = `
    <button class="btn-reaction" data-id="${event.id}" ${isReacted ? "disabled" : ""}>
      ${isReacted ? "❤️" : "♡"}
    </button>
  `;

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">
      <span class="author">${escapeHtml(event.pubkey.slice(0, 8))}...</span>
      <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
    </div>
    ${buttonHtml}
  `;

  noteEl.querySelector(".btn-reaction")
    .addEventListener("click", () => handleReactionClick(event));

  const children = Array.from(dom.timeline.children);
  const insertPos = children.find(el => Number(el.dataset.createdAt) < event.created_at);

  insertPos ? dom.timeline.insertBefore(noteEl, insertPos) : dom.timeline.appendChild(noteEl);

  dom.timeline.scrollLeft = dom.timeline.scrollWidth;
  dom.spinner.style.display = "none";
}

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

function setupEventListeners() {
  dom.btnPublish?.addEventListener("click", handlePublishClick);

  // リレーモーダル関連
  dom.btnRelayModal?.addEventListener("click", () => {
    dom.relayModal.style.display = "block";
    updateRelayModalList();
  });
  dom.btnCloseModal?.addEventListener("click", () => dom.relayModal.style.display = "none");
  dom.btnAddRelay?.addEventListener("click", () => {
    const url = dom.relayInput.value.trim();
    if (url && !state.relayList.includes(url)) {
      state.relayList.push(url);
      updateRelayModalList();
      dom.relayInput.value = "";
    }
  });
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
    dom.relayModal.style.display = "none";
    connectToRelays();
  });

  // スクロール
  dom.btnScrollLeft?.addEventListener("click", () =>
    dom.timeline.scrollBy({ left: -300, behavior: "smooth" })
  );
  dom.btnScrollRight?.addEventListener("click", () =>
    dom.timeline.scrollBy({ left: 300, behavior: "smooth" })
  );

  // 文字数カウンター
  dom.composeArea?.addEventListener("input", () => {
    const len = dom.composeArea.value.length;
    dom.charCount.textContent = `${len} / ${MAX_POST_LENGTH}`;
  });
}

// ============================
// 7. 初期化処理
// ============================

function main() {
  setupEventListeners();
  connectToRelays();
  setTimeout(startSubscription, 500);
}

window.addEventListener("DOMContentLoaded", main);
