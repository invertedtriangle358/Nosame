/* =========================
   app.js — 統合版
   元コード + リファクタ箇所を組み合わせたもの
   ========================= */

/* =========================
   0. 定数
   ========================= */
const MAX_POST_LENGTH = 108;
const EVENT_BUFFER_FLUSH_TIME_MS = 200;
const NOSTR_REQ_LIMIT = 30;
const NOSTR_REQ_SINCE_SECONDS_AGO = 3600;
const DEFAULT_RELAYS = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co"
];
const NGWORDS_JSON_PATH = "./ngwords.json";

/* =========================
   1. シンプル Pub/Sub (イベントバス)
   ========================= */
const eventBus = (() => {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => { handlers.set(event, handlers.get(event).filter(h => h !== fn)); };
    },
    emit(event, payload) {
      (handlers.get(event) || []).slice().forEach(fn => {
        try { fn(payload); } catch (e) { console.error("eventBus handler error", e); }
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
   3. Validator (純関数群)
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
    return typeof text === "string" && text.length > MAX_POST_LENGTH;
  }
};

/* =========================
   4. NGワード管理 (読み込み・判定・永続化)
   ========================= */
function createNgWordManager({ jsonPath = NGWORDS_JSON_PATH } = {}) {
  let defaultNg = []; // 編集不可
  let userNg = storage.getJson("userNgWords", []);

  async function loadDefault() {
    try {
      const res = await fetch(`${jsonPath}?_=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (Array.isArray(json)) defaultNg = json.map(String);
      else console.warn("ngwords.json は配列を期待");
      // DO NOT copy default -> user to avoid duplication
      eventBus.emit("ngwords.loaded", { defaultNg, userNg });
    } catch (e) {
      console.warn("NGワード読み込み失敗:", e);
      defaultNg = [];
      eventBus.emit("ngwords.loadFailed", e);
    }
  }

  function getAll() {
    const set = new Set();
    defaultNg.forEach(w => set.add(String(w).toLowerCase()));
    (Array.isArray(userNg) ? userNg : []).forEach(w => set.add(String(w).toLowerCase()));
    return Array.from(set);
  }

  function isInvalid(text) {
    if (!text) return false;
    if (validator.isContentTooLong(text)) return true;
    const lower = String(text).toLowerCase();
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
    if (index < 0 || index >= userNg.length) throw new Error("index 範囲外");
    userNg.splice(index, 1);
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", { userNg });
  }

  function setUserWords(list) {
    userNg = Array.isArray(list) ? list.map(String) : [];
    storage.setJson("userNgWords", userNg);
    eventBus.emit("ngwords.updated", { userNg });
  }

  function getUserWords() { return [...userNg]; }
  function getDefaultWords() { return [...defaultNg]; }

  return { loadDefault, isInvalid, addUserWord, removeUserWord, setUserWords, getUserWords, getDefaultWords, getAll };
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
        console.error("relay message parse error", e, ev.data);
      }
    };
  }

  function close() {
    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
      ws = null;
      ready = false;
    }
  }

  function send(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws) {
        ws.addEventListener("open", () => {
          try { ws.send(JSON.stringify(data)); } catch (e) { eventBus.emit("relay.error", { url, error: e }); }
        }, { once: true });
      } else {
        eventBus.emit("relay.error", { url, error: new Error("WebSocket 未接続") });
      }
      return false;
    }
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      eventBus.emit("relay.error", { url, error: e });
      return false;
    }
  }

  function isOpen() { return ready && ws && ws.readyState === WebSocket.OPEN; }

  return { url, connect, close, send, isOpen: isOpen, raw: () => ws };
}

function createRelayManager({ initialRelays = DEFAULT_RELAYS } = {}) {
  let relayList = storage.getJson("relays", initialRelays.slice());
  let clients = new Map();

  function syncClients() {
    // remove missing
    for (const [keyUrl, client] of clients.entries()) {
      if (!relayList.find(u => validator.normalizeUrl(u).toLowerCase() === validator.normalizeUrl(keyUrl).toLowerCase())) {
        client.close();
        clients.delete(keyUrl);
      }
    }
    // add new
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
    if (!trimmed) throw new Error("URLを入力してください。");
    if (!validator.isValidRelayUrl(trimmed)) throw new Error("無効なリレーURLです。wss:// または ws:// で始まる必要があります。");
    const normalized = validator.normalizeUrl(trimmed);
    if (relayList.find(u => validator.normalizeUrl(u).toLowerCase() === normalized.toLowerCase())) {
      throw new Error("すでに登録済みのURLです。");
    }
    relayList.push(trimmed);
    storage.setJson("relays", relayList);
    syncClients();
  }

  function removeRelayAt(index) {
    if (index < 0 || index >= relayList.length) throw new Error("index 範囲外");
    relayList.splice(index, 1);
    storage.setJson("relays", relayList);
    syncClients();
  }

  function replaceRelayAt(index, newUrl) {
    relayList[index] = String(newUrl).trim();
    storage.setJson("relays", relayList);
    syncClients();
  }

  function getStatus(url) {
    const normalized = validator.normalizeUrl(url);
    const c = clients.get(normalized);
    return c ? c.isOpen() : false;
  }

  function broadcast(data) {
    let sentCount = 0;
    for (const client of clients.values()) {
      try {
        if (client.isOpen()) {
          if (client.send(data)) sentCount++;
        } else {
          client.send(data);
        }
      } catch (e) {
        console.error("broadcast error", e);
      }
    }
    return sentCount;
  }

  function connectAll() {
    for (const client of clients.values()) client.connect();
    if (clients.size === 0) syncClients();
  }

  function closeAll() {
    for (const client of clients.values()) client.close();
  }

  function getRelayList() { return [...relayList]; }

  // init
  syncClients();

  return { addRelay, removeRelayAt, replaceRelayAt, getStatus, broadcast, connectAll, closeAll, getRelayList, syncClients };
}

/* =========================
   6. Nostr 高レベルクライアント
   ========================= */

function createNostrClient({ relayManager, ngWordManager } = {}) {
  let subId = null;
  let seenEventIds = new Set();
  let reactedEventIds = new Set();
  let eventBuffer = [];
  let bufferTimer = null;

  function ensureNip07() {
    if (!window.nostr) throw new Error("NIP-07 対応の拡張機能が必要です。");
  }

  function startSubscription() {
    subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
    seenEventIds.clear();
    eventBus.emit("nostr.subscriptionStarted", { subId });
    const filter = {
      kinds: [1],
      limit: NOSTR_REQ_LIMIT,
      since: Math.floor(Date.now() / 1000) - NOSTR_REQ_SINCE_SECONDS_AGO
    };
    const req = ["REQ", subId, filter];
    relayManager.broadcast(req);
  }

  function handleRelayMessage({ url, data }) {
    if (!Array.isArray(data) || data.length < 3) return;
    const [type, rSubId, event] = data;
    if (type !== "EVENT" || !event || rSubId !== subId) return;

    if (seenEventIds.has(event.id)) return;
    if (ngWordManager && ngWordManager.isInvalid(event.content)) return;

    seenEventIds.add(event.id);
    bufferEvent(event);
  }

  function bufferEvent(event) {
    eventBuffer.push(event);
    if (!bufferTimer) {
      bufferTimer = setTimeout(() => flushEventBuffer(), EVENT_BUFFER_FLUSH_TIME_MS);
    }
  }

  function flushEventBuffer() {
    eventBuffer.sort((a, b) => a.created_at - b.created_at);
    for (const e of eventBuffer) eventBus.emit("nostr.event", e);
    eventBuffer = [];
    bufferTimer = null;
  }

  async function signEvent(event) {
    ensureNip07();
    return await window.nostr.signEvent(event);
  }

  function publishEvent(signedEvent) {
    if (!signedEvent || !signedEvent.id) throw new Error("signedEvent が不正です。");
    const payload = ["EVENT", signedEvent];
    const sent = relayManager.broadcast(payload);
    if (sent === 0) throw new Error("接続中のリレーがありません。");
    if (!seenEventIds.has(signedEvent.id)) {
      seenEventIds.add(signedEvent.id);
      eventBus.emit("nostr.event", signedEvent);
    }
    return sent;
  }

  async function createAndPublishPost(content) {
    ensureNip07();
    if (!content || !String(content).trim()) throw new Error("本文を入力してください。");
    if (ngWordManager && ngWordManager.isInvalid(content)) throw new Error("NGワードまたは文字数制限を超えています。");
    const pubkey = await window.nostr.getPublicKey();
    const newEvent = {
      kind: 1,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      pubkey
    };
    const signed = await signEvent(newEvent);
    publishEvent(signed);
    return signed;
  }

  async function reactToEvent(targetEvent) {
    ensureNip07();
    if (!targetEvent || !targetEvent.id) throw new Error("対象イベントが無効です。");
    if (reactedEventIds.has(targetEvent.id)) throw new Error("既にリアクション済みです。");

    const pubkey = await window.nostr.getPublicKey();
    const reactionEvent = {
      kind: 7,
      content: "+",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
      pubkey
    };
    const signed = await signEvent(reactionEvent);
    publishEvent(signed);
    reactedEventIds.add(targetEvent.id);
    eventBus.emit("nostr.reacted", { eventId: targetEvent.id });
    return signed;
  }

  eventBus.on("relay.message", handleRelayMessage);

  return { startSubscription, publishEvent, createAndPublishPost, reactToEvent, seenEventIds, reactedEventIds };
}

/* =========================
   7. UI レンダラー（唯一 DOM を操作）
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
    btnScrollLeft: document.getElementById("scrollLeft"),
    btnScrollRight: document.getElementById("scrollRight"),
    relayInput: document.getElementById("relayInput"),
    btnNgModal: document.getElementById("btnNgModal"),
    ngModal: document.getElementById("ngModal"),
    btnAddNgWord: document.getElementById("btnAddNgWord"),
    btnSaveNgWords: document.getElementById("btnSaveNgWords"),
    btnCloseNgModal: document.getElementById("btnCloseNgModal"),
    ngWordInput: document.getElementById("ngWordInput"),
    ngWordListEl: document.getElementById("ngWordList"),
  };

  function showAlert(msg) {
    alert(msg);
  }

  function toggleModal(modalEl, open = true) {
    if (!modalEl) return;
    modalEl.style.display = open ? "block" : "none";
    modalEl.setAttribute("aria-hidden", String(!open));
    document.body.style.overflow = open ? "hidden" : "";
  }

  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/[&<>"']/g, s => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[s]));
  }

  function formatContent(text) {
    const specialWords = [{ word: "【緊急地震速報】", color: "#dd0000" }];
    let safe = escapeHtml(text);
    for (const { word, color } of specialWords) {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(${esc})`, "g");
      safe = safe.replace(re, `<span style="color:${color}">$1</span>`);
    }
    return safe;
  }

  function renderRelayList() {
    if (!dom.relayListEl) return;
    dom.relayListEl.innerHTML = "";
    const list = relayManager.getRelayList();
    list.forEach((url, idx) => {
      const row = document.createElement("div");
      row.className = "relay-row";
      const status = relayManager.getStatus(url) ? "🟢" : "🔴";
      row.innerHTML = `
        <span class="relay-status">${status}</span>
        <input data-index="${idx}" class="relay-input" type="text" value="${escapeHtml(url)}">
        <button class="btn-delete-relay" data-index="${idx}">✖</button>
      `;
      dom.relayListEl.appendChild(row);
    });
  }

  function renderNgWordList() {
    if (!dom.ngWordListEl) return;
    dom.ngWordListEl.innerHTML = "";

    const defaults = ngWordManager.getDefaultWords();
    defaults.forEach(word => {
      const row = document.createElement("div");
      row.className = "ng-word-item ng-default";
      row.innerHTML = `
        <input type="text" value="${escapeHtml(word)}" disabled>
        <button disabled style="opacity:0.4;">✖</button>
      `;
      dom.ngWordListEl.appendChild(row);
    });

    const users = ngWordManager.getUserWords();
    users.forEach((word, idx) => {
      const row = document.createElement("div");
      row.className = "ng-word-item";
      row.innerHTML = `
        <input data-index="${idx}" class="ng-input" type="text" value="${escapeHtml(word)}">
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
        <span class="author">${escapeHtml((event.pubkey || "").slice(0, 8))}...</span>
      </div>
      <button class="btn-reaction" data-id="${escapeHtml(event.id)}" ${isReacted ? "disabled" : ""}>
        ${isReacted ? "♥" : "♡"}
      </button>
    `;
    const btn = noteEl.querySelector(".btn-reaction");
    btn.addEventListener("click", async () => {
      try {
        btn.disabled = true;
        await nostrClient.reactToEvent(event);
        btn.textContent = "❤️";
      } catch (err) {
        btn.disabled = false;
        showAlert(`リアクション失敗: ${err.message || err}`);
      }
    });

    const children = Array.from(dom.timeline.children);
    const insertPos = children.find(el => Number(el.dataset.createdAt) > event.created_at);
    if (insertPos) dom.timeline.insertBefore(noteEl, insertPos);
    else dom.timeline.appendChild(noteEl);
  }

  function clearTimeline() {
    if (dom.timeline) dom.timeline.innerHTML = "";
  }

  function bindEventListeners() {
    dom.btnPublish?.addEventListener("click", async () => {
      try {
        const content = (dom.composeArea.value || "").trim();
        const signed = await nostrClient.createAndPublishPost(content);
        dom.composeArea.value = "";
        dom.charCount.textContent = `0 / ${MAX_POST_LENGTH}`;
        showAlert("投稿しました。");
      } catch (err) {
        showAlert(`投稿失敗: ${err.message || err}`);
      }
    });

    dom.btnRelayModal?.addEventListener("click", () => {
      toggleModal(dom.relayModal, true);
      renderRelayList();
    });
    dom.btnCloseModal?.addEventListener("click", () => toggleModal(dom.relayModal, false));

    dom.btnAddRelay?.addEventListener("click", () => {
      try {
        const url = dom.relayInput.value || "";
        relayManager.addRelay(url);
        dom.relayInput.value = "";
        renderRelayList();
      } catch (err) {
        showAlert(err.message || err);
      }
    });

    dom.relayListEl?.addEventListener("click", (e) => {
      const t = e.target;
      if (t.classList.contains("btn-delete-relay")) {
        try {
          relayManager.removeRelayAt(Number(t.dataset.index));
          renderRelayList();
        } catch (err) { showAlert(err.message || err); }
      }
    });

    dom.relayListEl?.addEventListener("input", (e) => {
      const t = e.target;
      if (t.classList.contains("relay-input")) {
        const idx = Number(t.dataset.index);
        try {
          relayManager.replaceRelayAt(idx, t.value);
        } catch (err) {}
      }
    });

    dom.btnSaveRelays?.addEventListener("click", () => {
      try {
        relayManager.syncClients();
        toggleModal(dom.relayModal, false);
        relayManager.connectAll();
        nostrClient.startSubscription();
        showAlert("リレー設定を保存しました。再接続します。");
      } catch (err) {
        showAlert(err.message || err);
      }
    });

    dom.btnNgModal?.addEventListener("click", () => {
      toggleModal(dom.ngModal, true);
      renderNgWordList();
    });
    dom.btnCloseNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, false));

    dom.btnAddNgWord?.addEventListener("click", () => {
      try {
        ngWordManager.addUserWord(dom.ngWordInput.value || "");
        dom.ngWordInput.value = "";
        renderNgWordList();
      } catch (err) {
        showAlert(err.message || err);
      }
    });

    dom.ngWordListEl?.addEventListener("click", (e) => {
      if (e.target.classList.contains("btn-delete-ng")) {
        try {
          ngWordManager.removeUserWord(Number(e.target.dataset.index));
          renderNgWordList();
        } catch (err) { showAlert(err.message || err); }
      }
    });

    dom.ngWordListEl?.addEventListener("input", (e) => {
      if (e.target.classList.contains("ng-input")) {
        const inputs = dom.ngWordListEl.querySelectorAll(".ng-input");
        const newWords = Array.from(inputs).map(i => i.value.trim()).filter(v => v);
        ngWordManager.setUserWords(newWords);
        renderNgWordList();
      }
    });

    dom.btnSaveNgWords?.addEventListener("click", () => {
      try {
        ngWordManager.setUserWords(ngWordManager.getUserWords());
        showAlert("NGワードを保存しました。");
        renderNgWordList();
      } catch (err) { showAlert(err.message || err); }
    });

    dom.btnScrollLeft?.addEventListener("click", () => dom.timeline?.scrollBy({ left: -300, behavior: "smooth" }));
    dom.btnScrollRight?.addEventListener("click", () => dom.timeline?.scrollBy({ left: 300, behavior: "smooth" }));

    dom.composeArea?.addEventListener("input", (e) => {
      const len = (e.target.value || "").length;
      if (dom.charCount) {
        dom.charCount.textContent = `${len} / ${MAX_POST_LENGTH}`;
        dom.charCount.style.color = len > MAX_POST_LENGTH ? "red" : "";
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        toggleModal(dom.relayModal, false);
        toggleModal(dom.ngModal, false);
      }
    });

    document.querySelectorAll(".modal").forEach(modal => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) toggleModal(modal, false);
      });
    });
  }

  function bindEventBus() {
    eventBus.on("relayList.updated", ({ relayList } = {}) => renderRelayList());
    eventBus.on("relay.open", () => renderRelayList());
    eventBus.on("relay.close", () => renderRelayList());
    eventBus.on("ngwords.loaded", () => renderNgWordList());
    eventBus.on("ngwords.updated", () => renderNgWordList());
    eventBus.on("nostr.subscriptionStarted", () => {
      clearTimeline();
    });
    eventBus.on("nostr.event", (event) => {
      renderEvent(event);
    });
    eventBus.on("ngwords.loadFailed", (err) => {
      console.warn("NGワード読み込み失敗 (UI通知可能):", err);
    });
  }

  bindEventListeners();
  bindEventBus();

  return { renderRelayList, renderNgWordList, renderEvent, clearTimeline, showAlert };
}

/* =========================
   8. 初期化・起動
   ========================= */

window.addEventListener("DOMContentLoaded", async () => {
  const ngWordManager = createNgWordManager({ jsonPath: NGWORDS_JSON_PATH });
  const relayManager = createRelayManager({ initialRelays: DEFAULT_RELAYS });
  const nostrClient = createNostrClient({ relayManager, ngWordManager });
  const ui = createUI({ relayManager, ngWordManager, nostrClient });

  await ngWordManager.loadDefault();

  relayManager.connectAll();
  nostrClient.startSubscription();

  eventBus.on("relay.open", ({ url } = {}) => eventBus.emit("status.info", { text: `接続: ${url}` }));
  eventBus.on("relay.close", ({ url } = {}) => eventBus.emit("status.info", { text: `切断: ${url}` }));
  eventBus.on("relay.error", ({ url, error } = {}) => console.warn("relay error", url, error));

  window.__app_debug = { ngWordManager, relayManager, nostrClient, eventBus, ui };
});
