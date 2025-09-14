// ==== 設定 ====
const MAX_LENGTH = 41;
const NG_WORDS = [
  "キチガイ", "ガイジ", "ケンモ", "嫌儲", "右翼", "左翼", "ウヨ", "サヨ",
  "与党", "野党", "在日", "クルド",
  "fuck", "shit", "sex", "porn", "gay", "ass", "dick", "pussy", "CP", "mempool"
];

// ==== 状態管理 ====
let sockets = [];
let subId = null;
const seenEvents = new Set();
const timeline = document.getElementById("timeline");

// ==== ミュート判定 ====
function isBlocked(text) {
  if (!text) return false;
  return NG_WORDS.some(word => text.includes(word));
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
        subscribeTo(ws);
      };
      ws.onmessage = onMessage;
      ws.onclose = () => {
        console.log("切断:", url);
        updateRelayListStatus();
      };
      ws.onerror = () => {
        console.log("エラー:", url);
        updateRelayListStatus();
      };

      sockets.push(ws);
    } catch (e) {
      console.error("WebSocket error:", e);
    }
  });

  updateRelayListStatus();
  populateRelayList();
}

// ==== 購読 ====
function subscribeTo(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const filter = { kinds: [1], limit: 50 };
  try {
    ws.send(JSON.stringify(["REQ", subId, filter]));
  } catch (e) {
    console.error("send REQ failed:", e);
  }
}

function subscribeAll() {
  sockets.forEach(ws => subscribeTo(ws));
}

document.getElementById("btnSubscribe")?.addEventListener("click", async () => {
  const spinner = document.getElementById("subscribeSpinner");
  if (spinner) spinner.style.display = "inline-block";

  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;

  // 全リレーに購読リクエスト送信
  await Promise.all(
    sockets.map(
      ws =>
        new Promise(resolve => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify(["REQ", subId, { kinds: [1], limit: 50 }])
            );
            resolve();
          } else {
            ws.addEventListener(
              "open",
              () => {
                ws.send(
                  JSON.stringify(["REQ", subId, { kinds: [1], limit: 50 }])
                );
                resolve();
              },
              { once: true }
            );
          }
        })
    )
  );

  if (spinner) spinner.style.display = "none";
});

// ==== イベント受信 ====
function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (msg[0] === "EVENT") {
      const event = msg[2];
      if (
        !event ||
        seenEvents.has(event.id) ||
        isBlocked(event.content)
      )
        return;

      seenEvents.add(event.id);
      renderEvent(event);
    }
  } catch (e) {
    console.error("JSON parse error:", e);
  }
}

// ==== 投稿描画 ====
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="author">${event.pubkey.slice(0, 8)}</div>
  `;

  timeline.appendChild(noteEl);

  // 新しい投稿が見えるように右端へスクロール
  timeline.scrollLeft = timeline.scrollWidth;
}

// ==== ユーティリティ ====
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
      s
    ])
  );
}
