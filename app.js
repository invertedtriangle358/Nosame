// ==== ユーティリティ ====
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ==== グローバル ====
let sockets = [];
const seenEvents = new Set();
let subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
let relayList = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://r.kojira.io",
  "wss://relay.barine.co",
  "wss://yabu.me",
  "wss://lang.relays.land/ja"
];

// ==== Nostr接続 ====
function connectRelays(relayStr) {
  sockets.forEach(ws => ws.close?.());
  sockets = [];
  const relays = relayStr.split(",").map(s => s.trim()).filter(Boolean);

  relays.forEach(url => {
    const ws = new WebSocket(url);
    ws._url = url;
    ws.onopen = () => console.log("接続:", url);
    ws.onclose = () => console.log("切断:", url);
    ws.onerror = () => console.log("エラー:", url);
    ws.onmessage = onMessage;
    sockets.push(ws);
  });

  updateRelayList();
}

// ==== リレー一覧更新 ====
function updateRelayList() {
  const container = qs("#relayList");
  if (!container) return;
  container.innerHTML = "";
  relayList.forEach((url, i) => {
    const div = document.createElement("div");
    div.className = "relay-item";

    const status = document.createElement("span");
    status.style.width = "10px";
    status.style.height = "10px";
    status.style.borderRadius = "50%";
    status.style.display = "inline-block";
    status.style.marginRight = "5px";
    status.style.background = sockets[i]?.readyState === 1 ? "green" : "red";

    const input = document.createElement("input");
    input.type = "text";
    input.value = url;
    input.style.width = "calc(100% - 40px)";

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.onclick = () => { relayList.splice(i,1); updateRelayList(); };

    div.appendChild(status);
    div.appendChild(input);
    div.appendChild(delBtn);
    container.appendChild(div);
  });
}

// ==== 購読 ====
function subscribe() {
  const kind = 1; // 投稿のみ購読
  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  const filter = { kinds: [kind], limit: 50 };
  const req = ["REQ", subId, filter];
  sockets.forEach(ws => {
    if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
  });
  console.log("購読リクエスト送信:", req);
}


// ==== 投稿イベント処理 ====
const MAX_LENGTH = 41;
function isBlocked(text) { return text && text.length > MAX_LENGTH; }

function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if(msg[0] === "EVENT") {
      const event = msg[2];
      if(isBlocked(event.content)) return;
      if(seenEvents.has(event.id)) return;
      seenEvents.add(event.id);
      renderEvent(event);
    }
  } catch(e) { console.error(e); }
}

function renderEvent(ev) {
  let content = ev.content || "";
  const el = document.createElement("article");
  el.className = "note";

  const ts = new Date(ev.created_at*1000).toLocaleString();
  el.innerHTML = `
    <button class="react-btn">+</button>
    <div class="meta">${ts}</div>
    <div class="author">${ev.pubkey.slice(0,8)}…</div>
    <div class="content"></div>
  `;
  el.querySelector(".content").textContent = content;
  el.querySelector(".react-btn").onclick = () => reactToEvent(ev, "+");

  const timeline = qs("#timeline");
  if (!timeline) return;
  timeline.appendChild(el);
  el.setAttribute("data-ts", ev.created_at);
}

// ==== 投稿 ====
async function publish() {
  const ext = window.nostr;
  const hint = qs("#postHint");
  if(!ext) return (hint.textContent = "NIP-07対応拡張が必要です");

  const content = qs("#compose").value.trim();
  if(!content) return (hint.textContent = "本文が空です");

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now()/1000);
    const unsigned = { kind:1, created_at, tags:[], content, pubkey };
    const id = await sha256(enc([0,pubkey,created_at,1,[],content]));
    const ev = await ext.signEvent({...unsigned, id});
    sockets.forEach(ws => { if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev])); });
    qs("#compose").value = "";
    qs("#charCount").textContent = "0 / 40";
  } catch(e) { console.error(e); }
}

// ==== リアクション ====
async function reactToEvent(ev, emoji="+") {
  const ext = window.nostr;
  if(!ext) return alert("NIP-07拡張が必要です");
  const pubkey = await ext.getPublicKey();
  const created_at = Math.floor(Date.now()/1000);
  const tags = [["e", ev.id], ["p", ev.pubkey]];
  const unsigned = { kind:7, created_at, tags, content: emoji, pubkey };
  const signed = await ext.signEvent(unsigned);
  sockets.forEach(ws => { if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", signed])); });
}

// ==== 初期化 ====
document.addEventListener("DOMContentLoaded", () => {
  // 投稿ボタン
  qs("#btnPublish")?.addEventListener("click", publish);
  const compose = qs("#compose");
  const counter = qs("#charCount");
  compose?.addEventListener("keydown", e => { if(e.ctrlKey && e.key==="Enter") publish(); });
  compose?.addEventListener("input", () => {
    const len = compose.value.length;
    if(counter){ counter.textContent = `${len} / 40`; counter.style.color = len>40?"red":"inherit"; }
  });

  // モダール
  const modal = qs("#relayModal");
  qs("#btnRelayModal")?.addEventListener("click", () => { updateRelayList(); modal.style.display="block"; });
  qs("#btnCloseModal")?.addEventListener("click", () => modal.style.display="none");
  window.addEventListener("click", e => { if(e.target===modal) modal.style.display="none"; });

  qs("#btnAddRelay")?.addEventListener("click", () => { relayList.push(""); updateRelayList(); });
  qs("#btnConnectModal")?.addEventListener("click", () => {
    const inputs = qs("#relayList").querySelectorAll("input");
    relayList = Array.from(inputs).map(i=>i.value.trim()).filter(Boolean);
    connectRelays(relayList.join(","));
    subscribe();
    modal.style.display="none";
  });

  // 初期接続
  connectRelays(relayList.join(","));
  subscribe();

  // タイムラインスクロール
  const timeline = qs("#timeline");
  qs("#scrollLeft")?.addEventListener("click", ()=>timeline?.scrollBy({ left:-300, behavior:"smooth" }));
  qs("#scrollRight")?.addEventListener("click", ()=>timeline?.scrollBy({ left:300, behavior:"smooth" }));
});
