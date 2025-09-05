// ---- 簡易ユーティリティ ----
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ---- Nostr 基本 ----
let sockets = [];
const subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
const seenEvents = new Set(); // 表示済みイベント

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

function subscribe() {
  const kind = Number(qs("#kind")?.value ?? 1);
  const author = qs("#author")?.value.trim();
  const limit = Number(qs("#limit")?.value) || 50;

  const filter = { kinds: [kind], limit };
  if (author) filter.authors = [author];

  const tl = qs("#timeline");
  if (tl) {
    tl.innerHTML = "";
    tl.classList.remove("empty");
  }

  const req = ["REQ", subId, filter];
  console.log("購読リクエスト送信:", req);

  sockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
  });
}

function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (msg[0] === "EVENT" && msg[1] === subId) {
      const event = msg[2];

      if (seenEvents.has(event.id)) return;
      seenEvents.add(event.id);

      renderEvent(event);
    }
  } catch (e) {
    console.error("JSON parse error:", e);
  }
}

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
    <div class="author">${ev.pubkey.slice(0, 8)}…</div>
    <div class="content"></div>
  `;
  el.querySelector(".content").textContent = content;

  // ❤️ リアクションボタン
  const reactBtn = document.createElement("button");
  reactBtn.textContent = "+";
  reactBtn.onclick = () => reactToEvent(ev, "+");
  el.appendChild(reactBtn);

  qs("#timeline")?.prepend(el);
}

// ---- 投稿（NIP-07） ----
async function publish() {
  const ext = window.nostr;
  const hint = qs("#postHint");
  if (!ext) return (hint.textContent = "NIP-07対応拡張が見つかりません");

  const content = qs("#compose").value.trim();
  if (!content) return (hint.textContent = "本文が空です");

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now() / 1000);
    const unsigned = { kind: 1, created_at, tags: [], content, pubkey };
    const id = await sha256(enc([0, pubkey, created_at, 1, [], content]));
    const ev = await ext.signEvent({ ...unsigned, id });

    let okCount = 0,
      errCount = 0;

    await Promise.allSettled(
      sockets.map(
        (ws) =>
          new Promise((res) => {
            if (ws.readyState !== WebSocket.OPEN) return res();
            const onAck = (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m[0] === "OK" && m[1] === ev.id) {
                  m[2] ? okCount++ : errCount++;
                  ws.removeEventListener("message", onAck);
                  res();
                }
              } catch {}
            };
            ws.addEventListener("message", onAck);
            ws.send(JSON.stringify(["EVENT", ev]));
          })
      )
    );

    hint.textContent = `送信: OK ${okCount} / NG ${errCount}`;
    qs("#compose").value = "";
  } catch (e) {
    hint.textContent = "投稿失敗: " + (e?.message || e);
  }
}

// ---- リアクション（kind:7） ----
async function reactToEvent(targetEvent, emoji = "+") {
  const ext = window.nostr;
  if (!ext) return alert("NIP-07拡張が必要です");

  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now() / 1000);
    const kind = 7;
    const tags = [
      ["e", targetEvent.id],
      ["p", targetEvent.pubkey],
    ];

    // 🚩 id を自前で計算せず、拡張に unsigned を渡す
    const unsigned = { kind, created_at, tags, content: emoji, pubkey };
    const ev = await ext.signEvent(unsigned);

    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(["EVENT", ev]));
    });

    console.log(`+ リアクション送信 → ${targetEvent.id}`);
  } catch (e) {
    console.error("リアクション送信失敗:", e);
  }
}


// ---- 初期化 ----
document.addEventListener("DOMContentLoaded", () => {
  qs("#btnConnect")?.addEventListener("click", () =>
    connectRelays(qs("#relay").value)
  );
  qs("#btnSubscribe")?.addEventListener("click", subscribe);
  qs("#btnPublish")?.addEventListener("click", publish);
  qs("#btnMe")?.addEventListener("click", async () => {
    if (!window.nostr) return alert("NIP-07拡張が必要です");
    try {
      qs("#author").value = await window.nostr.getPublicKey();
    } catch {}
  });

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
