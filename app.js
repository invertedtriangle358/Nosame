// ==== 設定 ====
const MAX_LENGTH = 41;
const NG_WORDS = [
  "キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","与党","野党","在日","クルド",
  "fuck","shit","sex","porn","gay","ass","dick","pussy","CP","mempool","http://","https://"
];

// デフォルトで接続するリレー
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

// ==== 状態管理 ====
let sockets = [];
let subId = null;
const seenEvents = new Set();
const timeline = document.getElementById("timeline");

// ==== ミュート判定 ====
function isBlocked(text) {
  if (!text) return false;
  if (text.length > MAX_LENGTH) return true;
  const lowered = text.toLowerCase();
  return NG_WORDS.some(word => lowered.includes(word.toLowerCase()));
}

// ==== リレー接続 ====
function connectRelays(relayStr) {
  // 既存接続を閉じる
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
        if (subId) subscribeTo(ws); // 購読中なら再購読
      };
      ws.onmessage = onMessage;
      ws.onclose = () => { console.log("切断:", url); updateRelayListStatus(); };
      ws.onerror = () => { console.log("エラー:", url); updateRelayListStatus(); };

      sockets.push(ws);
    } catch (e) {
      console.error("WebSocket error:", e);
    }
  });

  updateRelayListStatus();
  populateRelayList();
}

// ==== イベント受信 ====
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

// ==== 投稿描画 ====
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">${new Date(event.created_at * 1000).toLocaleString()}</div>
    <div class="author">${event.pubkey.slice(0, 8)}...</div>
  `;

  timeline.appendChild(noteEl);
  timeline.scrollLeft = timeline.scrollWidth; // 最新を表示
}

// ==== スクロールボタン ====
document.getElementById("scrollLeft")?.addEventListener("click", () => {
  timeline.scrollBy({ left: -200, behavior: "smooth" });
});
document.getElementById("scrollRight")?.addEventListener("click", () => {
  timeline.scrollBy({ left: 200, behavior: "smooth" });
});

// ==== ユーティリティ ====
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
  );
}

// ==== 購読 ====
document.getElementById("btnSubscribe")?.addEventListener("click", async () => {
  const spinner = document.getElementById("subscribeSpinner");
  if (spinner) spinner.style.display = "inline-block";

  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;

  await Promise.all(
    sockets.map(ws => new Promise(resolve => {
      if (ws.readyState === WebSocket.OPEN) {
        subscribeTo(ws);
        resolve();
      } else {
        ws.addEventListener("open", () => {
          subscribeTo(ws);
          resolve();
        }, { once: true });
      }
    }))
  );

  if (spinner) spinner.style.display = "none";
});

// ==== 購読処理 ====
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

// ==== モダール制御 ====
const relayModal = document.getElementById("relayModal");
const btnRelayModal = document.getElementById("btnRelayModal");
const btnCloseModal = document.getElementById("btnCloseModal");

// 開く
btnRelayModal?.addEventListener("click", () => {
  relayModal.style.display = "block";
});

// 閉じる
btnCloseModal?.addEventListener("click", () => {
  relayModal.style.display = "none";
});

// 背景クリックでも閉じる
window.addEventListener("click", (e) => {
  if (e.target === relayModal) {
    relayModal.style.display = "none";
  }
});


// ==== 初期化 ====
document.addEventListener("DOMContentLoaded", () => {
  // 起動時にデフォルトリレーへ接続
  connectRelays(DEFAULT_RELAYS.join(","));

  // リレー追加ボタン
  document.getElementById("btnAddRelay")?.addEventListener("click", () => {
    const url = prompt("追加するリレーのURLを入力してください:", "wss://");
    if (url) {
      const ws = new WebSocket(url);
      ws._url = url;

      ws.onopen = () => {
        console.log("追加リレー接続成功:", url);
        updateRelayListStatus();
        if (subId) subscribeTo(ws);
      };
      ws.onmessage = onMessage;
      ws.onclose = () => { console.log("切断:", url); updateRelayListStatus(); };
      ws.onerror = () => { console.log("エラー:", url); updateRelayListStatus(); };

      sockets.push(ws);
      populateRelayList();
    }
  });
});
