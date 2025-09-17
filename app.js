// 1. 設定 (Constants)
const MAX_POST_LENGTH = 80;
const NG_WORDS = [
  "キチガイ", "ガイジ", "ケンモ", "嫌儲", "右翼", "左翼", "ウヨ", "サヨ", "パヨク",
  "与党", "野党", "在日", "クルド", "死ね", "殺す", "クソ", "fuck", "shit",
  "sex", "porn", "gay", "ass", "dick", "pussy", "CP", "mempool",
  "http://", "https://"
];
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];

// 2. アプリケーションの状態管理 (State)
const state = {
  sockets: [],
  subId: null,
  seenEventIds: new Set(),
  reactedEventIds: new Set(),
  // ローカルストレージからリレーリストを読み込む、なければデフォルト値を使用
  relayList: JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS],
};

// 3. DOM要素のキャッシュ
const dom = {
  timeline: document.getElementById("timeline"),
  spinner: document.getElementById("subscribeSpinner"),
  relayListEl: document.getElementById("relayList"),
  relayModal: document.getElementById("relayModal"),
  composeArea: document.getElementById("compose"),
  charCount: document.getElementById("charCount"),
  // ボタン類
  btnPublish: document.getElementById("btnPublish"),
  btnRelayModal: document.getElementById("btnRelayModal"),
  btnCloseModal: document.getElementById("btnCloseModal"),
  btnAddRelay: document.getElementById("btnAddRelay"),
  btnSaveRelays: document.getElementById("btnSaveRelays"),
  btnScrollLeft: document.getElementById("scrollLeft"),
  btnScrollRight: document.getElementById("scrollRight"),
  relayInput: document.getElementById("relayInput"),
};


// 4. ユーティリティ関数 (Utilities)

/**
 * HTML特殊文字をエスケープする
 * @param {string} str - エスケープ対象の文字列
 * @returns {string} エスケープ後の文字列
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
  );
}

/**
 * コンテンツが投稿ルールに違反していないかチェックする
 * @param {string} text - チェック対象のテキスト
 * @returns {boolean} 違反している場合は true
 */
function isContentInvalid(text) {
  if (!text) return false;
  // 長さチェック
  if (text.length > MAX_POST_LENGTH) return true;
  // NGワードチェック
  const lowercasedText = text.toLowerCase();
  return NG_WORDS.some(ngWord => lowercasedText.includes(ngWord.toLowerCase()));
}

/**
 * 指定されたURLのリレーの接続状態を取得する
 * @param {string} url - リレーのURL
 * @returns {boolean} 接続中なら true
 */
function getRelayStatusByUrl(url) {
  const ws = state.sockets.find(s => s.url === url);
  return ws && ws.readyState === WebSocket.OPEN;
}

/**
 * Nostrイベントの署名をNIP-07拡張機能に要求する
 * @param {object} event - 未署名のNostrイベントオブジェクト
 * @returns {Promise<object>} 署名済みのNostrイベントオブジェクト
 */
async function signEventWithNip07(event) {
  if (!window.nostr) {
    throw new Error("NIP-07 拡張機能 (Alby, nos2x 等) が必要です。");
  }
  return await window.nostr.signEvent(event);
}

// 5. Nostrコアロジック (Relay, Subscription, Events)
/**
 * 現在のリレーリストに基づいてWebSocket接続を確立する
 */
function connectToRelays() {
  // 既存の接続をすべて閉じる
  state.sockets.forEach(ws => ws.close());
  state.sockets = [];

  state.relayList.forEach(url => {
    if (!url) return;
    try {
      const ws = new WebSocket(url);
      
      ws.onopen = () => {
        console.log("✅ 接続成功:", url);
        updateRelayModalList(); // モーダル内のステータスを更新
        // 接続が確立したら、既存の購読IDで再度購読する
        if (state.subId) {
          sendReq(ws);
        }
      };

      ws.onmessage = handleMessage;
      ws.onclose = () => { console.log("🔌 切断:", url); updateRelayModalList(); };
      ws.onerror = (err) => { console.error("❌ エラー:", url, err); updateRelayModalList(); };

      state.sockets.push(ws);
    } catch (e) {
      console.error("WebSocket接続に失敗:", url, e);
    }
  });

  updateRelayModalList(); // 初期状態を描画
}

/**
 * リレーからのメッセージを処理する
 * @param {MessageEvent} ev - WebSocketのonmessageイベント
 */
