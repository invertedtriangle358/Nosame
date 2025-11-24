/**
 * Nostr Client Refactored
 * Designed with SOLID principles (SRP focus) & KISS
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

// =======================
// 2. Storage Manager (SRP: Data Persistence)
// =======================
class StorageManager {
    constructor() {
        this.defaultNgWords = [];
    }

    getRelays() {
        return JSON.parse(localStorage.getItem("relays")) || [...CONFIG.DEFAULT_RELAYS];
    }

    saveRelays(relays) {
        localStorage.setItem("relays", JSON.stringify(relays));
    }

    getUserNgWords() {
        return JSON.parse(localStorage.getItem("userNgWords")) || [];
    }

    saveUserNgWords(words) {
        localStorage.setItem("userNgWords", JSON.stringify(words));
    }

    async loadDefaultNgWords() {
        try {
            const res = await fetch(`${CONFIG.NG_WORDS_URL}?${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.defaultNgWords = await res.json();
            
            // Initialize user NG words if empty
            if (!localStorage.getItem("userNgWords")) {
                this.saveUserNgWords(this.defaultNgWords);
            }
        } catch (err) {
            console.warn("⚠ NGワードJSONの読み込み失敗:", err);
        }
    }

    getAllNgWords() {
        return [...new Set([...this.defaultNgWords, ...this.getUserNgWords()])];
    }
}

// =======================
// 3. Nostr Network Client (SRP: Communication)
// =======================
class NostrClient {
    constructor(storage) {
        this.storage = storage;
        this.sockets = [];
        this.subId = null;
        this.seenEventIds = new Set();
        this.reactedEventIds = new Set();
        this.onEventCallback = null; // UI update callback
        this.onStatusCallback = null; // Connection status callback
    }

    connect() {
        // Close existing connections
        this.sockets.forEach(ws => ws.close());
        this.sockets = [];

        const relays = this.storage.getRelays();
        relays.forEach(url => {
            if (!url) return;
            try {
                const ws = new WebSocket(url);
                ws.url = url; // store for reference
                
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
                console.error("接続失敗:", url, e);
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

    _sendReqToSocket(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const filter = {
            kinds: [1],
            limit: CONFIG.NOSTR_REQ_LIMIT,
            since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
        };
        const req = ["REQ", this.subId, filter];
        ws.send(JSON.stringify(req));
    }

    _handleMessage(ev) {
        try {
            const [type, subId, event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event) return;
            if (this.seenEventIds.has(event.id)) return;

            // NG Check
            if (this._isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            if (this.onEventCallback) this.onEventCallback(event);
        } catch (e) {
            console.error("MSG処理エラー", e);
        }
    }

    _isContentInvalid(text) {
        if (!text) return false;
        if (text.length > CONFIG.MAX_POST_LENGTH) return true;
        const ngWords = this.storage.getAllNgWords();
        const lower = text.toLowerCase();
        return ngWords.some(ng => lower.includes(ng.toLowerCase()));
    }

    async publish(content) {
        if (this._isContentInvalid(content)) throw new Error("NGワードまたは文字数制限です");
        if (!window.nostr) throw new Error("NIP-07拡張機能が必要です");

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: 1,
            content: content,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        return signed;
    }

    async sendReaction(targetEvent) {
        if (this.reactedEventIds.has(targetEvent.id)) return;
        if (!window.nostr) throw new Error("NIP-07拡張機能が必要です");

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: 7,
            content: "+",
            created_at: Math.floor(Date.now() / 1000),
            tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        this.reactedEventIds.add(targetEvent.id);
    }

    _broadcast(event) {
        const payload = JSON.stringify(["EVENT", event]);
        let sentCount = 0;
        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
                sentCount++;
            }
        });
        if (sentCount === 0) throw new Error("接続中のリレーがありません");
    }

    getRelayStatus(url) {
        const normalized = url.replace(/\/+$/, "");
        const ws = this.sockets.find(s => s.url.replace(/\/+$/, "") === normalized);
        return ws && ws.readyState === WebSocket.OPEN;
    }
}

// =======================
// 4. UI Manager (SRP: DOM & Rendering)
// =======================
class UIManager {
    constructor(nostrClient, storage) {
        this.client = nostrClient;
        this.storage = storage;
        this.dom = {};
        this.eventBuffer = [];
        this.bufferTimer = null;
    }

    init() {
        // DOM Elements Fetching (Moved here to ensure DOM exists)
        this.dom = {
            timeline: document.getElementById("timeline"),
            spinner: document.getElementById("subscribeSpinner"),
            panel: {
                side: document.getElementById("sidePanel"),
                overlay: document.getElementById("panelOverlay"),
                btnOpen: document.getElementById("btnPanelToggle"),
                btnClose: document.getElementById("btnPanelClose"),
            },
            inputs: {
                full: document.getElementById("composeFull"),
                simple: document.getElementById("composeSimple"),
                sidebar: document.getElementById("composeSidebar"),
                relay: document.getElementById("relayInput"),
                ng: document.getElementById("ngWordInput"),
            },
            buttons: {
                publishFull: document.getElementById("btnPublish"),
                publishSimple: document.getElementById("btnPublishSimple"),
                addRelay: document.getElementById("btnAddRelay"),
                saveRelays: document.getElementById("btnSaveRelays"),
                addNg: document.getElementById("btnAddNgWord"),
                saveNg: document.getElementById("btnSaveNgWords"),
                scrollLeft: document.getElementById("scrollLeft"),
                scrollRight: document.getElementById("scrollRight"),
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

        this._setupListeners();
        this._updateNgList();
        this._updateRelayList();
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

        // Settings (Relay / NG)
        this.dom.buttons.addRelay?.addEventListener("click", () => this._addRelay());
        this.dom.buttons.saveRelays?.addEventListener("click", () => this._saveRelays());
        this.dom.buttons.addNg?.addEventListener("click", () => this._addNgWord());
        this.dom.buttons.saveNg?.addEventListener("click", () => this._saveNgWords());

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

    _togglePanel(open) {
        if (!this.dom.panel.side) return;
        if (open) {
            this.dom.panel.side.classList.add("open");
            this.dom.panel.side.setAttribute("aria-hidden", "false");
            this.dom.panel.overlay.hidden = false;
        } else {
            this.dom.panel.side.classList.remove("open");
            this.dom.panel.side.setAttribute("aria-hidden", "true");
            this.dom.panel.overlay.hidden = true;
        }
    }

    // --- Publishing ---
    async _handlePublish(source) {
        const inputMap = {
            "simple": this.dom.inputs.simple,
            "full": this.dom.inputs.full,
            "sidebar": this.dom.inputs.sidebar
        };
        const input = inputMap[source];
        const content = input?.value?.trim();

        if (!content) return alert("本文を入力してください");

        try {
            const event = await this.client.publish(content);
            // Add locally immediately
            this.renderEvent(event);
            input.value = "";
            if (source === "full" && this.dom.counters.full) this.dom.counters.full.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
        } catch (err) {
            alert(err.message);
        }
    }

    // --- Settings UI ---
    _updateRelayList() {
        const container = this.dom.lists.relays;
        if (!container) return;
        container.innerHTML = "";
        const relays = this.storage.getRelays();

        relays.forEach((url, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            
            const isConnected = this.client.getRelayStatus(url);
            
            row.innerHTML = `
                <span class="relay-status">${isConnected ? "🟢" : "🔴"}</span>
                <input type="text" value="${this._escape(url)}" data-idx="${idx}">
                <button class="btn-delete-relay">✖</button>
            `;

            // Update value on input
            row.querySelector("input").addEventListener("input", (e) => {
                relays[idx] = e.target.value.trim();
                this.storage.saveRelays(relays); // auto-save interim state or manage separate state? kept simple here
            });
            // Delete
            row.querySelector(".btn-delete-relay").addEventListener("click", () => {
                relays.splice(idx, 1);
                this.storage.saveRelays(relays);
                this._updateRelayList();
            });

            container.appendChild(row);
        });
    }

    _addRelay() {
        const url = this.dom.inputs.relay?.value?.trim();
        if (!url) return;
        try {
            const u = new URL(url);
            if(u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error();
        } catch {
            return alert("正しいwss URLを入力してください");
        }
        const relays = this.storage.getRelays();
        if (!relays.includes(url)) {
            relays.push(url);
            this.storage.saveRelays(relays);
            this.dom.inputs.relay.value = "";
            this._updateRelayList();
        }
    }

    _saveRelays() {
        alert("リレー設定を反映して再接続します");
        this._togglePanel(false);
        this.client.connect();
        this.client.startSubscription();
    }

    _updateNgList() {
        const container = this.dom.lists.ngWords;
        if (!container) return;
        container.innerHTML = "";
        const words = this.storage.getUserNgWords();

        words.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this._escape(word)}">
                <button class="btn-delete-ng">✖</button>
            `;
            // Delete
            row.querySelector(".btn-delete-ng").addEventListener("click", () => {
                words.splice(idx, 1);
                this.storage.saveUserNgWords(words);
                this._updateNgList();
            });
            container.appendChild(row);
        });
    }

    _addNgWord() {
        const w = this.dom.inputs.ng?.value?.trim();
        if (!w) return;
        const words = this.storage.getUserNgWords();
        if (!words.includes(w)) {
            words.push(w);
            this.storage.saveUserNgWords(words);
            this.dom.inputs.ng.value = "";
            this._updateNgList();
        }
    }

    _saveNgWords() {
        alert("NGワードを保存しました");
    }

    // --- Rendering ---
    bufferEvent(event) {
        this.eventBuffer.push(event);
        if (!this.bufferTimer) {
            this.bufferTimer = setTimeout(() => this._flushBuffer(), CONFIG.EVENT_BUFFER_FLUSH_TIME_MS);
        }
    }

    _flushBuffer() {
        // Sort: Oldest to Newest, then prepend sequentially.
        // Loop: 1 (Old) -> 2 (New). 
        // Prepend 1. Timeline: [1]
        // Prepend 2. Timeline: [2, 1] -> Newest is on Left.
        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at)
            .forEach(e => this.renderEvent(e));
        this.eventBuffer = [];
        this.bufferTimer = null;
        if(this.dom.spinner) this.dom.spinner.style.display = "none";
    }

    renderEvent(event) {
        if (!this.dom.timeline) return;

        const noteEl = document.createElement("div");
        noteEl.className = "note";
        noteEl.dataset.createdAt = event.created_at;
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

        noteEl.querySelector(".btn-reaction").addEventListener("click", async (e) => {
            try {
                await this.client.sendReaction(event);
                e.target.textContent = "❤️";
                e.target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        });

        // 修正ロジック: 「新しいものを左端(先頭)に」
        // 既存の子要素を探し、自分より「古い(timeが小さい)」要素の直前に挿入する
        // リストが [New(20), Old(10)] の場合、Newer(30)が来たら、
        // 20 < 30 は true なので 20の前に挿入 => [30, 20, 10]
        const children = Array.from(this.dom.timeline.children);
        const insertPos = children.find(el => Number(el.dataset.createdAt) < event.created_at);

        if (insertPos) {
            this.dom.timeline.insertBefore(noteEl, insertPos);
        } else {
            // 見つからない＝全ての要素より古い、または空 => 末尾に追加（左端が最新なら、右端に追加）
            this.dom.timeline.appendChild(noteEl);
        }
    }

    _escape(str) {
        if (typeof str !== "string") return "";
        return str.replace(/[&<>"']/g, s => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[s]));
    }

    _formatContent(text) {
        let safe = this._escape(text);
        // Simple colorizer example
        const special = "【緊急地震速報】";
        if (safe.includes(special)) {
            safe = safe.replace(special, `<span style="color:#e63946">${special}</span>`);
        }
        return safe;
    }
}

// =======================
// 5. Main Execution (Composition Root)
// =======================
window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();

    const client = new NostrClient(storage);
    const ui = new UIManager(client, storage);

    // Wiring
    ui.init(); // DOM取得はここで行う

    // Client callbacks to update UI
    client.onEventCallback = (e) => ui.bufferEvent(e);
    client.onStatusCallback = () => ui._updateRelayList();

    // Start
    client.connect();
    client.startSubscription();
});
