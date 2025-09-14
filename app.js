// ==== ユーティリティ ====
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ==== グローバル変数 ====
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

// ==== ワードフィルタ ====
const MAX_LENGTH = 41;
const NG_WORDS = ["キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","与党","野党","在日","クルド",
  "fuck","shit","sex","porn","gay","ass","dick","pussy","CP","mempool"];

function isBlocked(text) {
  if (!text) return false;
  if (text.length > MAX_LENGTH) return true;
  const lowered = text.toLowerCase();
  return NG_WORDS.some(word => lowered.includes(word.toLowerCase()));
}

// ==== Nostr 接続 ====
function connectRelays(relayStr) {
  // 既存接続を閉じる
  sockets.forEach(ws => ws.close?.());
  sockets = [];

  const relays = relayStr.split(",").map(s => s.trim()).filter(Boolean);

  relays.forEach(url => {
    const ws = new WebSocket(url);
    ws._url = url;

    ws.onopen = () => {
      console.log("接続成功:", url);
      updateRelayListStatus();
      subscribeTo(ws); // 接続完了後に購読
    };
    ws.onclose = () => { console.log("切断:", url); updateRelayListStatus(); };
    ws.onerror = () => { console.log("エラー:", url); updateRelayListStatus(); };
    ws.onmessage = onMessage;

    sockets.push(ws);
  });

  updateRelayListStatus();
}

// ==== 購読 ====
function subscribeTo(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const filter = { kinds: [1], limit: 50 };
  ws.send(JSON.stringify(["REQ", subId, filter]));
}

function subscribeAll() {
  sockets.forEach(ws => subscribeTo(ws));
}

// ==== イベント受信 ====
function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (msg[0] === "EVENT") {
      const event = msg[2];
      if (isBlocked(event.content)) return;
      if (seenEvents.has(event.id)) return;
      seenEvents.add(event.id);
      renderEvent(event);
    }
  } catch (e) { console.error("JSON parse error:", e); }
}

// ==== 投稿カード描画 ====
function renderEvent(ev) {
  const el = document.createElement("article");
  el.className = "note";
  const ts = new Date(ev.created_at * 1000).toLocaleString();
  el.innerHTML = `
    <button class="react-btn">+</button>
    <div class="meta">${ts}</div>
    <div class="author">${ev.pubkey.slice(0,8)}…</div>
    <div class="content"></div>
  `;
  el.querySelector(".content").textContent = ev.content || "";
  el.querySelector(".react-btn").onclick = () => reactToEvent(ev, "+");

  const timeline = qs("#timeline");
  if (!timeline) return;
  timeline.appendChild(el);
  el.setAttribute("data-ts", ev.created_at);
}

// ==== 投稿 ====
async function publish() {
  const ext = window.nostr;
  if (!ext) return alert("NIP-07拡張が必要です");

  const content = qs("#compose")?.value.trim();
  if (!content) return;

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now()/1000);
    const unsigned = { kind:1, created_at, tags:[], content, pubkey };
    const id = await sha256(enc([0,pubkey,created_at,1,[],content]));
    const ev = await ext.signEvent({...unsigned, id});
    sockets.forEach(ws => { if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev])); });
    qs("#compose").value = "";
    qs("#charCount").textContent = "0 / 40";
  } catch(e){ console.error(e); }
}

// ==== リアクション ====
async function reactToEvent(targetEvent, emoji="+") {
  const ext = window.nostr;
  if (!ext) return alert("NIP-07拡張が必要です");
  const pubkey = await ext.getPublicKey();
  const created_at = Math.floor(Date.now()/1000);
  const tags = [["e", targetEvent.id],["p", targetEvent.pubkey]];
  const unsigned = { kind:7, created_at, tags, content: emoji, pubkey };
  const ev = await ext.signEvent(unsigned);
  sockets.forEach(ws => { if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev])); });
}

// ==== モダール操作 ====
function populateRelayList() {
  const container = qs("#relayList");
  container.innerHTML = "";
  relayList.forEach((url,i) => {
    const div = document.createElement("div");
    div.className = "relay-item";

    const status = document.createElement("span");
    status.className = "relay-status";
    status.style.background = sockets[i]?.readyState===1?"green":"red";

    const input = document.createElement("input");
    input.value = url;
    input.style.width="100%";

    const delBtn = document.createElement("button");
    delBtn.textContent="✕";
    delBtn.onclick = () => { relayList.splice(i,1); populateRelayList(); };

    div.appendChild(status);
    div.appendChild(input);
    div.appendChild(delBtn);
    container.appendChild(div);
  });
}

// ==== リレー表示更新 ====
function updateRelayListStatus() {
  const container = qs("#relayList");
  if (!container) return;
  container.querySelectorAll(".relay-item").forEach((item, i) => {
    const ws = sockets[i];
    const status = item.querySelector(".relay-status");
    if (!status) return;
    status.style.background = ws && ws.readyState === WebSocket.OPEN ? "green" : "red";
  });
}

// ==== 初期設定 ====
document.addEventListener("DOMContentLoaded", () => {
  // 投稿欄
  const compose = qs("#compose");
  const counter = qs("#charCount");
  compose?.addEventListener("keydown", e => { if(e.ctrlKey && e.key==="Enter") publish(); });
  compose?.addEventListener("input", () => {
    if(!counter) return;
    const len = compose.value.length;
    counter.textContent = `${len} / 40`;
    counter.style.color = len>40?"red":"inherit";
  });

  // ボタンイベント
  qs("#btnPublish")?.addEventListener("click", publish);
  qs("#btnSubscribe")?.addEventListener("click", subscribeAll);

  // モダール開閉
  const modal = qs("#relayModal");
  qs("#btnRelayModal")?.addEventListener("click", ()=>{ populateRelayList(); modal.style.display="block"; });
  qs("#btnCloseModal")?.addEventListener("click", ()=> modal.style.display="none");
  window.addEventListener("click", e => { if(e.target===modal) modal.style.display="none"; });

  // モダール接続
  qs("#btnConnectModal")?.addEventListener("click", ()=>{
    const inputs = qs("#relayList").querySelectorAll("input");
    relayList = Array.from(inputs).map(i=>i.value.trim()).filter(Boolean);
    connectRelays(relayList.join(","));
    modal.style.display="none";
  });

  // 初期接続
  connectRelays(relayList.join(","));
});