function handleMessage(ev) {
  try {
    const [type, subId, event] = JSON.parse(ev.data);

    if (type !== "EVENT" || !event) return;
    if (state.seenEventIds.has(event.id) || isContentInvalid(event.content)) return;

    state.seenEventIds.add(event.id);
    renderEvent(event);
  } catch (e) {
    // console.error("メッセージの解析に失敗:", e, ev.data);
  }
}

/**
 * 指定されたWebSocketに購読リクエスト(REQ)を送信する
 * @param {WebSocket} ws - 対象のWebSocket
 */
function sendReq(ws) {
  if (!ws || !state.subId) {
    console.warn("購読リクエストを送信できません: WebSocketまたはsubIdが未設定です。");
    return;
  }

  // 直近1時間・最大100件のkind:1イベントをリクエスト
  const filter = { kinds: [1], limit: 100, since: Math.floor(Date.now() / 1000) - 3600 };
  const req = ["REQ", state.subId, filter];

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(req));
      console.log("📤 REQ送信:", ws.url, req);
    } catch (e) {
      console.error("REQ送信に失敗:", ws.url, e);
    }
  } else {
    // 接続がまだ開いていない場合は、openイベントを待ってから送信する
    console.log("...接続待ち:", ws.url);
    ws.addEventListener('open', () => sendReq(ws), { once: true });
  }
}

/**
 * すべての接続済みリレーにイベントを送信する
 * @param {object} event - 送信するNostrイベント
 */
function publishEvent(event) {
  const payload = JSON.stringify(["EVENT", event]);
  let publishedCount = 0;

  state.sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
        console.log(`📤 EVENT送信: ${event.id.slice(0, 5)}... -> ${ws.url}`);
        publishedCount++;
      } catch (e) {
        console.error("EVENT送信に失敗:", ws.url, e);
      }
    }
  });

  if (publishedCount === 0) {
    alert("接続中のリレーがありません。");
  }
}

/**
 * 全リレーに対するイベントの購読を開始する
 */
function startSubscription() {
  state.subId = `sub-${Math.random().toString(36).substring(2, 8)}`;
  console.log(`🚀 購読開始 (ID: ${state.subId})`);
  dom.spinner.style.display = 'block'; // スピナー表示
  state.sockets.forEach(sendReq);

  // 購読開始時にタイムラインと既読管理をリセット
  dom.timeline.innerHTML = "";
  state.seenEventIds.clear();

  // 少し待ってからスピナーを消す
  setTimeout(() => dom.spinner.style.display = 'none', 2000);
}

// 6. UIロジック (Rendering and Event Handlers)
/**
 * 1つのNostrイベントをDOM要素に変換してタイムラインに追加する
 * @param {object} event - 表示するNostrイベント
 */
function renderEvent(event) {
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  
  // リアクション済みかどうかに応じてボタンのスタイルを変更
  const isReacted = state.reactedEventIds.has(event.id);
  const reactionButtonText = isReacted ? '❤️' : '♡';
  const reactionButtonDisabled = isReacted ? 'disabled' : '';

  noteEl.innerHTML = `
    <div class="content">${escapeHtml(event.content)}</div>
    <div class="meta">
      <span class="author">${escapeHtml(event.pubkey.slice(0, 8))}...</span>
      <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
    </div>
    <button class="btn-reaction" data-id="${event.id}" ${reactionButtonDisabled}>
      ${reactionButtonText}
    </button>
  `;

  // リアクションボタンにイベントリスナーを追加
  const reactionButton = noteEl.querySelector('.btn-reaction');
  reactionButton.addEventListener('click', () => handleReactionClick(event));

  dom.timeline.appendChild(noteEl);
  // 新しい投稿が追加されたら、タイムラインを右端までスクロール
  dom.timeline.scrollLeft = dom.timeline.scrollWidth;
  dom.spinner.style.display = 'none'; // イベント受信でスピナー非表示
}

/**
 * リレー管理モーダル内のリストを現在の状態で再描画する
 */
function updateRelayModalList() {
  if (!dom.relayListEl) return;
  dom.relayListEl.innerHTML = "";

  state.relayList.forEach((url, index) => {
    const row = document.createElement("div");
    row.className = "relay-row";

    const status = getRelayStatusByUrl(url) ? "🟢" : "🔴";

    row.innerHTML = `
      <span class="relay-status">${status}</span>
      <input type="text" value="${escapeHtml(url)}">
      <button class="btn-delete-relay" data-index="${index}">✖</button>
    `;

    // 入力内容をstateにリアルタイムで反映
    row.querySelector('input').addEventListener('input', (e) => {
      state.relayList[index] = e.target.value.trim();
    });
    
    dom.relayListEl.appendChild(row);
  });
}

