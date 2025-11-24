
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

/* =========================
   0. utils & validator
   ========================= */
const utils = {
  escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/[&<>"']/g, s => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[s]));
  },
  debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  async waitForNostr() {
    if (window.nostr) return window.nostr;
    for (let i = 0; i < CONFIG.NIP07_WAIT_LIMIT; i++) {
      await utils.sleep(200);
      if (window.nostr) return window.nostr;
    }
    throw new Error("NIP-07 対応の拡張機能が見つかりません。");
  }
};

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
    return String(url || "").trim().replace(/\/+$/, "");
  },
  isContentTooLong(text) {
    return typeof text === "string" && text.length > CONFIG.MAX_POST_LENGTH;
  }
};

/* =========================
   1. eventBus (limited)
   - channels: "comm.*" for relay/nostr messages
   - "store.updated" for store change notifications
   ========================= */
const eventBus = (() => {
  const handlers = new Map();
  return {
    on(topic, fn) {
      if (!handlers.has(topic)) handlers.set(topic, []);
      handlers.get(topic).push(fn);
      return () => {
        const list = handlers.get(topic);
        if (list) handlers.set(topic, list.filter(h => h !== fn));
      };
    },
    emit(topic, payload) {
      (handlers.get(topic) || []).slice().forEach(fn => {
        try { fn(payload); } catch (e) { console.error(`EventBus error [${topic}]:`, e); }
      });
    }
  };
})();

/* =========================
   2. storage thin wrapper
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
   3. Lightweight Store
   - holds 4 slices and exposes subscribe/get/set
   - setState merges shallowly for each slice
   ========================= */
function createStore(initial = {}) {
  const state = {
    timelineEvents: initial.timelineEvents || [],
    relays: initial.relays || CONFIG.DEFAULT_RELAYS.slice(),
    ngWords: initial.ngWords || { default: [], user: [] },
    reactedIds: initial.reactedIds || new Set()
  };
  // subscribers per key
  const subs = new Map();

  function getState(key) {
    if (!key) return {
      timelineEvents: [...state.timelineEvents],
      relays: [...state.relays],
      ngWords: { default: [...state.ngWords.default], user: [...state.ngWords.user] },
      reactedIds: new Set(state.reactedIds)
    };
    if (key === "reactedIds") return new Set(state.reactedIds);
    if (key === "ngWords") return { default: [...state.ngWords.default], user: [...state.ngWords.user] };
    return Array.isArray(state[key]) ? [...state[key]] : state[key];
  }

  function subscribe(key, fn) {
    if (!subs.has(key)) subs.set(key, []);
    subs.get(key).push(fn);
    return () => {
      const list = subs.get(key);
      if (list) subs.set(key, list.filter(f => f !== fn));
    };
  }

  function notify(key, value) {
    eventBus.emit("store.updated", { key, value });
    (subs.get(key) || []).slice().forEach(f => {
      try { f(value); } catch (e) { console.error("store subscriber error", e); }
    });
  }

  function setState(key, value) {
    switch (key) {
      case "timelineEvents":
        // value expected to be array; replace
        state.timelineEvents = Array.isArray(value) ? value.slice() : [];
        notify(key, getState(key));
        break;
      case "relays":
        state.relays = Array.isArray(value) ? value.map(validator.normalizeUrl) : [];
        storage.setJson("relays", state.relays);
        notify(key, getState(key));
        break;
      case "ngWords":
        // { default: [], user: [] }
        state.ngWords = {
          default: Array.isArray(value.default) ? value.default.map(String) : [],
          user: Array.isArray(value.user) ? value.user.map(String) : []
        };
        storage.setJson("userNgWords", state.ngWords.user);
        notify(key, getState(key));
        break;
      case "reactedIds":
        state.reactedIds = new Set(value instanceof Set ? value : Array.from(value || []));
        // store reactedIds in localStorage as array (optional)
        storage.setJson("reactedIds", Array.from(state.reactedIds));
        notify(key, getState(key));
        break;
      default:
        console.warn("Unknown store key:", key);
    }
  }

  return { getState, setState, subscribe };
}

/* =========================
   4. NG Word Manager (uses store)
   ========================= */
