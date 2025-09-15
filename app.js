console.log("app.js 読み込まれた！");

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnSubscribe");
  console.log("購読ボタン要素:", btn);

  if (!btn) return; // ボタンがなければここで終了

  btn.addEventListener("click", async () => {
    console.log("=== 購読ボタン押された ===");

    const spinner = document.getElementById("subscribeSpinner");
    if (spinner) spinner.style.display = "inline-block";

    // 新しい subId に更新
    subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
    console.log("新しい subId:", subId);

    // 全リレーに購読リクエスト送信
    await Promise.all(
      sockets.map(ws =>
        new Promise(resolve => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log("OPEN状態: REQ送信", ws._url);
            subscribeTo(ws);
            resolve();
          } else {
            console.log("まだ接続中: openイベント待ち", ws._url);
            ws.addEventListener(
              "open",
              () => {
                console.log("接続完了: REQ送信", ws._url);
                subscribeTo(ws);
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
});


// ==== 設定 ====
const MAX_LENGTH = 41;
const NG_WORDS = [
  "キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ",
  "与党","野党","在日","クルド",
  "fuck","shit","sex","porn","gay","ass","dick","pussy","CP","mempool","http://","https://"
];

// ==== グローバル状態管理 ====
let sockets = [];
let subId = null;
const seenEvents = new Set();
const timeline = document.getElementById("timeline");

// ==== ユーティリティ ====
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

// ==== 投稿描画 ====
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">${new Date(event.created_at * 1000).toLocaleString()}</div>
    <div class="author">${event.pubkey.slice(0,8)}...</div>
  `;

  timeline.appendChild(noteEl);
  timeline.scrollLeft = timeline.scrollWidth;
}

// ==== WebSocket イベント受信 ====
function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (msg[0] === "EVENT") {
      const event = msg[2];
      if (!event || seenEvents.has(event.id) || isBlocked(event.content)) return;
      seenEvents.add(event.id);
      renderEvent(event);
    }
  } catch(e) {
    console.error("JSON parse error:", e, ev.data);
  }
}

// ==== リレー接続 ====
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
      ws.onerror = () => { console.log("エラー:", url); updateRelayListStatus(); };

      sockets.push(ws);
    } catch(e) {
      console.error("WebSocket error:", e);
    }
  });

  updateRelayListStatus();
  populateRelayList();
}

// ==== 購読関数 ====
function subscribeTo(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !subId) return;
  const filter = { kinds: [1], limit: 50 };
  try { ws.send(JSON.stringify(["REQ", subId, filter])); }
  catch(e) { console.error("send REQ failed:", e); }
}

function subscribeAll() {
  sockets.forEach(ws => subscribeTo(ws));
}

// ==== リレーリスト操作 ====
function populateRelayList() {
  const container = document.getElementById("relayList");
  if (!container) return;
  container.innerHTML = "";
  sockets.forEach(ws => {
    const div = document.createElement("div");
    div.className = "relay-item";
    div.innerHTML = `
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ws.readyState===WebSocket.OPEN?'green':'red'}"></span>
      <input type="text" value="${ws._url}" readonly />
      <button class="btnDisconnect">切断</button>
    `;
    // 切断ボタン
    div.querySelector(".btnDisconnect").addEventListener("click", () => {
      ws.close();
      updateRelayListStatus();
    });
    container.appendChild(div);
  });
}

function updateRelayListStatus() {
  const container = document.getElementById("relayList");
  if (!container) return;
  const items = container.querySelectorAll(".relay-item span");
  items.forEach((span, i) => {
    span.style.background = sockets[i]?.readyState===WebSocket.OPEN?'green':'red';
  });
}

// ==== DOMContentLoaded ====
document.addEventListener("DOMContentLoaded", () => {
  const btnSubscribe = document.getElementById("btnSubscribe");
  const btnRelayModal = document.getElementById("btnRelayModal");
  const modal = document.getElementById("relayModal");
  const btnCloseModal = document.getElementById("btnCloseModal");
  const btnAddRelay = document.getElementById("btnAddRelay");
  const btnLeft = document.getElementById("scrollLeft");
  const btnRight = document.getElementById("scrollRight");
  const spinner = document.getElementById("subscribeSpinner");

  // スクロールボタン
  btnLeft?.addEventListener("click", () => timeline.scrollBy({ left: -200, behavior: "smooth" }));
  btnRight?.addEventListener("click", () => timeline.scrollBy({ left: 200, behavior: "smooth" }));

  // 設定モダール開閉
  btnRelayModal?.addEventListener("click", () => { if(modal) modal.style.display="block"; });
  btnCloseModal?.addEventListener("click", () => { if(modal) modal.style.display="none"; });

  // 購読ボタン
  btnSubscribe?.addEventListener("click", async () => {
    if (spinner) spinner.style.display = "inline-block";

    subId = `sub-${Math.random().toString(36).slice(2,8)}`;
    subscribeAll();

    if (spinner) spinner.style.display = "none";
  });

  // リレー追加
  btnAddRelay?.addEventListener("click", () => {
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
