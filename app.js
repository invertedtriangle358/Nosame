/* =========================
   0. 定数 & ユーティリティ
   ========================= */
const CONFIG = {
  MAX_POST_LENGTH: 108,
  EVENT_BUFFER_FLUSH_TIME_MS: 200,
  NOSTR_REQ_LIMIT: 30,
  NOSTR_REQ_SINCE_SECONDS_AGO: 3600,
  DEFAULT_RELAYS: [
    "wss://relay-jp.nostr.wirednet.jp",
    "wss://yabu.me",
    "wss://r.kojira.io",
    "wss://relay.barine.co"
  ],
  NGWORDS_JSON_PATH: "./ngwords.json",
  NIP07_WAIT_LIMIT: 10, // 200ms * 10 = 2秒待機
};

const utils = {
  // HTMLエスケープ
  escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/[&<>"']/g, s => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[s]));
  },
  // 関数呼び出しの間引き
  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
  // スリープ
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  // NIP-07拡張機能の注入待ち
  async waitForNostr() {
    if (window.nostr) return window.nostr;
    for (let i = 0; i < CONFIG.NIP07_WAIT_LIMIT; i++) {
      await utils.sleep(200);
      if (window.nostr) return window.nostr;
    }
    throw new Error("NIP-07 対応の拡張機能（Nos2x等）が見つかりません。");
  }
};

/* =========================
   1. シンプル Pub/Sub (イベントバス)
   ========================= */
const eventBus = (() => {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {
        const list = handlers.get(event);
        if (list) handlers.set(event, list.filter(h => h !== fn));
      };
    },
    emit(event, payload) {
      (handlers.get(event) || []).slice().forEach(fn => {
        try { fn(payload); } catch (e) { console.error(`EventBus error [${event}]:`, e); }
      });
    }
  };
})();

/* =========================
   2. storage 抽象化
   ========================= */
const storage = {
  getJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : (typeof fallback === "function" ? fallback() : fallback);
    } catch {
      return fallback;
    }
  },
  setJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("storage.setJson failed", e);
    }
  }
};

/* =========================
   3. Validator
   ========================= */
const validator = {
  isValidRelayUrl(url) {
    try {
      const u = new URL(url);
      return (u.protocol === "wss:" || u.protocol === "ws:") && !!u.hostname;
    } catch {
      return false;
    }
  },
  normalizeUrl(url) {
    return String(url || "").replace(/\/+$/, "");
  },
  isContentTooLong(text) {
    return typeof text === "string" && text.length > CONFIG.MAX_POST_LENGTH;
  }
};

/* =========================
   4. NGワード管理
   ========================= */