/**
 * リアクションボタンの状態を更新する
 * @param {string} eventId - リアクション対象のイベントID
 */
function updateReactionButton(eventId) {
  const btn = document.querySelector(`.btn-reaction[data-id="${eventId}"]`);
  if (btn) {
    btn.textContent = "❤️";
    btn.disabled = true;
  }
}

/**
 * 投稿ボタンがクリックされたときの処理
 */
async function handlePublishClick() {
  const content = dom.composeArea.value.trim();

  if (!content) {
    alert("本文を入力してください。");
    return;
  }
  if (isContentInvalid(content)) {
    alert("NGワードが含まれているか、文字数が上限を超えているため投稿できません。");
    return;
  }

  try {
    const pubkey = await window.nostr.getPublicKey();
    let newEvent = {
      kind: 1,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey,
    };

    const signedEvent = await signEventWithNip07(newEvent);
    publishEvent(signedEvent);
    
    // 自身の投稿を即時反映
    if (!state.seenEventIds.has(signedEvent.id)) {
        state.seenEventIds.add(signedEvent.id);
        renderEvent(signedEvent);
    }

    // 入力欄をクリア
    dom.composeArea.value = "";
    dom.charCount.textContent = `0 / ${MAX_POST_LENGTH}`;
    
  } catch (err) {
    console.error("投稿に失敗しました:", err);
    alert(`投稿に失敗しました: ${err.message}`);
  }
}

/**
 * リアクションボタンがクリックされたときの処理
 * @param {object} targetEvent - リアクション対象のイベント
 */
async function handleReactionClick(targetEvent) {
  if (state.reactedEventIds.has(targetEvent.id)) return; // 多重クリック防止

  try {
    const pubkey = await window.nostr.getPublicKey();
    let reactionEvent = {
      kind: 7,
      content: "+",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
      pubkey,
    };

    const signedEvent = await signEventWithNip07(reactionEvent);
    publishEvent(signedEvent);

    // リアクションしたことを記録し、ボタンの表示を更新
    state.reactedEventIds.add(targetEvent.id);
    updateReactionButton(targetEvent.id);
  } catch (err) {
    console.error("リアクションの送信に失敗しました:", err);
    alert(`リアクションに失敗しました: ${err.message}`);
  }
}

/**
 * すべてのイベントリスナーを設定する
 */
function setupEventListeners() {
  dom.btnPublish?.addEventListener("click", handlePublishClick);
  
  // リレーモーダル関連
  dom.btnRelayModal?.addEventListener("click", () => {
    dom.relayModal.style.display = "block";
    updateRelayModalList();
  });
  dom.btnCloseModal?.addEventListener("click", () => {
    dom.relayModal.style.display = "none";
  });
  dom.btnAddRelay?.addEventListener("click", () => {
    const url = dom.relayInput.value.trim();
    if (url && !state.relayList.includes(url)) {
      state.relayList.push(url);
      updateRelayModalList();
      dom.relayInput.value = "";
    }
  });
  dom.relayListEl?.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-delete-relay')) {
        const index = parseInt(e.target.dataset.index, 10);
        state.relayList.splice(index, 1);
        updateRelayModalList();
    }
  });
  dom.btnSaveRelays?.addEventListener("click", () => {
    // 空のURLをフィルタリングで除去
    state.relayList = state.relayList.filter(url => url);
    localStorage.setItem("relays", JSON.stringify(state.relayList));
    alert("リレー設定を保存しました。再接続します。");
    dom.relayModal.style.display = "none";
    connectToRelays(); // 新しい設定で再接続
  });

  // スクロールボタン
  dom.btnScrollLeft?.addEventListener("click", () => {
    dom.timeline.scrollBy({ left: -300, behavior: "smooth" });
  });
  dom.btnScrollRight?.addEventListener("click", () => {
    dom.timeline.scrollBy({ left: 300, behavior: "smooth" });
  });

  // 文字数カウンター
  dom.composeArea?.addEventListener('input', () => {
    const len = dom.composeArea.value.length;
    dom.charCount.textContent = `${len} / ${MAX_POST_LENGTH}`;
  });
}

// 7. 初期化処理 (Initialization)
/**
 * アプリケーションのメイン処理
 */
function main() {
  setupEventListeners();
  connectToRelays();
  // ページ読み込み完了後、少し待ってから自動で購読を開始
  setTimeout(startSubscription, 500);
}

// DOMの読み込みが完了したらアプリケーションを開始
window.addEventListener("DOMContentLoaded", main);
