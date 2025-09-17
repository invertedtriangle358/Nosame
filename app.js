// ==== 定数設定 ==== //
const MAX_LENGTH = 80;
const NG_WORDS = [
  "キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","パヨク","与党","野党","在日","クルド","死ね","殺す","クソ",
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
  console.log("subscribeTo呼び出し:", ws?._url, "readyState:", ws?.readyState, "subId:", subId);

  if (!ws || ws.readyState !== WebSocket.OPEN || !subId) {
    console.warn("購読できない条件:", { ws, state: ws?.readyState, subId });
    return;
  }

  const filter = { kinds: [1], limit: 100 };
  console.log("REQ送信:", ws._url, subId, filter);

  try {
    ws.send(JSON.stringify(["REQ", subId, filter]));
  } catch (e) {
    console.error("send REQ failed:", e);
  }
}

function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    console.log("受信:", msg); // デバッグ出力を必ず確認
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
async function startSubscription() {
  subId = "sub-" + Math.random().toString(36).slice(2);
  console.log("購読開始 subId:", subId);

  const filter = { kinds: [1], limit: 100, since: Math.floor(Date.now() / 1000) - 3600 };
  // 直近1時間・最大100件（必要に応じて調整）

  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("REQ送信:", ws._url, subId, filter);
      subscribeTo(ws, filter);
    } else {
      ws.addEventListener("open", () => {
        console.log("REQ送信(接続完了後):", ws._url, subId, filter);
        subscribeTo(ws, filter);
      }, { once: true });
    }
  });
}

function subscribeTo(ws, filter) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !subId) return;
  try {
    ws.send(JSON.stringify(["REQ", subId, filter]));
  } catch (e) {
    console.error("send REQ failed:", e);
  }
}


// ==== 投稿処理 ==== //
document.getElementById("btnPublish")?.addEventListener("click", async () => {
  const textarea = document.getElementById("compose");
  const content = textarea.value.trim();

  if (!content) {
    alert("本文を入力してください。");
    return;
  }
  if (!window.nostr) {
    alert("NIP-07 拡張機能 (Alby, nos2x 等) が必要です。");
    return;
  }
  if (isBlocked(content)) {
    alert("NGワードまたは長文のため投稿できません。");
    return;
  }

  try {
    const pubkey = await window.nostr.getPublicKey();

    let newEvent = {
      kind: 1,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey
    };

    newEvent = await window.nostr.signEvent(newEvent);

    // 各リレーに送信
    sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["EVENT", newEvent]));
        console.log("投稿送信:", ws._url, newEvent);
      }
    });

    // 🔥 即時反映
    renderEvent(newEvent);

    // 入力欄クリア
    textarea.value = "";
    document.getElementById("charCount").textContent = "0 / 80";

  } catch (err) {
    console.error("投稿失敗:", err);
    alert("投稿に失敗しました。");
  }
});

// ==== リアクション送信 ==== //
// ==== リアクション状態管理 ==== //
const reactedEvents = new Set(); // 押した event.id を記録

// ==== リアクション送信 ==== //
async function sendReaction(targetEvent) {
  if (!window.nostr) {
    alert("NIP-07 拡張機能が必要です (Alby, nos2x など)");
    return;
  }

  try {
    const pubkey = await window.nostr.getPublicKey();

    let reactionEvent = {
      kind: 7,
      content: "+", // UIは♡, 実際の送信は "+"
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", targetEvent.id],
        ["p", targetEvent.pubkey]
      ],
      pubkey
    };

    reactionEvent = await window.nostr.signEvent(reactionEvent);

    sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["EVENT", reactionEvent]));
        console.log("リアクション送信:", ws._url, reactionEvent);
      }
    });

    // 押したイベントを記録
    reactedEvents.add(targetEvent.id);
    updateReactionButton(targetEvent.id);

  } catch (err) {
    console.error("リアクション送信失敗:", err);
  }
}

// ==== 投稿カード生成 ==== //
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">${new Date(event.created_at * 1000).toLocaleString()}</div>
    <div class="author">${event.pubkey.slice(0, 8)}...</div>
    <button class="btn-reaction" 
            data-id="${event.id}" 
            data-pubkey="${event.pubkey}">
      ♡
    </button>
  `;

  timeline.appendChild(noteEl);
  timeline.scrollLeft = timeline.scrollWidth;
}

// ==== リアクションボタン状態更新 ==== //
function updateReactionButton(eventId) {
  const btn = document.querySelector(`.btn-reaction[data-id="${eventId}"]`);
  if (!btn) return;
  if (reactedEvents.has(eventId)) {
    btn.textContent = "❤️"; // 押した後は赤ハート固定
    btn.disabled = true;     // 以後は押せない
  }
}

// ==== ボタン動作 ==== //
document.addEventListener("click", e => {
  if (e.target.classList.contains("btn-reaction")) {
    const eventId = e.target.dataset.id;
    const pubkey = e.target.dataset.pubkey;
    sendReaction({ id: eventId, pubkey });
  }
});


// ==== 投稿カード生成 ==== //
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">${new Date(event.created_at * 1000).toLocaleString()}</div>
    <div class="author">${event.pubkey.slice(0, 8)}...</div>
    <button class="btn-reaction" data-id="${event.id}" data-pubkey="${event.pubkey}">♡</button>
  `;

  timeline.appendChild(noteEl);
  timeline.scrollLeft = timeline.scrollWidth;
}

// ==== ボタン動作 ==== //
document.addEventListener("click", e => {
  if (e.target.classList.contains("btn-reaction")) {
    const eventId = e.target.dataset.id;
    const pubkey = e.target.dataset.pubkey;
    sendReaction({ id: eventId, pubkey });
  }
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
