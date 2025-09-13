// ---- ユーティリティ ----
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

let sockets = [];
const seenEvents = new Set(); // 表示済みイベント
let subId = `sub-${Math.random().toString(36).slice(2, 8)}`;

// ---- Nostr接続 ----
function connectRelays(relayList) {
  sockets.forEach((ws) => ws.close?.());
  sockets = [];

  const relays = relayList.split(",").map((s) => s.trim()).filter(Boolean);
  const status = qs("#status");
  if (!status) return;

  status.textContent = "接続中…";
  let openCount = 0;

  relays.forEach((url) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      openCount++;
      status.textContent = `接続: ${openCount}/${relays.length}`;
      console.log("接続成功:", url);
    };
    ws.onclose = () => {
      console.log("切断:", url);
      status.textContent = `切断: ${url}`;
    };
    ws.onerror = () => {
      console.log("エラー:", url);
      status.textContent = `エラー: ${url}`;
    };

    ws.onmessage = onMessage;
    sockets.push(ws);
  });
}

// ---- 購読 ----
function subscribe() {
  const kind = Number(qs("#kind")?.value ?? 1);
  const author = qs("#author")?.value.trim();
  const limit = Number(qs("#limit")?.value) || 50;

  const filter = { kinds: [kind], limit };
  if (author) filter.authors = [author];

  const tl = qs("#timeline");
  if (tl) tl.classList.remove("empty");

  // 新しい subId を生成して追加購読
  subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
  const req = ["REQ", subId, filter];

  sockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
  });
}

// ---- イベントフィルタ ----
const MAX_LENGTH = 41;
const NG_WORDS = ["キチガイ","ガイジ","ケンモ","嫌儲","右翼","左翼","ウヨ","サヨ","与党","野党","在日","クルド","fuck","shit","sex","porn","gay","ass","dick","pussy","CP","mempool"];

function isBlocked(text) {
  if (!text) return false;
  if (text.length > MAX_LENGTH) return true;
  const lowered = text.toLowerCase();
  return NG_WORDS.some(word => lowered.includes(word.toLowerCase()));
}

// ---- イベント受信 ----
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
  } catch (e) {
    console.error("JSON parse error:", e);
  }
}

// ---- 投稿カードレンダリング ----
function renderEvent(ev) {
  let content = ev.content || "";
  if (ev.kind === 6) {
    try {
      const inner = JSON.parse(content);
      if (inner?.content) content = `RP › ${inner.content}`;
    } catch {}
  }

  const el = document.createElement("article");
  el.className = "note";

  const ts = new Date(ev.created_at * 1000).toLocaleString();
  el.innerHTML = `
    <div class="meta">${ts}</div>
    <div class="author">${ev.pubkey.slice(0,8)}…</div>
    <div class="content"></div>
  `;
  el.querySelector(".content").textContent = content;

  // リアクションボタン
  const reactBtn = document.createElement("button");
  reactBtn.textContent = "+";
  reactBtn.className = "react-btn";
  reactBtn.onclick = () => reactToEvent(ev, "+");
  el.appendChild(reactBtn);

  const timeline = qs("#timeline");
  if (!timeline) return;

  // created_at降順で挿入
  const existing = timeline.querySelectorAll("article");
  let inserted = false;
  for (const node of existing) {
    const tsAttr = node.getAttribute("data-ts");
    if (tsAttr && Number(tsAttr) < ev.created_at) {
      timeline.insertBefore(el, node);
      inserted = true;
      break;
    }
  }
  if (!inserted) timeline.appendChild(el);
  el.setAttribute("data-ts", ev.created_at);
}

// ---- 投稿 ----
async function publish() {
  const ext = window.nostr;
  const hint = qs("#postHint");
  if (!ext) return (hint.textContent = "NIP-07対応拡張が見つかりません");

  const content = qs("#compose").value.trim();
  if (!content) return (hint.textContent = "本文が空です");

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now()/1000);
    const unsigned = { kind:1, created_at, tags:[], content, pubkey };
    const id = await sha256(enc([0,pubkey,created_at,1,[],content]));
    const ev = await ext.signEvent({...unsigned, id});

    let ok=0, ng=0;
    await Promise.allSettled(sockets.map(ws => new Promise(res => {
      if(ws.readyState!==1) return res();
      const onAck = e => {
        try {
          const m = JSON.parse(e.data);
          if(m[0]==="OK" && m[1]===ev.id) {
            m[2]?ok++:ng++;
            ws.removeEventListener("message", onAck);
            res();
          }
        } catch{}
      };
      ws.addEventListener("message", onAck);
      ws.send(JSON.stringify(["EVENT", ev]));
    })));

    if(hint) hint.textContent=`送信: OK ${ok} / NG ${ng}`;
    qs("#compose").value="";
    qs("#charCount").textContent="0 / 40";
  } catch(e) {
    if(hint) hint.textContent="投稿失敗: "+(e?.message||e);
  }
}

// ---- リアクション ----
async function reactToEvent(targetEvent, emoji="+") {
  const ext = window.nostr;
  if (!ext) return alert("NIP-07拡張が必要です");
  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now()/1000);
    const kind = 7;
    const tags = [["e", targetEvent.id],["p", targetEvent.pubkey]];
    const unsigned = { kind, created_at, tags, content: emoji, pubkey };
    const ev = await ext.signEvent(unsigned);
    sockets.forEach(ws => {
      if(ws.readyState===1) ws.send(JSON.stringify(["EVENT", ev]));
    });
  } catch(e){console.error(e);}
}

// ---- 初期化 ----
document.addEventListener("DOMContentLoaded", () => {
  qs("#btnConnect")?.addEventListener("click", () =>
    connectRelays(qs("#relay").value)
  );
  qs("#btnSubscribe")?.addEventListener("click", subscribe);
  qs("#btnPublish")?.addEventListener("click", publish);

  // Ctrl+Enter で投稿 / 文字数カウント
  const compose = qs("#compose");
  if (compose) {
    compose.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "Enter") publish();
    });

    const counter = qs("#charCount");
    compose.addEventListener("input", () => {
      if (!counter) return;
      const len = compose.value.length;
      counter.textContent = `${len} / 40`;
      counter.style.color = len > 40 ? "red" : "inherit";
    });
  }

  // 起動時に接続
  connectRelays(qs("#relay").value);

  // スクロールボタン
  const timeline = qs("#timeline");
  qs("#scrollLeft")?.addEventListener("click", () =>
    timeline?.scrollBy({ left: -300, behavior: "smooth" })
  );
  qs("#scrollRight")?.addEventListener("click", () =>
    timeline?.scrollBy({ left: 300, behavior: "smooth" })
  );
});