function createNgWordManager({ store, jsonPath = CONFIG.NGWORDS_JSON_PATH } = {}) {
  async function loadDefault() {
    try {
      const res = await fetch(`${jsonPath}?_=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (Array.isArray(json)) {
        const defaultNg = json.map(String);
        const user = storage.getJson("userNgWords", []);
        store.setState("ngWords", { default: defaultNg, user });
        eventBus.emit("comm.ngwords.loaded", { defaultNg, userNg: user });
      }
    } catch (e) {
      console.warn("NGワード読み込み失敗:", e);
      const defaultNg = [];
      const user = storage.getJson("userNgWords", []);
      store.setState("ngWords", { default: defaultNg, user });
      eventBus.emit("comm.ngwords.loadFailed", e);
    }
  }

  function getAllLower() {
    const s = store.getState("ngWords");
    const merged = [...(s.default || []), ...(s.user || [])].map(String).map(w => w.toLowerCase());
    return new Set(merged.filter(Boolean));
  }

  function isInvalid(text) {
    if (!text) return false;
    if (validator.isContentTooLong(text)) return true;
    const lower = String(text).toLowerCase();
    for (const ng of getAllLower()) {
      if (ng && lower.includes(ng)) return true;
    }
    return false;
  }

  function addUserWord(word) {
    const trimmed = String(word || "").trim().toLowerCase();
    if (!trimmed) throw new Error("空のNGワードは登録できません。");
    const s = store.getState("ngWords");
    const existing = new Set([...(s.default || []), ...(s.user || [])].map(String).map(w => w.toLowerCase()));
    if (existing.has(trimmed)) throw new Error("既に存在するNGワードです。");
    const newUser = [...s.user, trimmed];
    store.setState("ngWords", { default: s.default, user: newUser });
    return trimmed;
  }

  function removeUserWord(index) {
    const s = store.getState("ngWords");
    if (index < 0 || index >= s.user.length) return;
    const newUser = s.user.slice();
    newUser.splice(index, 1);
    store.setState("ngWords", { default: s.default, user: newUser });
  }

  function setUserWords(list) {
    const s = store.getState("ngWords");
    const newUser = Array.isArray(list) ? list.map(String) : [];
    store.setState("ngWords", { default: s.default, user: newUser });
  }

  return { loadDefault, isInvalid, addUserWord, removeUserWord, setUserWords };
}

/* =========================
   5. RelayManager (normalized storage + clients)
   - keeps normalized relayList in store
   - maps normalized URL -> client
   - emits comm.relay.* events via eventBus
   ========================= */
function createRelayManager({ store } = {}) {
  // local clients map uses normalized url as key
  const clients = new Map();

  // initialize store relays from storage if exists
  const stored = storage.getJson("relays", CONFIG.DEFAULT_RELAYS.slice());
  store.setState("relays", stored.map(validator.normalizeUrl));

  function createClient(url) {
    let ws = null;
    let ready = false;

    function connect() {
      if (ws) ws.close();
      try {
        ws = new WebSocket(url);
      } catch (e) {
        eventBus.emit("comm.relay.error", { url, error: e });
        return;
      }
      ws.onopen = () => {
        ready = true;
        eventBus.emit("comm.relay.open", { url });
      };
      ws.onclose = () => {
        ready = false;
        eventBus.emit("comm.relay.close", { url });
      };
      ws.onerror = (err) => {
        eventBus.emit("comm.relay.error", { url, error: err });
      };
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          // publish communication event
          eventBus.emit("comm.relay.message", { url, data: parsed });
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
        eventBus.emit("comm.relay.error", { url, error: e });
        return false;
      }
    }

    function isOpen() {
      return ready && ws?.readyState === WebSocket.OPEN;
    }

    return { connect, close, send, isOpen, url };
  }

  function syncClients() {
    const relayList = store.getState("relays");
    // close removed
    for (const [key, client] of clients.entries()) {
      if (!relayList.includes(key)) {
        client.close();
        clients.delete(key);
      }
    }
    // add new
    relayList.forEach(url => {
      const normalized = validator.normalizeUrl(url);
      if (!clients.has(normalized)) {
        const client = createClient(normalized);
        clients.set(normalized, client);
        client.connect();
      }
    });
    // notify UI via store (already stored)
  }

  function addRelay(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed || !validator.isValidRelayUrl(trimmed)) {
      throw new Error("有効な wss:// URLを入力してください。");
    }
    const normalized = validator.normalizeUrl(trimmed);
    const current = store.getState("relays");
    if (current.includes(normalized)) throw new Error("既に登録済みです。");
    store.setState("relays", [...current, normalized]);
    syncClients();
  }

  function removeRelayAt(index) {
    const current = store.getState("relays");
    if (index >= 0 && index < current.length) {
      const next = current.slice();
      next.splice(index, 1);
      store.setState("relays", next);
      syncClients();
    }
  }

  function replaceRelayAt(index, newUrl) {
    const current = store.getState("relays");
    if (index >= 0 && index < current.length) {
      const next = current.slice();
      next[index] = validator.normalizeUrl(String(newUrl).trim());
      store.setState("relays", next);
      // don't force reconnect here; call syncClients when saving
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
    if (clients.size === 0) syncClients();
    for (const client of clients.values()) client.connect();
  }

  // subscribe to store changes to keep clients in sync automatically
  store.subscribe("relays", () => syncClients());

  // initial sync
  syncClients();

  return { addRelay, removeRelayAt, replaceRelayAt, broadcast, connectAll, getRelayList: () => store.getState("relays"), getStatus: (url) => clients.get(validator.normalizeUrl(url))?.isOpen() ?? false, syncClients };
}

/* =========================
   6. NostrSubscription & NostrPublisher
   - Subscription: manages subId, dedupe, buffer, pushes to store.timelineEvents
   - Publisher: signs & broadcasts, ensures local display & reactedIds management
   ========================= */
function createNostrSubscription({ relayManager, store, ngWordManager } = {}) {
  let subId = null;
  const seenEventIds = new Set();
  let eventBuffer = [];
  let bufferTimer = null;

  function startSubscription() {
    subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
    seenEventIds.clear();
    store.setState("timelineEvents", []); // reset timeline
    eventBus.emit("comm.nostr.subscriptionStarted", { subId });

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
    const current = store.getState("timelineEvents");
    store.setState("timelineEvents", current.concat(eventBuffer));
    eventBuffer = [];
    bufferTimer = null;
  }

  // listen to relay messages (via eventBus)
  const unsub = eventBus.on("comm.relay.message", handleRelayMessage);

  return { startSubscription, dispose: () => unsub() };
}

function createNostrPublisher({ relayManager, store } = {}) {
  const reactedEventIds = store.getState("reactedIds"); // Set

  async function publishEvent(rawEvent) {
    const nostr = await utils.waitForNostr();
    const signed = await nostr.signEvent(rawEvent);
    if (!signed.id) throw new Error("署名に失敗しました");

    // add to timeline immediately if not seen
    const timeline = store.getState("timelineEvents");
    if (!timeline.some(e => e.id === signed.id)) {
      store.setState("timelineEvents", timeline.concat([signed]));
    }

    const sentCount = relayManager.broadcast(["EVENT", signed]);
    if (sentCount === 0) throw new Error("接続中のリレーがありません。");
    return sentCount;
  }

  async function createAndPublishPost(content, ngWordManager) {
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
    const reacted = store.getState("reactedIds");
    if (reacted.has(targetEvent.id)) throw new Error("既にリアクション済みです。");

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
    reacted.add(targetEvent.id);
    store.setState("reactedIds", reacted);
    eventBus.emit("comm.nostr.reacted", { eventId: targetEvent.id });
  }

  return { createAndPublishPost, reactToEvent };
}

/* =========================
   7. UIRenderer
   - Purely converts store state -> DOM
   - Subscribes to store slices
   ========================= */
function createUIRenderer({ store, nostrPublisher } = {}) {
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

    btnNgModal: document.getElementById("btnNgModal"),
    ngModal: document.getElementById("ngModal"),
    btnAddNgWord: document.getElementById("btnAddNgWord"),
    btnSaveNgWords: document.getElementById("btnSaveNgWords"),
    btnCloseNgModal: document.getElementById("btnCloseNgModal"),
    ngWordInput: document.getElementById("ngWordInput"),
    ngWordListEl: document.getElementById("ngWordList"),

    btnScrollLeft: document.getElementById("scrollLeft"),
    btnScrollRight: document.getElementById("scrollRight")
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

  function renderTimeline(events) {
    if (!dom.timeline) return;
    // replace naive approach: create fragment and append (keeps DOM stable)
    dom.timeline.innerHTML = "";
    const frag = document.createDocumentFragment();
    events.forEach(event => {
      const noteEl = document.createElement("div");
      noteEl.className = "note";
      noteEl.dataset.createdAt = event.created_at;
      const isReacted = store.getState("reactedIds").has(event.id);
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
      // attach handler via delegation later; but keep simple: attach here
      const btn = noteEl.querySelector(".btn-reaction");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await nostrPublisher.reactToEvent(event);
          btn.textContent = "❤️";
        } catch (err) {
          btn.disabled = false;
          alert(`失敗: ${err.message}`);
        }
      });
      frag.appendChild(noteEl);
    });
    dom.timeline.appendChild(frag);
  }

  function renderRelayList(relays) {
    if (!dom.relayListEl) return;
    dom.relayListEl.innerHTML = "";
    relays.forEach((url, idx) => {
      const row = document.createElement("div");
      row.className = "relay-row";
      const status = (function() {
        try { return relayStatusIndicator(url); } catch { return "🔴"; }
      })();
      row.innerHTML = `
        <span class="relay-status">${status}</span>
        <input data-index="${idx}" class="relay-input" type="text" value="${utils.escapeHtml(url)}">
        <button class="btn-delete-relay" data-index="${idx}">✖</button>
      `;
      dom.relayListEl.appendChild(row);
    });
  }

  // relayStatusIndicator uses eventBus query function - simple default (can be overridden)
  let relayStatusIndicator = (url) => "🔴"; // placeholder, will be set by UIActions during init

  function renderNgWordList(ngWords) {
    if (!dom.ngWordListEl) return;
    dom.ngWordListEl.innerHTML = "";

    (ngWords.default || []).forEach(word => {
      const row = document.createElement("div");
      row.className = "ng-word-item ng-default";
      row.innerHTML = `<input type="text" value="${utils.escapeHtml(word)}" disabled><button disabled>✖</button>`;
      dom.ngWordListEl.appendChild(row);
    });

    (ngWords.user || []).forEach((word, idx) => {
      const row = document.createElement("div");
      row.className = "ng-word-item";
      row.innerHTML = `
        <input data-index="${idx}" class="ng-input" type="text" value="${utils.escapeHtml(word)}">
        <button class="btn-delete-ng" data-index="${idx}">✖</button>
      `;
      dom.ngWordListEl.appendChild(row);
    });
  }

  // subscribe store slices
  store.subscribe("timelineEvents", (v) => renderTimeline(v));
  store.subscribe("relays", (v) => renderRelayList(v));
  store.subscribe("ngWords", (v) => renderNgWordList(v));
  store.subscribe("reactedIds", () => {
    // re-render timeline to reflect reaction changes (simple approach)
    renderTimeline(store.getState("timelineEvents"));
  });

  // expose helpers for UIActions
  return {
    toggleModal,
    dom,
    setRelayStatusFunc(fn) { relayStatusIndicator = fn; }
  };
}

/* =========================
   8. UIActions
   - wire DOM events to app operations (no direct DOM rendering logic)
   - uses store, relayManager, ngWordManager, nostrPublisher
   ========================= */
function createUIActions({ store, relayManager, ngWordManager, nostrPublisher, uiRenderer } = {}) {
  const { dom, toggleModal, setRelayStatusFunc } = uiRenderer;
  // set relay status indicator to query relayManager
  setRelayStatusFunc((url) => (relayManager.getStatus(url) ? "🟢" : "🔴"));

  // helper: ensure DOM elements exist before binding
  function bind() {
    // Publish button
    dom.btnPublish?.addEventListener("click", async () => {
      const content = dom.composeArea?.value?.trim();
      if (!content) return;
      try {
        await nostrPublisher.createAndPublishPost(content, ngWordManager);
        if (dom.composeArea) dom.composeArea.value = "";
        if (dom.charCount) dom.charCount.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
      } catch (e) { alert(e.message); }
    });

    // char count
    dom.composeArea?.addEventListener("input", (e) => {
      const len = e.target.value.length;
      if (dom.charCount) {
        dom.charCount.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
        dom.charCount.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
      }
    });

    // Ctrl/Cmd+Enter to publish (when compose focused)
    document.addEventListener("keydown", (e) => {
      if (document.activeElement !== dom.composeArea) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        dom.btnPublish?.click();
      }
    });

    // Relay modal
    dom.btnRelayModal?.addEventListener("click", () => { uiRenderer.dom.relayListEl && uiRenderer.dom.relayListEl.scrollTop; uiRenderer.dom.relayListEl; toggleModal(dom.relayModal, true); });
    dom.btnCloseModal?.addEventListener("click", () => toggleModal(dom.relayModal, false));

    // NG modal
    dom.btnNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, true));
    dom.btnCloseNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, false));

    // Add Relay
    dom.btnAddRelay?.addEventListener("click", () => {
      try {
        if (!dom.relayInput) return;
        relayManager.addRelay(dom.relayInput.value);
        dom.relayInput.value = "";
      } catch (e) { alert(e.message); }
    });

    // Relay list actions (delegation)
    dom.relayListEl?.addEventListener("click", (e) => {
      const t = e.target;
      if (t.matches(".btn-delete-relay")) {
        relayManager.removeRelayAt(Number(t.dataset.index));
      }
    });

    // Relay input edit (local replace)
    dom.relayListEl?.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches(".relay-input")) {
        relayManager.replaceRelayAt(Number(t.dataset.index), t.value);
      }
    });

    // Save relays: sync clients & start subscription
    dom.btnSaveRelays?.addEventListener("click", () => {
      relayManager.syncClients();
      toggleModal(dom.relayModal, false);
      relayManager.connectAll();
      // start subscription via comm event so components react
      eventBus.emit("comm.action.startSubscription");
      alert("リレー設定を更新しました");
    });

    // NG Word add
    dom.btnAddNgWord?.addEventListener("click", () => {
      try {
        ngWordManager.addUserWord(dom.ngWordInput.value);
        dom.ngWordInput.value = "";
      } catch (e) { alert(e.message); }
    });

    // NG Word delete via delegation
    dom.ngWordListEl?.addEventListener("click", (e) => {
      const t = e.target;
      if (t.matches(".btn-delete-ng")) {
        ngWordManager.removeUserWord(Number(t.dataset.index));
      }
    });

    // NG Word inline edits -> debounced save to store
    const debouncedSaveNg = utils.debounce(() => {
      const inputs = dom.ngWordListEl?.querySelectorAll(".ng-input") || [];
      const newWords = Array.from(inputs).map(i => i.value.trim()).filter(v => v);
      ngWordManager.setUserWords(newWords);
    }, 500);

    dom.ngWordListEl?.addEventListener("input", (e) => {
      if (e.target.matches(".ng-input")) debouncedSaveNg();
    });

    // Scroll controls
    dom.btnScrollLeft?.addEventListener("click", () => dom.timeline?.scrollBy({ left: -300, behavior: "smooth" }));
    dom.btnScrollRight?.addEventListener("click", () => dom.timeline?.scrollBy({ left: 300, behavior: "smooth" }));

    // When store updated for relays, ensure UI props reflect status via setRelayStatusFunc
    store.subscribe("relays", (relays) => {
      // causing render handled by UIRenderer; the status indicator uses relayManager.getStatus
    });

    // Comm action: start subscription
    eventBus.on("comm.action.startSubscription", () => {
      eventBus.emit("comm.request.startSubscription");
    });
  }

  // simple helper to expose relay status query to UIRenderer if needed
  function getRelayStatus(url) {
    return relayManager.getStatus(url);
  }

  return { bind, getRelayStatus };
}

/* =========================
   9. Boot / init
   ========================= */
window.addEventListener("DOMContentLoaded", async () => {
  // 1) Create store with persisted seeds
  const initialRelays = storage.getJson("relays", CONFIG.DEFAULT_RELAYS.slice()).map(validator.normalizeUrl);
  const initialUserNg = storage.getJson("userNgWords", []);
  const initialReacted = new Set(storage.getJson("reactedIds", []));

  const store = createStore({
    timelineEvents: [],
    relays: initialRelays,
    ngWords: { default: [], user: initialUserNg },
    reactedIds: initialReacted
  });

  // 2) Create managers
  const relayManager = createRelayManager({ store });
  const ngWordManager = createNgWordManager({ store });
  const nostrSubscription = createNostrSubscription({ relayManager, store, ngWordManager });
  const nostrPublisher = createNostrPublisher({ relayManager, store });

  // 3) Renderer & Actions
  const uiRenderer = createUIRenderer({ store, nostrPublisher });
  const uiActions = createUIActions({ store, relayManager, ngWordManager, nostrPublisher, uiRenderer });
  uiActions.bind();

  // 4) wire comm events
  eventBus.on("comm.relay.open", ({ url }) => console.log("CONNECTED:", url));
  eventBus.on("comm.relay.error", ({ url, error }) => console.warn("RELAY ERROR", url, error));
  eventBus.on("comm.relay.close", ({ url }) => console.log("CLOSED:", url));
  // start subscription when requested (from UIActions or boot)
  eventBus.on("comm.request.startSubscription", () => nostrSubscription.startSubscription());

  // 5) init sequence
  await ngWordManager.loadDefault();
  relayManager.connectAll();
  nostrSubscription.startSubscription();
});
