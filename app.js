/* =========================
   0. Infrastructure & Config
   ========================= */
const AppConfig = {
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
  NIP07_WAIT_LIMIT: 10,
};

// 汎用ユーティリティ
const DomUtils = {
  // 安全な要素生成 (XSS対策: innerHTMLを避ける)
  create(tag, { className = "", text = "", attributes = {}, children = [] } = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    Object.entries(attributes).forEach(([k, v]) => {
      if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
      if (k === 'disabled' && v) el.disabled = true;
    });
    children.forEach(child => child && el.appendChild(child));
    return el;
  },
  // リストのクリア
  clear(el) {
    if (el) el.innerHTML = "";
  }
};

const AsyncUtils = {
  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  async waitForNostr(limit) {
    if (window.nostr) return window.nostr;
    for (let i = 0; i < limit; i++) {
      await this.sleep(200);
      if (window.nostr) return window.nostr;
    }
    throw new Error("NIP-07 拡張機能が見つかりません。");
  }
};

const ValidationUtils = {
  isValidRelayUrl(url) {
    try {
      const u = new URL(url);
      return (u.protocol === "wss:" || u.protocol === "ws:") && !!u.hostname;
    } catch { return false; }
  },
  normalizeUrl: (url) => String(url || "").replace(/\/+$/, "")
};

// EventBus
const createEventBus = () => {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      // Unsubscribe関数を返す
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
};

// Storage Adapter (DIPのための抽象化)
const createStorage = (prefix = "nostr_app_") => ({
  getJson(key, fallback) {
    try {
      const v = localStorage.getItem(prefix + key);
      return v ? JSON.parse(v) : (typeof fallback === "function" ? fallback() : fallback);
    } catch { return fallback; }
  },
  setJson(key, value) {
    try { localStorage.setItem(prefix + key, JSON.stringify(value)); }
    catch (e) { console.warn("Storage failed", e); }
  }
});

/* =========================
   1. Domain Services
   ========================= */

