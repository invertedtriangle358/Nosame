// ==== 定数設定 ==== //
const MAX_LENGTH = 80;
const NG_WORDS = [
  "キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","与党","野党","在日","クルド","死ね","殺す","クソ",
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

// ==== DOMキャッシュ ==== //
const timeline     = document.getElementById("timeline");
const spinner      = document.getElementById("subscribeSpinner");
const relayListEl  = document.getElementById("relayList");
const relayModal   = document.getElementById("relayModal");

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
function getRelayStatus(url) {
  const ws = sockets.find(s => s._url === url);
  return ws && ws.readyState === WebSocket.OPEN;
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

      ws.onopen    = () => { console.log("接続成功:", url); updateRelayList(); if (subId) subscribeTo(ws); };
      ws.onmessage = onMessage;
      ws.onclose   = () => { console.log("切断:", url); updateRelayList(); };
      ws.onerror   = () => { console.log("エラー:", url); updateRelayList(); };

      sockets.push(ws);
    } catch (e) {
      console.error("WebSocket error:", e);
    }
  });

  updateRelayList();
}

// ==== イベント処理 ==== //
function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
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
  timeline.scrollLeft = timeline.scrollWidth;
}

// ==== 購読処理 ==== //
function subscribeTo(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !subId) return;
  const filter = { kinds: [1], limit: 50 };
  try {
    ws.send(JSON.stringify(["REQ", subId, filter]));
  } catch (e) {
    console.error("send REQ failed:", e);
  }
}

// ==== 自動購読処理 ==== //
async function startSubscription() {
  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  console.log("購読開始 subId:", subId);

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
}

// ==== 初期処理 ==== //
window.addEventListener("DOMContentLoaded", async () => {
  const saved = JSON.parse(localStorage.getItem("relays") || "null");

  if (saved && saved.length > 0) {
    console.log("保存済みリレーから接続:", saved);
    connectRelays(saved.join(","));
  } else {
    console.log("デフォルトリレーから接続:", DEFAULT_RELAYS);
    connectRelays(DEFAULT_RELAYS.join(","));
  }

  // 自動で購読開始
  await startSubscription();
});

// ==== 購読ボタン ==== //
document.getElementById("btnSubscribe")?.addEventListener("click", async () => {
  const spinner = document.getElementById("subscribeSpinner");
  if (spinner) spinner.style.display = "inline-block";

  await startSubscription();

  if (spinner) spinner.style.display = "none";
});

// ==== リレー管理 ==== //
function updateRelayList() {
  relayListEl.innerHTML = "";

  relayListState.forEach((url, index) => {
    const row = document.createElement("div");
    row.className = "relay-row";

    // 状態マーク
    const status = document.createElement("span");
    status.className = "relay-status";
    status.textContent = getRelayStatus(url) ? "🟢" : "🔴";

    // 入力欄
    const input = document.createElement("input");
    input.type = "text";
    input.value = url;
    input.addEventListener("input", e => {
      relayListState[index] = e.target.value.trim();
    });

    // 削除ボタン
    const delBtn = document.createElement("button");
    delBtn.textContent = "✖";
    delBtn.addEventListener("click", () => {
      const ws = sockets.find(s => s._url === url);
      if (ws) ws.close();
      relayListState.splice(index, 1);
      localStorage.setItem("relays", JSON.stringify(relayListState));
      updateRelayList();
    });

    row.appendChild(status);
    row.appendChild(input);
    row.appendChild(delBtn);
    relayListEl.appendChild(row);
  });
}

// ==== ボタン処理 ==== //
// モダール開閉
document.getElementById("btnRelayModal")?.addEventListener("click", () => {
  relayModal.style.display = "block";
  updateRelayList();
});
document.getElementById("btnCloseModal")?.addEventListener("click", () => {
  relayModal.style.display = "none";
});

// リレー追加
document.getElementById("btnAddRelay")?.addEventListener("click", () => {
  const input = document.getElementById("relayInput");
  const url = input.value.trim();
  if (!url || relayListState.includes(url)) return;
  relayListState.push(url);
  localStorage.setItem("relays", JSON.stringify(relayListState));
  updateRelayList();
  input.value = "";
});

// リレー保存
document.getElementById("btnSaveRelays")?.addEventListener("click", () => {
  localStorage.setItem("relays", JSON.stringify(relayListState));
  connectRelays(relayListState.join(","));
  relayModal.style.display = "none";
  if (subId) sockets.forEach(ws => subscribeTo(ws));
  alert("リレーを保存しました。");
});

// スクロール
document.getElementById("scrollLeft")?.addEventListener("click", () => {
  timeline.scrollBy({ left: -300, behavior: "smooth" });
});
document.getElementById("scrollRight")?.addEventListener("click", () => {
  timeline.scrollBy({ left: 300, behavior: "smooth" });
});

// ==== 初期処理 ==== //
window.addEventListener("DOMContentLoaded", () => {
  const saved = JSON.parse(localStorage.getItem("relays") || "null");
  if (saved && saved.length > 0) {
    console.log("保存済みリレーから接続:", saved);
    connectRelays(saved.join(","));
  } else {
    console.log("デフォルトリレーから接続:", DEFAULT_RELAYS);
    connectRelays(DEFAULT_RELAYS.join(","));
  }
});