function createNgWordManager({ jsonPath = CONFIG.NGWORDS_JSON_PATH } = {}) {
  let defaultNg = [];
  let userNg = storage.getJson("userNgWords", []);

  async function loadDefault() {
    try {
      const res = await fetch(`${jsonPath}?_=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (Array.isArray(json)) defaultNg = json.map(String);
      eventBus.emit("ngwords.loaded", { defaultNg, userNg });
    } catch (e) {
      console.warn("NGワード読み込み失敗:", e);
      defaultNg = [];
      eventBus.emit("ngwords.loadFailed", e);
    }
  }

  function getAll() {
    const set = new Set([...defaultNg, ...userNg].map(w => String(w).toLowerCase()));
    return Array.from(set);
  }

  function isInvalid(text) {
    if (!text) return false;
    if (validator.isContentTooLong(text)) return true;
    const lower = String(text).toLowerCase();
    // 空文字チェックを除外して判定
    return getAll().some(ng => ng && lower.includes(ng));
  }

  function addUserWord(word) {
    const trimmed = String(word || "").trim().toLowerCase();
    if (!trimmed) throw new Error("空のNGワードは登録できません。");
    if (getAll().includes(trimmed)) throw new Error("既に存在するNGワードです。");
    
    userNg.push(trimmed);
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", { userNg });
    return trimmed;
  }

  function removeUserWord(index) {
    if (index < 0 || index >= userNg.length) return;
    userNg.splice(index, 1);
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", { userNg });
  }

  function setUserWords(list) {
    userNg = Array.isArray(list) ? list.map(String) : [];
    // 保存処理はここで行う（UI側でDebounceして呼び出すことを想定）
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", { userNg });
  }

  return { 
    loadDefault, isInvalid, addUserWord, removeUserWord, 
    setUserWords, getUserWords: () => [...userNg], getDefaultWords: () => [...defaultNg] 
  };
}

/* =========================
   5. RelayClient / RelayManager
   ========================= */
function createRelayClient(url) {
  let ws = null;
  let ready = false;

  function connect() {
    if (ws) ws.close();
    try {
      ws = new WebSocket(url);
    } catch (e) {
      eventBus.emit("relay.error", { url, error: e });
      return;
    }

    ws.onopen = () => {
      ready = true;
      eventBus.emit("relay.open", { url });
    };
    ws.onclose = () => {
      ready = false;
      eventBus.emit("relay.close", { url });
    };
    ws.onerror = (err) => {
      eventBus.emit("relay.error", { url, error: err });
    };
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        eventBus.emit("relay.message", { url, data: parsed });
      } catch (e) {
        console.error("Relay message parse error", e);
      }
    };
  }

  function close() {
    if (ws) {
      ws.close();
      ws = null;
      ready = false;
    }
  }

  function send(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      eventBus.emit("relay.error", { url, error: e });
      return false;
    }
  }

  return { url, connect, close, send, isOpen: () => ready && ws?.readyState === WebSocket.OPEN };
}

function createRelayManager({ initialRelays = CONFIG.DEFAULT_RELAYS } = {}) {
  let relayList = storage.getJson("relays", initialRelays.slice());
  let clients = new Map();

  function syncClients() {
    // 削除されたリレーを切断
    for (const [keyUrl, client] of clients.entries()) {
      if (!relayList.some(u => validator.normalizeUrl(u) === keyUrl)) {
        client.close();
        clients.delete(keyUrl);
      }
    }
    // 新しいリレーを接続
    relayList.forEach(url => {
      const normalized = validator.normalizeUrl(url);
      if (!clients.has(normalized)) {
        const client = createRelayClient(url);
        clients.set(normalized, client);
        client.connect();
      }
    });
    eventBus.emit("relayList.updated", { relayList: [...relayList] });
  }

  function addRelay(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed || !validator.isValidRelayUrl(trimmed)) {
      throw new Error("有効な wss:// URLを入力してください。");
    }
    const normalized = validator.normalizeUrl(trimmed);
    if (relayList.some(u => validator.normalizeUrl(u) === normalized)) {
      throw new Error("既に登録済みです。");
    }
    relayList.push(trimmed);
    storage.setJson("relays", relayList);
    syncClients();
  }

  function removeRelayAt(index) {
    if (index >= 0 && index < relayList.length) {
      relayList.splice(index, 1);
      storage.setJson("relays", relayList);
      syncClients();
    }
  }

  function replaceRelayAt(index, newUrl) {
    if (index >= 0 && index < relayList.length) {
      relayList[index] = String(newUrl).trim();
      storage.setJson("relays", relayList);
      // ここでは syncClients せず、保存ボタン押下時に同期するのが一般的だが、
      // 元コードの挙動に従いリスト更新のみ行う（再接続は SaveRelays で）
    }
  }

  function broadcast(data) {
    let count = 0;
    for (const client of clients.values()) {
      if (client.isOpen() && client.send(data)) count++;
    }
    return count;
  }

  function connectAll() {
    for (const client of clients.values()) client.connect();
    if (clients.size === 0) syncClients();
  }

  syncClients(); // init

  return { 
    addRelay, removeRelayAt, replaceRelayAt, broadcast, 
    connectAll, getRelayList: () => [...relayList], 
    getStatus: (url) => clients.get(validator.normalizeUrl(url))?.isOpen() ?? false,
    syncClients
  };
}

/* =========================
   6. Nostr クライアント
   ========================= */
function createNostrClient({ relayManager, ngWordManager } = {}) {
  let subId = null;
  const seenEventIds = new Set();
  const reactedEventIds = new Set();
  let eventBuffer = [];
  let bufferTimer = null;

  function startSubscription() {
    subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
    seenEventIds.clear();
    eventBus.emit("nostr.subscriptionStarted", { subId });

    const filter = {
      kinds: [1],
      limit: CONFIG.NOSTR_REQ_LIMIT,
      since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
    };
    relayManager.broadcast(["REQ", subId, filter]);
  }

  function handleRelayMessage({ url, data }) {
    if (!Array.isArray(data) || data[0] !== "EVENT" || data[1] !== subId) return;
    const event = data[2];
    if (!event || seenEventIds.has(event.id)) return;
    
    if (ngWordManager && ngWordManager.isInvalid(event.content)) return;

    seenEventIds.add(event.id);
    eventBuffer.push(event);
    
    if (!bufferTimer) {
      bufferTimer = setTimeout(flushEventBuffer, CONFIG.EVENT_BUFFER_FLUSH_TIME_MS);
    }
  }

  function flushEventBuffer() {
    eventBuffer.sort((a, b) => a.created_at - b.created_at);
    eventBuffer.forEach(e => eventBus.emit("nostr.event", e));
    eventBuffer = [];
    bufferTimer = null;
  }

  async function publishEvent(rawEvent) {
    const nostr = await utils.waitForNostr();
    const signed = await nostr.signEvent(rawEvent);
    
    if (!signed.id) throw new Error("署名に失敗しました");
    
    // 自分の投稿は即座に表示済みにする
    if (!seenEventIds.has(signed.id)) {
      seenEventIds.add(signed.id);
      eventBus.emit("nostr.event", signed);
    }

    const sentCount = relayManager.broadcast(["EVENT", signed]);
    if (sentCount === 0) throw new Error("接続中のリレーがありません。");
    return sentCount;
  }

  async function createAndPublishPost(content) {
    if (!content || !String(content).trim()) throw new Error("本文を入力してください。");
    if (ngWordManager && ngWordManager.isInvalid(content)) throw new Error("NGワードが含まれているか、文字数が超過しています。");

    const nostr = await utils.waitForNostr();
    const pubkey = await nostr.getPublicKey();
    
    const event = {
      kind: 1,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey
    };
    return publishEvent(event);
  }

  async function reactToEvent(targetEvent) {
    if (reactedEventIds.has(targetEvent.id)) throw new Error("既にリアクション済みです。");
    
    const nostr = await utils.waitForNostr();
    const pubkey = await nostr.getPublicKey();

    const event = {
      kind: 7,
      content: "+",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
      pubkey
    };
    
    await publishEvent(event);
    reactedEventIds.add(targetEvent.id);
    eventBus.emit("nostr.reacted", { eventId: targetEvent.id });
  }

  eventBus.on("relay.message", handleRelayMessage);

  return { startSubscription, createAndPublishPost, reactToEvent, reactedEventIds };
}

/* =========================
   7. UI レンダラー
   ========================= */
function createUI({ relayManager, ngWordManager, nostrClient } = {}) {
  const dom = {
    timeline: document.getElementById("timeline"),
    relayListEl: document.getElementById("relayList"),
    relayModal: document.getElementById("relayModal"),
    composeArea: document.getElementById("compose"),
    charCount: document.getElementById("charCount"),
    btnPublish: document.getElementById("btnPublish"),
    btnRelayModal: document.getElementById("btnRelayModal"),
    btnCloseModal: document.getElementById("btnCloseModal"),
    btnAddRelay: document.getElementById("btnAddRelay"),
    btnSaveRelays: document.getElementById("btnSaveRelays"),
    relayInput: document.getElementById("relayInput"),
    
    // NG Words
    btnNgModal: document.getElementById("btnNgModal"),
    ngModal: document.getElementById("ngModal"),
    btnAddNgWord: document.getElementById("btnAddNgWord"),
    btnSaveNgWords: document.getElementById("btnSaveNgWords"),
    btnCloseNgModal: document.getElementById("btnCloseNgModal"),
    ngWordInput: document.getElementById("ngWordInput"),
    ngWordListEl: document.getElementById("ngWordList"),
    
    // Scroll
    btnScrollLeft: document.getElementById("scrollLeft"),
    btnScrollRight: document.getElementById("scrollRight"),
  };

  function toggleModal(modalEl, open) {
    if (!modalEl) return;
    modalEl.style.display = open ? "block" : "none";
    document.body.style.overflow = open ? "hidden" : "";
  }

  function formatContent(text) {
    const specialWords = [{ word: "【緊急地震速報】", color: "#dd0000" }];
    let safe = utils.escapeHtml(text);
    for (const { word, color } of specialWords) {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      safe = safe.replace(new RegExp(`(${esc})`, "g"), `<span style="color:${color}">$1</span>`);
    }
    return safe;
  }

  // --- Renders ---
  function renderRelayList() {
    if (!dom.relayListEl) return;
    dom.relayListEl.innerHTML = "";
    relayManager.getRelayList().forEach((url, idx) => {
      const row = document.createElement("div");
      row.className = "relay-row";
      const status = relayManager.getStatus(url) ? "🟢" : "🔴";
      row.innerHTML = `
        <span class="relay-status">${status}</span>
        <input data-index="${idx}" class="relay-input" type="text" value="${utils.escapeHtml(url)}">
        <button class="btn-delete-relay" data-index="${idx}">✖</button>
      `;
      dom.relayListEl.appendChild(row);
    });
  }

  function renderNgWordList() {
    if (!dom.ngWordListEl) return;
    dom.ngWordListEl.innerHTML = "";

    ngWordManager.getDefaultWords().forEach(word => {
      const row = document.createElement("div");
      row.className = "ng-word-item ng-default";
      row.innerHTML = `<input type="text" value="${utils.escapeHtml(word)}" disabled><button disabled>✖</button>`;
      dom.ngWordListEl.appendChild(row);
    });

    ngWordManager.getUserWords().forEach((word, idx) => {
      const row = document.createElement("div");
      row.className = "ng-word-item";
      row.innerHTML = `
        <input data-index="${idx}" class="ng-input" type="text" value="${utils.escapeHtml(word)}">
        <button class="btn-delete-ng" data-index="${idx}">✖</button>
      `;
      dom.ngWordListEl.appendChild(row);
    });
  }

  function renderEvent(event) {
    if (!dom.timeline) return;
    const noteEl = document.createElement("div");
    noteEl.className = "note";
    noteEl.dataset.createdAt = event.created_at;
    const isReacted = nostrClient.reactedEventIds.has(event.id);
    
    noteEl.innerHTML = `
      <div class="content">${formatContent(event.content)}</div>
      <div class="meta">
        <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
        <span class="author">${utils.escapeHtml((event.pubkey || "").slice(0, 8))}...</span>
      </div>
      <button class="btn-reaction" data-id="${utils.escapeHtml(event.id)}" ${isReacted ? "disabled" : ""}>
        ${isReacted ? "❤️" : "♡"}
      </button>
    `;

    // Event Delegation ではなく個別にアタッチ (シンプルさ優先)
    const btn = noteEl.querySelector(".btn-reaction");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await nostrClient.reactToEvent(event);
        btn.textContent = "❤️";
      } catch (err) {
        btn.disabled = false;
        alert(`失敗: ${err.message}`);
      }
    });

    // タイムラインへの挿入位置決定（時系列順）
    const children = Array.from(dom.timeline.children);
    const insertPos = children.find(el => Number(el.dataset.createdAt) > event.created_at);
    if (insertPos) dom.timeline.insertBefore(noteEl, insertPos);
    else dom.timeline.appendChild(noteEl);
  }

  // --- Listeners ---
  function bindEventListeners() {
    // 投稿
    dom.btnPublish?.addEventListener("click", async () => {
        const content = dom.composeArea.value.trim();
        if(!content) return;
        try {
            await nostrClient.createAndPublishPost(content);
            dom.composeArea.value = "";
            dom.charCount.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
        } catch (e) { alert(e.message); }
    });

    // 文字数カウント
    dom.composeArea?.addEventListener("input", (e) => {
        const len = e.target.value.length;
        if(dom.charCount) {
            dom.charCount.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
            dom.charCount.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
        }
    });

    // グローバルキーボードショートカット (Ctrl+Enterで投稿)
    // ★ 修正点: 元コードでグローバルにあったものをここへ移動し、domを参照可能に
    document.addEventListener("keydown", (e) => {
        if (document.activeElement !== dom.composeArea) return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            dom.btnPublish.click();
        }
    });

    // Modal Toggles
    dom.btnRelayModal?.addEventListener("click", () => { renderRelayList(); toggleModal(dom.relayModal, true); });
    dom.btnCloseModal?.addEventListener("click", () => toggleModal(dom.relayModal, false));
    dom.btnNgModal?.addEventListener("click", () => { renderNgWordList(); toggleModal(dom.ngModal, true); });
    dom.btnCloseNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, false));

    // Relay Actions
    dom.btnAddRelay?.addEventListener("click", () => {
        try { relayManager.addRelay(dom.relayInput.value); dom.relayInput.value = ""; renderRelayList(); } 
        catch (e) { alert(e.message); }
    });
    dom.relayListEl?.addEventListener("click", (e) => {
        if (e.target.matches(".btn-delete-relay")) {
            relayManager.removeRelayAt(Number(e.target.dataset.index));
            renderRelayList();
        }
    });
    // Relay Input Input (Debounceせず保存もしない、値の更新のみ)
    dom.relayListEl?.addEventListener("input", (e) => {
        if (e.target.matches(".relay-input")) {
             relayManager.replaceRelayAt(Number(e.target.dataset.index), e.target.value);
        }
    });
    dom.btnSaveRelays?.addEventListener("click", () => {
        relayManager.syncClients();
        toggleModal(dom.relayModal, false);
        relayManager.connectAll();
        nostrClient.startSubscription();
        alert("リレー設定を更新しました");
    });

    // NG Word Actions
    dom.btnAddNgWord?.addEventListener("click", () => {
        try { ngWordManager.addUserWord(dom.ngWordInput.value); dom.ngWordInput.value = ""; renderNgWordList(); }
        catch (e) { alert(e.message); }
    });
    dom.ngWordListEl?.addEventListener("click", (e) => {
        if(e.target.matches(".btn-delete-ng")) {
            ngWordManager.removeUserWord(Number(e.target.dataset.index));
            renderNgWordList();
        }
    });
    
    // ★ パフォーマンス改善: NGワードの編集は入力のたびに保存せず、Saveボタンで確定させるか、
    // どうしてもリアルタイムにするならDebounceが必要。
    // ここではシンプルに「入力イベントでメモリ上の配列だけ更新し、Saveボタンで保存」という流れに見えるが、
    // 元コードはInputで即保存していた。ここではDebounceを使って入力遅延保存を実装。
    const debouncedSaveNg = utils.debounce((newWords) => {
        ngWordManager.setUserWords(newWords);
    }, 500);

    dom.ngWordListEl?.addEventListener("input", (e) => {
        if (e.target.matches(".ng-input")) {
            const inputs = dom.ngWordListEl.querySelectorAll(".ng-input");
            const newWords = Array.from(inputs).map(i => i.value.trim()).filter(v => v);
            debouncedSaveNg(newWords);
        }
    });

    // 左右スクロール
    dom.btnScrollLeft?.addEventListener("click", () => dom.timeline?.scrollBy({left: -300, behavior: "smooth"}));
    dom.btnScrollRight?.addEventListener("click", () => dom.timeline?.scrollBy({left: 300, behavior: "smooth"}));
  }

  function bindEventBus() {
    eventBus.on("relayList.updated", renderRelayList);
    eventBus.on("relay.open", renderRelayList);
    eventBus.on("relay.close", renderRelayList);
    eventBus.on("ngwords.loaded", renderNgWordList);
    eventBus.on("ngwords.updated", renderNgWordList);
    eventBus.on("nostr.subscriptionStarted", () => { if(dom.timeline) dom.timeline.innerHTML = ""; });
    eventBus.on("nostr.event", renderEvent);
  }

  bindEventListeners();
  bindEventBus();
  
  return { showAlert: alert };
}

/* =========================
   8. 初期化・起動
   ========================= */
window.addEventListener("DOMContentLoaded", async () => {
  const ngWordManager = createNgWordManager();
  const relayManager = createRelayManager();
  const nostrClient = createNostrClient({ relayManager, ngWordManager });
  
  createUI({ relayManager, ngWordManager, nostrClient });

  // 初期化シーケンス
  await ngWordManager.loadDefault();
  relayManager.connectAll();
  nostrClient.startSubscription();

  // ログ
  eventBus.on("relay.open", ({ url }) => console.log(`CONNECTED: ${url}`));
  eventBus.on("relay.error", ({ url, error }) => console.warn(`ERROR ${url}:`, error));
});