// NG Word Domain Service
function createNgWordService({ config, storage, eventBus }) {
  let defaultNg = [];
  let userNg = storage.getJson("userNgWords", []);

  async function loadDefault() {
    try {
      const res = await fetch(`${config.NGWORDS_JSON_PATH}?_=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (Array.isArray(json)) defaultNg = json.map(String);
      eventBus.emit("ngwords.updated", getAll());
    } catch (e) {
      console.warn("NGワード読み込み失敗:", e);
    }
  }

  function getAll() {
    return Array.from(new Set([...defaultNg, ...userNg].map(w => String(w).toLowerCase())));
  }

  function isInvalid(text) {
    if (!text) return false;
    if (text.length > config.MAX_POST_LENGTH) return true;
    const lower = text.toLowerCase();
    return getAll().some(ng => ng && lower.includes(ng));
  }

  function addUserWord(word) {
    const trimmed = String(word || "").trim().toLowerCase();
    if (!trimmed) throw new Error("空のNGワードは無効です");
    if (getAll().includes(trimmed)) throw new Error("登録済みです");
    
    userNg.push(trimmed);
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", getAll());
  }

  function removeUserWord(wordToRemove) {
    userNg = userNg.filter(w => w !== wordToRemove);
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", getAll());
  }

  return {
    loadDefault, isInvalid, addUserWord, removeUserWord,
    getUserWords: () => [...userNg],
    getDefaultWords: () => [...defaultNg]
  };
}

// Relay Domain Service
function createRelayService({ config, storage, eventBus }) {
  const clients = new Map(); // normalizedUrl -> WebSocket
  let relayList = storage.getJson("relays", config.DEFAULT_RELAYS.slice());

  function getClient(url) {
    const norm = ValidationUtils.normalizeUrl(url);
    if (clients.has(norm)) return clients.get(norm);

    try {
      const ws = new WebSocket(url);
      ws.onopen = () => eventBus.emit("relay.status", { url: norm, status: "open" });
      ws.onclose = () => eventBus.emit("relay.status", { url: norm, status: "closed" });
      ws.onerror = (e) => eventBus.emit("relay.error", { url: norm, error: e });
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          eventBus.emit("relay.message", { url: norm, data });
        } catch {}
      };
      clients.set(norm, ws);
      return ws;
    } catch (e) {
      console.warn(`Invalid Relay: ${url}`);
      return null;
    }
  }

  function syncConnection() {
    // 削除されたリレーを閉じる
    for (const [url, ws] of clients.entries()) {
      if (!relayList.some(r => ValidationUtils.normalizeUrl(r) === url)) {
        ws.close();
        clients.delete(url);
      }
    }
    // 新規リレーに接続
    relayList.forEach(url => getClient(url));
    eventBus.emit("relay.listUpdated", [...relayList]);
  }

  function broadcast(data) {
    let count = 0;
    const msg = JSON.stringify(data);
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        count++;
      }
    });
    return count;
  }

  function addRelay(url) {
    if (!ValidationUtils.isValidRelayUrl(url)) throw new Error("無効なURLです");
    const norm = ValidationUtils.normalizeUrl(url);
    if (relayList.some(r => ValidationUtils.normalizeUrl(r) === norm)) throw new Error("登録済みです");
    
    relayList.push(url);
    storage.setJson("relays", relayList);
    syncConnection();
  }

  function removeRelay(url) {
    const norm = ValidationUtils.normalizeUrl(url);
    relayList = relayList.filter(r => ValidationUtils.normalizeUrl(r) !== norm);
    storage.setJson("relays", relayList);
    syncConnection();
  }
  
  function getStatus(url) {
    const ws = clients.get(ValidationUtils.normalizeUrl(url));
    return ws?.readyState === WebSocket.OPEN;
  }

  return {
    syncConnection, broadcast, addRelay, removeRelay, getStatus,
    getRelayList: () => [...relayList]
  };
}

// Nostr Logic Service
function createNostrService({ config, eventBus, relayService, ngWordService }) {
  let subId = null;
  const state = {
    seenEvents: new Set(),
    reactedEvents: new Set(),
    buffer: []
  };
  let bufferTimer = null;

  function handleMessage({ data }) {
    if (!Array.isArray(data) || data[0] !== "EVENT" || data[1] !== subId) return;
    const event = data[2];
    
    if (!event || state.seenEvents.has(event.id)) return;
    if (ngWordService.isInvalid(event.content)) return;

    state.seenEvents.add(event.id);
    state.buffer.push(event);

    if (!bufferTimer) {
      bufferTimer = setTimeout(() => {
        state.buffer.sort((a, b) => a.created_at - b.created_at);
        state.buffer.forEach(e => eventBus.emit("nostr.event", e));
        state.buffer = [];
        bufferTimer = null;
      }, config.EVENT_BUFFER_FLUSH_TIME_MS);
    }
  }

  eventBus.on("relay.message", handleMessage);

  async function publish(kind, content, tags = []) {
    const nostr = await AsyncUtils.waitForNostr(config.NIP07_WAIT_LIMIT);
    const pubkey = await nostr.getPublicKey();
    
    const event = {
      kind,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      pubkey
    };
    
    const signed = await nostr.signEvent(event);
    if(!signed.id) throw new Error("署名失敗");

    // 自イベントは即時反映
    if (!state.seenEvents.has(signed.id)) {
      state.seenEvents.add(signed.id);
      eventBus.emit("nostr.event", signed);
    }
    
    relayService.broadcast(["EVENT", signed]);
    return signed;
  }

  return {
    startSubscription() {
      subId = `sub-${Math.random().toString(36).slice(2)}`;
      state.seenEvents.clear();
      eventBus.emit("timeline.clear");
      
      const filter = {
        kinds: [1],
        limit: config.NOSTR_REQ_LIMIT,
        since: Math.floor(Date.now() / 1000) - config.NOSTR_REQ_SINCE_SECONDS_AGO
      };
      relayService.broadcast(["REQ", subId, filter]);
    },
    async postContent(text) {
      if (!text.trim()) throw new Error("本文が必要です");
      if (ngWordService.isInvalid(text)) throw new Error("NGワードまたは文字数制限");
      return publish(1, text);
    },
    async react(targetEvent) {
      if (state.reactedEvents.has(targetEvent.id)) throw new Error("リアクション済み");
      await publish(7, "+", [["e", targetEvent.id], ["p", targetEvent.pubkey]]);
      state.reactedEvents.add(targetEvent.id);
      eventBus.emit("nostr.reactionUpdate", targetEvent.id);
    },
    isReacted: (id) => state.reactedEvents.has(id)
  };
}

/* =========================
   2. UI / Presentation Layer
   ========================= */

// 設定モーダル共通UI
const ModalRenderer = {
  bindToggle(btnId, modalId, closeId) {
    const modal = document.getElementById(modalId);
    if(!modal) return;
    const open = () => { modal.style.display = "block"; document.body.style.overflow = "hidden"; };
    const close = () => { modal.style.display = "none"; document.body.style.overflow = ""; };
    
    document.getElementById(btnId)?.addEventListener("click", open);
    document.getElementById(closeId)?.addEventListener("click", close);
    return { open, close, el: modal };
  }
};

// リレー設定リストの描画
function initRelaySettingsUI({ relayService, eventBus }) {
  const listEl = document.getElementById("relayList");
  const inputEl = document.getElementById("relayInput");
  const addBtn = document.getElementById("btnAddRelay");

  function render() {
    DomUtils.clear(listEl);
    const relays = relayService.getRelayList();
    
    relays.forEach(url => {
      const isOpen = relayService.getStatus(url);
      const row = DomUtils.create("div", {
        className: "relay-row",
        children: [
          DomUtils.create("span", { 
            className: "relay-status", 
            text: isOpen ? "🟢" : "🔴" 
          }),
          DomUtils.create("span", { 
            className: "relay-url", // InputではなくText表示にしてシンプル化
            text: url,
            attributes: { style: "flex:1; margin:0 10px;" }
          }),
          DomUtils.create("button", { 
            className: "btn-delete-relay", 
            text: "✖",
            attributes: { "data-url": url }
          })
        ]
      });
      listEl.appendChild(row);
    });
  }

  // Event Binding
  addBtn?.addEventListener("click", () => {
    try {
      relayService.addRelay(inputEl.value);
      inputEl.value = "";
    } catch(e) { alert(e.message); }
  });

  listEl?.addEventListener("click", (e) => {
    if (e.target.matches(".btn-delete-relay")) {
      relayService.removeRelay(e.target.dataset.url);
    }
  });

  eventBus.on("relay.listUpdated", render);
  eventBus.on("relay.status", render);
  
  ModalRenderer.bindToggle("btnRelayModal", "relayModal", "btnCloseModal");
  render();
}

// NGワード設定の描画
function initNgSettingsUI({ ngWordService, eventBus }) {
  const listEl = document.getElementById("ngWordList");
  const inputEl = document.getElementById("ngWordInput");
  const addBtn = document.getElementById("btnAddNgWord");

  function render() {
    DomUtils.clear(listEl);
    
    // Default words (Read only)
    ngWordService.getDefaultWords().forEach(word => {
      listEl.appendChild(DomUtils.create("div", {
        className: "ng-word-item ng-default",
        children: [
          DomUtils.create("input", { attributes: { value: word, disabled: true } }),
          DomUtils.create("button", { text: "✖", attributes: { disabled: true } })
        ]
      }));
    });

    // User words
    ngWordService.getUserWords().forEach(word => {
      listEl.appendChild(DomUtils.create("div", {
        className: "ng-word-item",
        children: [
          DomUtils.create("span", { text: word, style: "flex:1" }),
          DomUtils.create("button", { 
            className: "btn-delete-ng", 
            text: "✖",
            attributes: { "data-word": word }
          })
        ]
      }));
    });
  }

  addBtn?.addEventListener("click", () => {
    try {
      ngWordService.addUserWord(inputEl.value);
      inputEl.value = "";
    } catch(e) { alert(e.message); }
  });

  listEl?.addEventListener("click", (e) => {
    if(e.target.matches(".btn-delete-ng")) {
      ngWordService.removeUserWord(e.target.dataset.word);
    }
  });

  eventBus.on("ngwords.updated", render);
  ModalRenderer.bindToggle("btnNgModal", "ngModal", "btnCloseNgModal");
}

// タイムラインと投稿の描画
function initTimelineUI({ nostrService, config, eventBus }) {
  const timelineEl = document.getElementById("timeline");
  const composeEl = document.getElementById("compose");
  const countEl = document.getElementById("charCount");
  const publishBtn = document.getElementById("btnPublish");

  // コンテンツ整形 (一部HTML許可)
  function createContentHtml(text) {
    // 最小限のHTMLエスケープ処理をした上で、特定のキーワードだけ装飾する
    const div = document.createElement("div");
    div.textContent = text;
    let safe = div.innerHTML; 
    
    // 【緊急地震速報】などのハイライト要件がある場合
    const highlights = [{ word: "【緊急地震速報】", color: "#dd0000" }];
    highlights.forEach(({ word, color }) => {
        const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        safe = safe.replace(new RegExp(`(${esc})`, "g"), `<span style="color:${color}">$1</span>`);
    });
    return safe;
  }

  function renderEvent(event) {
    const isReacted = nostrService.isReacted(event.id);
    const dateStr = new Date(event.created_at * 1000).toLocaleString();
    
    const noteEl = DomUtils.create("div", {
      className: "note",
      attributes: { "data-created-at": event.created_at, "data-id": event.id },
      children: [
        DomUtils.create("div", { className: "content" }), // 後でinnerHTMLセット
        DomUtils.create("div", { 
          className: "meta",
          children: [
            DomUtils.create("span", { className: "time", text: dateStr }),
            DomUtils.create("span", { className: "author", text: (event.pubkey || "").slice(0,8) + "..." })
          ]
        }),
        DomUtils.create("button", {
          className: "btn-reaction",
          text: isReacted ? "❤️" : "♡",
          attributes: { disabled: isReacted }
        })
      ]
    });

    // 安全なHTML挿入
    noteEl.querySelector(".content").innerHTML = createContentHtml(event.content);

    // Reaction Handler
    noteEl.querySelector(".btn-reaction").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await nostrService.react(event);
        e.target.textContent = "❤️";
      } catch (err) {
        e.target.disabled = false;
        alert(err.message);
      }
    });

    // 挿入位置 (時系列順)
    const children = Array.from(timelineEl.children);
    const pos = children.find(el => Number(el.dataset.createdAt) > event.created_at);
    if (pos) timelineEl.insertBefore(noteEl, pos);
    else timelineEl.appendChild(noteEl);
  }

  // 投稿ハンドラ
  async function handlePublish() {
    try {
      await nostrService.postContent(composeEl.value);
      composeEl.value = "";
      countEl.textContent = `0 / ${config.MAX_POST_LENGTH}`;
    } catch(e) { alert(e.message); }
  }

  // Listeners
  publishBtn?.addEventListener("click", handlePublish);
  
  composeEl?.addEventListener("input", (e) => {
    const len = e.target.value.length;
    countEl.textContent = `${len} / ${config.MAX_POST_LENGTH}`;
    countEl.style.color = len > config.MAX_POST_LENGTH ? "red" : "";
  });

  composeEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handlePublish();
    }
  });

  // バスイベント
  eventBus.on("nostr.event", renderEvent);
  eventBus.on("timeline.clear", () => DomUtils.clear(timelineEl));
}

/* =========================
   3. Composition Root (Main)
   ========================= */
window.addEventListener("DOMContentLoaded", async () => {
  // Dependencies
  const eventBus = createEventBus();
  conststorage = createStorage();
  
  // Services
  const ngWordService = createNgWordService({ config: AppConfig, storage, eventBus });
  const relayService = createRelayService({ config: AppConfig, storage, eventBus });
  const nostrService = createNostrService({ config: AppConfig, eventBus, relayService, ngWordService });

  // UI Injection
  initRelaySettingsUI({ relayService, eventBus });
  initNgSettingsUI({ ngWordService, eventBus });
  initTimelineUI({ nostrService, config: AppConfig, eventBus });

  // Start logic
  await ngWordService.loadDefault();
  relayService.syncConnection();
  nostrService.startSubscription();
});
