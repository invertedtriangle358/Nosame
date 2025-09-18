// 1. 設定 (Constants)
const MAX_POST_LENGTH = 80;
const NG_WORDS = [
  "キチガイ", "ガイジ", "ケンモ", "嫌儲", "右翼", "左翼", "ウヨ", "サヨ", "パヨク",
  "与党", "野党", "在日", "クルド", "死ね", "殺す", "クソ", "fuck", "shit",
  "sex", "porn", "gay", "ass", "dick", "pussy", "CP", "mempool",
  "http://", "https://"
];
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

// 2. アプリケーションの状態管理 (State)
const state = {
  sockets: [],
  subId: null,
  seenEventIds: new Set(),
  reactedEventIds: new Set(),
  relayList: JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS],
};

// 追加: イベントバッファ
let eventBuffer = [];
let bufferTimer = null;

// 3. DOM要素のキャッシュ
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

// --- 中略 (Utilities 部分は既存のまま) ---

/**
 * リレーからのメッセージを処理する
 */
function handleMessage(ev) {
  try {
    const [type, subId, event] = JSON.parse(ev.data);
    if (type !== "EVENT" || !event) return;

    if (state.seenEventIds.has(event.id) || isContentInvalid(event.content)) return;
    state.seenEventIds.add(event.id);

    bufferEvent(event); // ← 直接描画せずバッファに積む
  } catch (e) {
    console.error("メッセージ処理失敗:", e, ev.data);
  }
}

/**
 * イベントをバッファに追加
 */
function bufferEvent(event) {
  eventBuffer.push(event);
  if (!bufferTimer) {
    bufferTimer = setTimeout(flushEventBuffer, 200);
  }
}

/**
 * バッファを flush して描画
 */
function flushEventBuffer() {
  eventBuffer.sort((a, b) => a.created_at - b.created_at); // 古い順
  eventBuffer.forEach(event => renderEvent(event));

  eventBuffer = [];
  bufferTimer = null;
}

/**
 * REQ送信
 */
function sendReq(ws) {
  if (!ws || !state.subId) return;

  // 最新100件のみ
  const filter = { kinds: [1], limit: 100 };
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

/**
 * イベント描画
 */
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  noteEl.dataset.createdAt = event.created_at;

  const isReacted = state.reactedEventIds.has(event.id);
  const reactionButtonText = isReacted ? "❤️" : "♡";
  const reactionButtonDisabled = isReacted ? "disabled" : "";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">
      <span class="author">${escapeHtml(event.pubkey.slice(0, 8))}...</span>
      <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
    </div>
    <button class="btn-reaction" data-id="${event.id}" ${reactionButtonDisabled}>
      ${reactionButtonText}
    </button>
  `;

  noteEl.querySelector(".btn-reaction").addEventListener("click", () => handleReactionClick(event));

  // === created_at 順に正しく挿入 ===
  const children = Array.from(dom.timeline.children);
  const insertPos = children.find(el => Number(el.dataset.createdAt) > event.created_at);

  if (insertPos) {
    dom.timeline.insertBefore(noteEl, insertPos);
  } else {
    dom.timeline.appendChild(noteEl);
  }

  dom.timeline.scrollLeft = dom.timeline.scrollWidth; // 常に右端へ
  dom.spinner.style.display = "none";
}
