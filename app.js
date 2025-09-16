// ==== 定数設定 ==== //
const MAX_LENGTH = 41;
const NG_WORDS = [
  "キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","与党","野党","在日","クルド",
  "fuck","shit","sex","porn","gay","ass","dick","pussy","CP","mempool","http://","https://"
];
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

// ==== 状態管理 ==== //
let sockets = [];
let subId = null;
const seenEvents = new Set();
let relayListState = JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS];

// DOM要素キャッシュ
const timeline = document.getElementById("timeline");
const spinner = document.getElementById("subscribeSpinner");

// ==== ユーティリティ ==== //
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
  );
}

function isBlocked(text) {
  if (!text) return false;
  if (text.length > MAX_LENGTH) return true;
  const lowered = text.toLowerCase();
  return NG_WORDS.some(word => lowered.includes(word.toLowerCase()));
}

// ==== リレー接続処理 ==== //
function connectRelays(relayStr) {
  sockets.forEach(ws => ws.close?.());
  sockets = [];

  const relays = relayStr.split(",").map(s => s.trim()).filter(Boolean);
  relays.forEach(url => {
    try {
      const ws = new WebSocket(url);
      ws._url = url;

      ws.onopen = () => {
        console.log("接続成功:", url);
        updateRelayListStatus();
        if (subId) subscribeTo(ws);
      };
      ws.onmessage = onMessage;
      ws.onclose = () => { console.log("切断:", url); updateRelayListStatus(); };
      ws.onerror  = () => { console.log("エラー:", url); updateRelayListStatus(); };

      sockets.push(ws);
    } catch (e) {
      console.error("WebSocket error:", e);
    }
  });

  updateRelayListStatus();
  populateRelayList();
}

// ==== イベント処理 ==== //
function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    console.log("受信:", msg);
    if (msg[0] === "EVENT") {
      const event = msg[2];
      if (!event || seenEvents.has(event.id) || isBlocked(event.content)) return;
      seenEvents.add(event.id);
      renderEvent(event);
    }
  } catch (e) {
    console.error("JSON parse error:", e, ev.data);
  }
}

function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">${new Date(event.created_at * 1000).toLocaleString()}</div>
    <div class="author">${event.pubkey.slice(0, 8)}...</div>
  `;

  timeline.appendChild(noteEl);
  timeline.scrollLeft = timeline.scrollWidth; // 右端にスクロール
}

// ==== 購読 ==== //
function subscribeTo(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !subId) return;
  const filter = { kinds: [1], limit: 50 };
  console.log("REQ送信:", ws._url, subId, filter);
  try {
    ws.send(JSON.stringify(["REQ", subId, filter]));
  } catch (e) {
    console.error("send REQ failed:", e);
  }
}

// ==== リレー管理 (モダール関連) ==== //
function populateRelayList() {
  const listEl = document.getElementById("relayList");
  listEl.innerHTML = "";

  relayListState.forEach(url => {
    const connected = sockets.some(ws => ws._url === url && ws.readyState === WebSocket.OPEN);
    const item = document.createElement("div");
    item.textContent = `${url} ${connected ? "✅ 接続中" : "❌ 未接続"}`;
    listEl.appendChild(item);
  });
}

// ==== イベントリスナー ==== //
// 購読ボタン
document.getElementById("btnSubscribe")?.addEventListener("click", async () => {
  console.log("=== 購読ボタン押された ===");
  if (spinner) spinner.style.display = "inline-block";

  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  console.log("新しい subId:", subId);

  await Promise.all(
    sockets.map(ws =>
      new Promise(resolve => {
        if (ws.readyState === WebSocket.OPEN) {
          subscribeTo(ws);
          resolve();
        } else {
          ws.addEventListener("open", () => {
            subscribeTo(ws);
            resolve();
          }, { once: true });
        }
      })
    )
  );

  if (spinner) spinner.style.display = "none";
});

// ==== モダール制御 ==== //
const relayModal = document.getElementById("relayModal");

// 開く
document.getElementById("btnRelayModal")?.addEventListener("click", () => {
  relayModal.style.display = "block";
  populateRelayList();
});

// 閉じる
document.getElementById("btnCloseModal")?.addEventListener("click", () => {
  relayModal.style.display = "none";
});

// モダール外クリックで閉じる
window.addEventListener("click", (e) => {
  if (e.target === relayModal) {
    relayModal.style.display = "none";
  }
});

// スクロールボタン
document.getElementById("scrollLeft")?.addEventListener("click", () => {
  timeline.scrollBy({ left: -300, behavior: "smooth" });
});
document.getElementById("scrollRight")?.addEventListener("click", () => {
  timeline.scrollBy({ left: 300, behavior: "smooth" });
});

// リレー追加
document.getElementById("btnAddRelay")?.addEventListener("click", () => {
  const url = prompt("追加するリレーURLを入力してください (例: wss://relay.example.com)");
  if (!url || relayListState.includes(url)) return;
  relayListState.push(url);
  populateRelayList();
});

// 接続ボタン
document.getElementById("btnConnectModal")?.addEventListener("click", () => {
  localStorage.setItem("relays", JSON.stringify(relayListState));
  connectRelays(relayListState.join(","));
  document.getElementById("relayModal").style.display = "none";
  if (subId) sockets.forEach(ws => subscribeTo(ws));
});

// ==== 初期処理 ==== //
connectRelays(relayListState.join(","));
