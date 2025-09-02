// ---- 簡易ユーティリティ ----
const qs = (s) => document.querySelector(s);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const sha256 = async (bytes) => {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// ---- Nostr 基本 ----
let sockets = [];
let subId = 'sub-' + Math.random().toString(36).slice(2, 8);

function connectRelays(relayList) {
  sockets.forEach(ws => { try { ws.close(); } catch(e){} });
  sockets = [];
  const relays = relayList.split(',').map(s => s.trim()).filter(Boolean);
  const status = qs('#status');
  status.textContent = '接続中…';
  let openCount = 0;
  relays.forEach(url => {
    const ws = new WebSocket(url);
    ws.onopen = () => { openCount++; status.textContent = `接続: ${openCount}/${relays.length}`; };
    ws.onclose = () => { status.textContent = `切断: ${url}`; };
    ws.onerror = () => { status.textContent = `エラー: ${url}`; };
    ws.onmessage = onMessage;
    sockets.push(ws);
  });
}

function subscribe() {
  const kind = Number(qs('#kind').value);
  const author = qs('#author').value.trim();
  const limit = Number(qs('#limit').value) || 50;
  const filter = { kinds: [kind], limit };
  if (author) filter.authors = [author];

  const tl = qs('#timeline');
  tl.innerHTML = ''; tl.classList.remove('empty');

  const req = ["REQ", subId, filter];
  sockets.forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(req)); });
}

function onMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (msg[0] === 'EVENT' && msg[1] === subId) {
      const event = msg[2];
      renderEvent(event);
    }
  } catch (e) { /* noop */ }
}

function renderEvent(ev) {
  let content = ev.content || '';
  if (ev.kind === 6) {
    try {
      const inner = JSON.parse(content);
      if (inner && inner.content) content = `RP › ${inner.content}`;
    } catch(e){}
  }

  const el = document.createElement('article');
  el.className = 'note';
  const ts = new Date(ev.created_at * 1000).toLocaleString();
  el.innerHTML = `
    <div class="meta">${ts}</div>
    <div class="author">${ev.pubkey.slice(0, 8)}…</div>
    <div class="content"></div>
  `;
  el.querySelector('.content').textContent = content;

  const tl = qs('#timeline');
  tl.prepend(el);
}

// ---- 投稿（NIP-07） ----
async function publish() {
  const ext = window.nostr;
  const hint = qs('#postHint');
  if (!ext) { hint.textContent = 'NIP-07対応拡張が見つかりません'; return; }
  const content = qs('#compose').value.trim();
  if (!content) { hint.textContent = '本文が空です'; return; }
  try {
    const pubkey = await ext.getPublicKey();
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [];
    const kind = 1;
    const unsigned = { kind, created_at, tags, content, pubkey };
    const id = await sha256(enc([0, pubkey, created_at, kind, tags, content]));
    const ev = await ext.signEvent({ ...unsigned, id });

    let okCount = 0, errCount = 0;
    await Promise.allSettled(sockets.map(ws => new Promise((res) => {
      if (ws.readyState !== 1) return res();
      ws.addEventListener('message', function onAck(e){
        try {
          const m = JSON.parse(e.data);
          if (m[0]==='OK' && m[1]===ev.id) {
            if (m[2]) okCount++; else errCount++;
            ws.removeEventListener('message', onAck);
            res();
          }
        } catch(_) {}
      });
      ws.send(JSON.stringify(["EVENT", ev]));
    })));
    hint.textContent = `送信: OK ${okCount} / NG ${errCount}`;
    qs('#compose').value = '';
  } catch (e) {
    hint.textContent = '投稿失敗: ' + (e?.message || e);
  }
}

// ---- DOM 読み込み後に全てセット ----
document.addEventListener("DOMContentLoaded", () => {
  // ボタン取得
  const btnConnect = qs('#btnConnect');
  const btnSubscribe = qs('#btnSubscribe');
  const btnPublish = qs('#btnPublish');
  const btnMe = qs('#btnMe'); // NIP-07ボタン（存在チェック必須）

  if (btnConnect) btnConnect.addEventListener('click', () => connectRelays(qs('#relay').value));
  if (btnSubscribe) btnSubscribe.addEventListener('click', subscribe);
  if (btnPublish) btnPublish.addEventListener('click', publish);

  // btnMe が存在する場合のみイベントを付与
  if (btnMe) {
    btnMe.addEventListener('click', async () => {
      if (!window.nostr) { alert('NIP-07拡張が必要です'); return; }
      try { const pk = await window.nostr.getPublicKey(); qs('#author').value = pk; } catch(_) {}
    });
  }

  // タイムライン横スクロール
  const timeline = document.getElementById("timeline");
  const btnLeft = document.getElementById("scrollLeft");
  const btnRight = document.getElementById("scrollRight");

  if (timeline) {
    timeline.addEventListener("wheel", (e) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      timeline.scrollLeft += e.deltaY;
    }, { passive: false });

    if (btnLeft && btnRight) {
      btnLeft.addEventListener("click", () => { timeline.scrollLeft -= 300; });
      btnRight.addEventListener("click", () => { timeline.scrollLeft += 300; });
    }
  }

  // 起動時にリレー接続
  connectRelays(qs('#relay')?.value || '');
});
