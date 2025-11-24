/**
 * Nostr Client - Refactored for SOLID, KISS, and DRY principles.
 * - EventValidator: Content validation (length/NG words) is separated.
 * - SettingsUIHandler: Complex settings UI logic (Relay/NG word list) is separated.
 * - UIManager: Focuses purely on timeline rendering and primary user interactions.
 * - Timeline flow: Left to right (Oldest -> Newest), new posts insert at the right end, maintaining scroll position.
 */

// =======================
// 1. Constants & Config
// =======================
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
    NG_WORDS_URL: "./ngwords.json"
};

const NOSTR_KINDS = {
    TEXT: 1,
    REACTION: 7,
};

const UI_STRINGS = {
    EMPTY_POST: "本文を入力してください",
    INVALID_CONTENT: "NGワードまたは文字数制限です",
    NIP07_REQUIRED: "NIP-07拡張機能が必要です",
    NO_RELAY: "接続中のリレーがありません",
    INVALID_WSS: "正しいwss URLを入力してください",
    SAVE_RELAY_SUCCESS: "リレー設定を反映して再接続します",
    SAVE_NG_SUCCESS: "NGワードを保存しました",
};

// =======================
// 2. Event Validator (SRP: Event Validation Logic)
// =======================
class EventValidator {
    /** @type {StorageManager} */
    storage;

    /**
     * @param {StorageManager} storage
     */
    constructor(storage) {
        this.storage = storage;
    }

    /**
     * イベントの内容が不正でないかチェックする (文字数制限、NGワードチェック)
     * @param {string} text 
     * @returns {boolean} 不正な場合に true
     */
    isContentInvalid(text) {
        if (!text) return false;
        if (text.length > CONFIG.MAX_POST_LENGTH) return true;
        
        const ngWords = this.storage.getAllNgWords();
        const lower = text.toLowerCase();
        
        return ngWords.some(ng => lower.includes(ng.toLowerCase()));
    }
}


// =======================
// 3. Storage Manager (SRP: Data Persistence)
// =======================
class StorageManager {
    /** @type {string[]} */
    defaultNgWords;

    constructor() {
        this.defaultNgWords = [];
    }

    /** @returns {string[]} */
    getRelays() {
        return JSON.parse(localStorage.getItem("relays")) || [...CONFIG.DEFAULT_RELAYS];
    }

    /** @param {string[]} relays */
    saveRelays(relays) {
        localStorage.setItem("relays", JSON.stringify(relays));
    }

    /** @returns {string[]} */
    getUserNgWords() {
        return JSON.parse(localStorage.getItem("userNgWords")) || [];
    }

    /** @param {string[]} words */
    saveUserNgWords(words) {
        localStorage.setItem("userNgWords", JSON.stringify(words));
    }

