// ---- ユーティリティ ----
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

let sockets = [];
const seenEvents = new Set();
let subId = `sub-${Math.random().toString(36).slice(2, 8)}`;

// ---- Nostr接続 ----
function connectRelays(relayList) {
  sockets.forEach((ws) => ws.close?.());
  sockets = [];

  const relays = relayList.split(",").map(s => s.trim()).filter(Boolean);
  const status = qs("#status");
  if (!status) return;

  status.textContent = "接続中…";
  let openCount = 0;

  relays.forEach((url) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      openCount++;
      status.textContent = `接続: ${openCount}/${relays.length}`;
      updateRelayList(relays);
    };
    ws.onclose = () => { updateRelayList(relays); };
    ws.onerror = () => { updateRelayList(relays); };
    ws.onmessage = onMessage;

    ws._url = url; // 保存
    sockets.push(ws);
  });

  updateRelayList(relays);
}

// ---- リレー一覧更新 ----
function updateRelayList(relays) {
  const list = qs("#relayList");
  if (!list) return;
  list.innerHTML = "";
  relays.forEach((url) => {
    const item = document.createElement("div");
    item.className = "relay-item";

    const status = document.createElement("span");
    status.className = "relay-status red";
    const ws = sockets.find(s => s._url === url);
    if (ws && ws.readyState === WebSocket.OPEN) {
      status.classList.remove("red");
      status.classList.add("green");
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = url;
    input.style.width = "100%";

    item.appendChild(status);
    item.appendChild(input);
    list.appendChild(item);
  });
}

// ---- 購読 ----
function subscribe() {
  const kind = Number(qs("#kind")?.value ?? 1);
  const author = qs("#author")?.value.trim();
  const limit = Number(qs("#limit")?.value) || 50;
  const filter = { kinds: [kind], limit };
  if (author) filter.authors = [author];

  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  const req = ["REQ", subId, filter];
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
  });
}

// ---- イベント処理 ----
const MAX_LENGTH = 41;
function isBlocked(text) { return text && text.length > MAX_LENGTH; }

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

function renderEvent(ev) {
  let content = ev.content || "";
  const el = document.createElement("article");
  el.className = "note";

  const ts = new Date(ev.created_at * 1000).toLocaleString();
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

// ---- 投稿 ----
async function publish() {
  const ext = window.nostr;
  const hint = qs("#postHint");
  if (!ext) return (hint.textContent = "NIP-07拡張が必要です");

  const content = qs("#compose").value.trim();
  if (!content) return (hint.textContent = "本文が空です");

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now()/1000);
    const unsigned = { kind:1, created_at, tags:[], content, pubkey };
    const id = await sha256(enc([0,pubkey,created_at,1,[],content]));
    const ev = await ext.signEvent({...unsigned, id});
    sockets.forEach(ws => {
      if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev]));
    });
    qs("#compose").value="";
    qs("#charCount").textContent="0 / 40";
  } catch(e) { console.error(e); }
}

// ---- リアクション ----
async function reactToEvent(targetEvent, emoji="+") {
  const ext = window.nostr;
  if (!ext) return alert("NIP-07拡張が必要です");
  const pubkey = await ext.getPublicKey();
  const created_at = Math.floor(Date.now()/1000);
  const tags = [["e", targetEvent.id],["p", targetEvent.pubkey]];
  const unsigned = { kind:7, created_at, tags, content: emoji, pubkey };
  const ev = await ext.signEvent(unsigned);
  sockets.forEach(ws => {
    if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev]));
  });
}

// ---- 初期化 ----
document.addEventListener("DOMContentLoaded", () => {
  qs("#btnConnect")?.addEventListener("click", () =>
    connectRelays(qs("#relay").value)
  );
  qs("#btnSubscribe")?.addEventListener("click", subscribe);
  qs("#btnPublish")?.addEventListener("click", publish);

  // Ctrl+Enter 投稿 & カウント
  const compose = qs("#compose");
  const counter = qs("#charCount");
  compose?.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key === "Enter") publish();
  });
  compose?.addEventListener("input", () => {
    const len = compose.value.length;
    if (counter) {
      counter.textContent = `${len} / 40`;
      counter.style.color = len > 40 ? "red" : "inherit";
    }
  });

// リレー一覧モダール
const modal = qs("#relayModal");
qs("#btnRelayList")?.addEventListener("click", () => {
  modal.classList.add("show");
});
qs("#closeModal")?.addEventListener("click", () => {
  modal.classList.remove("show");
});
window.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.remove("show");
});


  // 初期接続
  connectRelays(qs("#relay").value);

  // スクロール
  const timeline = qs("#timeline");
  qs("#scrollLeft")?.addEventListener("click", () =>
    timeline?.scrollBy({ left: -300, behavior: "smooth" })
  );
  qs("#scrollRight")?.addEventListener("click", () =>
    timeline?.scrollBy({ left: 300, behavior: "smooth" })
  );
});