    async loadDefaultNgWords() {
        try {
            const res = await fetch(`${CONFIG.NG_WORDS_URL}?${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.defaultNgWords = await res.json();
        } catch (err) {
            console.warn("⚠ NGワードJSONの読み込み失敗:", err);
        }
    }

    /** @returns {string[]} */
    getAllNgWords() {
        return [...new Set([...this.defaultNgWords, ...this.getUserNgWords()])];
    }
}


// =======================
// 4. Nostr Network Client (SRP: Communication)
// =======================
class NostrClient {
    /** @type {StorageManager} */
    storage;
    /** @type {EventValidator} */
    validator;
    /** @type {WebSocket[]} */
    sockets;
    /** @type {string | null} */
    subId;
    /** @type {Set<string>} */
    seenEventIds;
    /** @type {Set<string>} */
    reactedEventIds;
    /** @type {((event: import('./types').Event) => void) | null} */
    onEventCallback;
    /** @type {(() => void) | null} */
    onStatusCallback;

    /**
     * @param {StorageManager} storage 
     * @param {EventValidator} validator 
     */
    constructor(storage, validator) {
        this.storage = storage;
        this.validator = validator;
        this.sockets = [];
        this.subId = null;
        this.seenEventIds = new Set();
        this.reactedEventIds = new Set();
        this.onEventCallback = null;
        this.onStatusCallback = null;
    }

    connect() {
        this.sockets.forEach(ws => ws.close());
        this.sockets = [];

        const relays = this.storage.getRelays();
        relays.forEach(url => {
            if (!url) return;
            try {
                const ws = new WebSocket(url);
                ws.url = url; 
                
                ws.onopen = () => {
                    console.log("✅ 接続:", url);
                    this.notifyStatus();
                    if (this.subId) this._sendReqToSocket(ws);
                };
                ws.onclose = () => { console.log("🔌 切断:", url); this.notifyStatus(); };
                ws.onerror = (err) => { console.error("❌ エラー:", url, err); this.notifyStatus(); };
                ws.onmessage = (ev) => this._handleMessage(ev);
                
                this.sockets.push(ws);
            } catch (e) {
                console.log("接続失敗:", url, e);
            }
        });
        this.notifyStatus();
    }

    notifyStatus() {
        if (this.onStatusCallback) this.onStatusCallback();
    }

    startSubscription() {
        this.subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
        this.seenEventIds.clear();
        this.sockets.forEach(ws => this._sendReqToSocket(ws));
    }

    /** @param {WebSocket} ws */
    _sendReqToSocket(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const filter = {
            kinds: [NOSTR_KINDS.TEXT],
            limit: CONFIG.NOSTR_REQ_LIMIT,
            since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
        };
        const req = ["REQ", this.subId, filter];
        ws.send(JSON.stringify(req));
    }

    /** @param {MessageEvent} ev */
    _handleMessage(ev) {
        try {
            const [type, subId, event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event) return;
            if (this.seenEventIds.has(event.id)) return;

            // NG Check (Validatorに委譲)
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            if (this.onEventCallback) this.onEventCallback(event);
        } catch (e) {
            console.error("MSG処理エラー", e);
        }
    }

    /** @param {string} content */
    async publish(content) {
        if (this.validator.isContentInvalid(content)) throw new Error(UI_STRINGS.INVALID_CONTENT);
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.TEXT,
            content: content,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        return signed;
    }

    /** @param {import('./types').Event} targetEvent */
    async sendReaction(targetEvent) {
        if (this.reactedEventIds.has(targetEvent.id)) return;
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.REACTION,
            content: "+",
            created_at: Math.floor(Date.now() / 1000),
            tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        this.reactedEventIds.add(targetEvent.id);
    }

    /** @param {import('./types').Event} event */
    _broadcast(event) {
        const payload = JSON.stringify(["EVENT", event]);
        let sentCount = 0;
        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
                sentCount++;
            }
        });
        if (sentCount === 0) throw new Error(UI_STRINGS.NO_RELAY);
    }

    /** @param {string} url */
    getRelayStatus(url) {
        const normalized = url.replace(/\/+$/, "");
        const ws = this.sockets.find(s => s.url.replace(/\/+$/, "") === normalized);
        return ws && ws.readyState === WebSocket.OPEN;
    }
}


// =======================
// 5. Settings UI Handler (SRP: Settings View Logic)
// =======================
class SettingsUIHandler {
    /** @type {Object<string, any>} */
    dom;
    /** @type {StorageManager} */
    storage;
    /** @type {NostrClient} */
    client;
    /** @type {UIManager} */
    uiRef;

    /**
     * @param {Object<string, any>} dom
     * @param {StorageManager} storage
     * @param {NostrClient} client
     * @param {UIManager} uiRef
     */
    constructor(dom, storage, client, uiRef) {
        this.dom = dom;
        this.storage = storage;
        this.client = client;
        this.uiRef = uiRef;
    }

    setupListeners() {
        this.dom.buttons.addRelay?.addEventListener("click", () => this._addRelay());
        this.dom.buttons.saveRelays?.addEventListener("click", () => this._saveRelays());
        this.dom.buttons.addNg?.addEventListener("click", () => this._addNgWord());
        this.dom.buttons.saveNg?.addEventListener("click", () => this._saveNgWords());
    }

    /**
     * リスト更新の共通ロジック (DRY)
     * @param {{ container: HTMLElement, getItemList: Function, saveItemList: Function, getStatus?: Function, updateCallback: Function }} options
     */
    _updateList(options) {
        const { container, getItemList, saveItemList, getStatus = null, updateCallback } = options;
        if (!container) return;
        container.innerHTML = "";
        const currentItems = getItemList.call(this.storage);

        currentItems.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = getStatus ? "relay-row" : "ng-word-item";
            
            const statusHtml = getStatus ? `<span class="relay-status">${getStatus.call(this.client, item) ? "🟢" : "🔴"}</span>` : "";
            
            row.innerHTML = `
                ${statusHtml}
                <input type="text" value="${this.uiRef._escape(item)}" data-idx="${idx}">
                <button class="btn-delete-${getStatus ? 'relay' : 'ng'}">✖</button>
            `;

            // Delete
            row.querySelector(`.btn-delete-${getStatus ? 'relay' : 'ng'}`)?.addEventListener("click", () => {
                currentItems.splice(idx, 1);
                saveItemList.call(this.storage, currentItems);
                updateCallback.call(this); // 再描画
            });
            
            // Auto-save on input (リレー設定は即座に保存する)
            if(getStatus) {
                 row.querySelector("input")?.addEventListener("input", (e) => {
                    // DOMのインデックスではなく、直接リストの値を更新
                    currentItems[idx] = e.target.value.trim();
                    saveItemList.call(this.storage, currentItems);
                });
            }

            container.appendChild(row);
        });
    }

    updateRelayList() {
        this._updateList({
            container: this.dom.lists.relays,
            getItemList: this.storage.getRelays,
            saveItemList: this.storage.saveRelays,
            getStatus: this.client.getRelayStatus,
            updateCallback: this.updateRelayList,
        });
    }

    updateNgList() {
        this._updateList({
            container: this.dom.lists.ngWords,
            getItemList: this.storage.getUserNgWords,
            saveItemList: this.storage.saveUserNgWords,
            updateCallback: this.updateNgList,
        });
    }
    
    // --- Relay Handlers ---
    _addRelay() {
        const url = this.dom.inputs.relay?.value?.trim();
        if (!url) return;
        try {
            const u = new URL(url);
            if(u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error();
        } catch {
            return alert(UI_STRINGS.INVALID_WSS);
        }
        const relays = this.storage.getRelays();
        if (!relays.includes(url)) {
            relays.push(url);
            this.storage.saveRelays(relays);
            this.dom.inputs.relay.value = "";
            this.updateRelayList();
        }
    }

    _saveRelays() {
        alert(UI_STRINGS.SAVE_RELAY_SUCCESS);
        this.uiRef._togglePanel(false);
        this.client.connect();
        this.client.startSubscription();
    }
    
    // --- NG Word Handlers ---
    _addNgWord() {
        const w = this.dom.inputs.ng?.value?.trim();
        if (!w) return;
        const words = this.storage.getUserNgWords();
        if (!words.includes(w)) {
            words.push(w);
            this.storage.saveUserNgWords(words);
            this.dom.inputs.ng.value = "";
            this.updateNgList();
        }
    }

    _saveNgWords() {
        alert(UI_STRINGS.SAVE_NG_SUCCESS);
    }
}


// =======================
// 6. UI Manager (SRP: DOM & Rendering)
// =======================
class UIManager {
    /** @type {NostrClient} */
    client;
    /** @type {StorageManager} */
    storage;
    /** @type {Object<string, any>} */
    dom;
    /** @type {any[]} */
    eventBuffer;
    /** @type {number | null} */
    bufferTimer;
    /** @type {SettingsUIHandler | null} */
    settingsHandler;

    /**
     * @param {NostrClient} nostrClient 
     * @param {StorageManager} storage 
     */
    constructor(nostrClient, storage) {
        this.client = nostrClient;
        this.storage = storage;
        this.dom = {};
        this.eventBuffer = [];
        this.bufferTimer = null;
        this.settingsHandler = null; 
    }

    init() {
        // DOM Elements Fetching
        this.dom = {
            timeline: document.getElementById("timeline"),
            spinner: document.getElementById("subscribeSpinner"),
            panel: {
                side: document.getElementById("sidePanel"), overlay: document.getElementById("panelOverlay"),
                btnOpen: document.getElementById("btnPanelToggle"), btnClose: document.getElementById("btnPanelClose"),
            },
            inputs: {
                full: document.getElementById("composeFull"), simple: document.getElementById("composeSimple"),
                sidebar: document.getElementById("composeSidebar"), relay: document.getElementById("relayInput"),
                ng: document.getElementById("ngWordInput"),
            },
            buttons: {
                publishFull: document.getElementById("btnPublish"), publishSimple: document.getElementById("btnPublishSimple"),
                addRelay: document.getElementById("btnAddRelay"), saveRelays: document.getElementById("btnSaveRelays"),
                addNg: document.getElementById("btnAddNgWord"), saveNg: document.getElementById("btnSaveNgWords"),
                scrollLeft: document.getElementById("scrollLeft"), scrollRight: document.getElementById("scrollRight"),
            },
            lists: {
                relays: document.getElementById("relayList"),
                ngWords: document.getElementById("ngWordList"),
            },
            counters: {
                full: document.getElementById("charCount"),
                sidebar: document.getElementById("charCountSidebar"),
            }
        };

        this.settingsHandler = new SettingsUIHandler(this.dom, this.storage, this.client, this);
        
        this._setupListeners();
        
        this.settingsHandler.updateNgList();
        this.settingsHandler.updateRelayList();
    }

    _setupListeners() {
        // Panel 
        this.dom.panel.btnOpen?.addEventListener("click", () => this._togglePanel(true));
        this.dom.panel.btnClose?.addEventListener("click", () => this._togglePanel(false));
        this.dom.panel.overlay?.addEventListener("click", () => this._togglePanel(false));

        // Publish 
        this.dom.buttons.publishSimple?.addEventListener("click", () => this._handlePublish("simple"));
        this.dom.buttons.publishFull?.addEventListener("click", () => this._handlePublish("full"));
        this.dom.inputs.simple?.addEventListener("keydown", (e) => {
             if (e.key === "Enter") { e.preventDefault(); this._handlePublish("simple"); }
        });

        // Settings (委譲)
        this.settingsHandler.setupListeners();

        // Scroll
        this.dom.buttons.scrollLeft?.addEventListener("click", () => this.dom.timeline.scrollBy({ left: -300, behavior: "smooth" }));
        this.dom.buttons.scrollRight?.addEventListener("click", () => this.dom.timeline.scrollBy({ left: 300, behavior: "smooth" }));

        // Inputs
        const checkLen = (input, counter) => {
            if(!input || !counter) return;
            const len = input.value.length;
            counter.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
            counter.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
        };
        this.dom.inputs.full?.addEventListener("input", (e) => checkLen(e.target, this.dom.counters.full));
        this.dom.inputs.sidebar?.addEventListener("input", (e) => checkLen(e.target, this.dom.counters.sidebar));
    }

    /** @param {boolean} open */
    _togglePanel(open) {
        if (!this.dom.panel.side) return;
        this.dom.panel.side.classList.toggle("open", open);
        this.dom.panel.side.setAttribute("aria-hidden", (!open).toString());
        this.dom.panel.overlay.hidden = !open;
    }

    /** @param {string} source */
    async _handlePublish(source) {
        const inputMap = { "simple": this.dom.inputs.simple, "full": this.dom.inputs.full, "sidebar": this.dom.inputs.sidebar };
        const input = inputMap[source];
        const content = input?.value?.trim();

        if (!content) return alert(UI_STRINGS.EMPTY_POST);

        try {
            const event = await this.client.publish(content);
            this.renderEvent(event);
            input.value = "";
            if (this.dom.counters.full) this.dom.counters.full.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
            if (this.dom.counters.sidebar) this.dom.counters.sidebar.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
        } catch (err) {
            alert(err.message);
        }
    }

    _updateRelayListFromClient() {
        this.settingsHandler.updateRelayList();
    }
    
    // --- Rendering ---
    /** @param {import('./types').Event} event */
    bufferEvent(event) {
        this.eventBuffer.push(event);
        if (!this.bufferTimer) {
            this.bufferTimer = setTimeout(() => this._flushBuffer(), CONFIG.EVENT_BUFFER_FLUSH_TIME_MS);
        }
    }

    _flushBuffer() {
        const container = this.dom.timeline;
        if (!container) return;
        
        // スクロール維持ロジックのための事前情報取得
        const IS_SCROLLED_RIGHT_TOLERANCE = 10;
        const isScrolledRight = container.scrollLeft >= (container.scrollWidth - container.clientWidth) - IS_SCROLLED_RIGHT_TOLERANCE;
        const wasScrolledRight = isScrolledRight;
        const prevScrollWidth = container.scrollWidth;

        // タイムラインの時系列順（Oldest -> Newest）でソート
        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at) 
            .forEach(e => this.renderEvent(e));
        
        this.eventBuffer = [];
        this.bufferTimer = null;
        if(this.dom.spinner) this.dom.spinner.style.display = "none";
        
        // スクロール維持ロジック: 右端（最新）に挿入された分の位置を補正
        const newScrollWidth = container.scrollWidth;
        
        if (wasScrolledRight) {
            // 右端を見ていた場合、新しい右端に自動スクロール
            container.scrollLeft = newScrollWidth - container.clientWidth;
        } else {
            // 履歴を見ていた場合、相対的な位置を維持
            const addedWidth = newScrollWidth - prevScrollWidth;
            container.scrollLeft += addedWidth;
        }
    }

    /** @param {import('./types').Event} event */
    renderEvent(event) {
        if (!this.dom.timeline) return;

        const noteEl = document.createElement("div");
        noteEl.className = "note";
        noteEl.dataset.createdAt = event.created_at.toString();
        noteEl.dataset.id = event.id;

        const isReacted = this.client.reactedEventIds.has(event.id);

        noteEl.innerHTML = `
            <div class="content">${this._formatContent(event.content)}</div>
            <div class="meta">
                <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
                <span class="author">${this._escape((event.pubkey || "").slice(0, 8))}...</span>
            </div>
            <button class="btn-reaction" ${isReacted ? "disabled" : ""}>${isReacted ? "❤️" : "♡"}</button>
        `;

        noteEl.querySelector(".btn-reaction")?.addEventListener("click", async (e) => {
            const target = /** @type {HTMLButtonElement} */ (e.target);
            try {
                await this.client.sendReaction(event);
                target.textContent = "❤️";
                target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        });

        // 常に末尾（右端）に追加 (左から右へ流れるタイムライン)
        this.dom.timeline.appendChild(noteEl);
    }

    /** @param {string} str */
    _escape(str) {
        if (typeof str !== "string") return "";
        return str.replace(/[&<>"']/g, s => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[s]));
    }

    /** @param {string} text */
    _formatContent(text) {
        let safe = this._escape(text);
        const special = "【緊急地震速報】";
        if (safe.includes(special)) {
            safe = safe.replace(special, `<span style="color:#e63946">${special}</span>`);
        }
        return safe;
    }
}


// =======================
// 7. Main Execution (Composition Root)
// =======================
window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();
    
    // ユーザーNGワードが未設定の場合、デフォルト値を初期値として設定
    if (!localStorage.getItem("userNgWords")) {
        storage.saveUserNgWords(storage.defaultNgWords);
    }

    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const ui = new UIManager(client, storage);

    // Wiring
    ui.init(); 

    // Client callbacks to update UI
    client.onEventCallback = (e) => ui.bufferEvent(e);
    client.onStatusCallback = () => ui._updateRelayListFromClient();

    // Start
    client.connect();
    client.startSubscription();
    
    // 初期ロード時の自動スクロール
    setTimeout(() => {
        const timeline = ui.dom.timeline;
        if (timeline) {
            // 右端（最新）にスクロール
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
        }
    }, 500);
});
