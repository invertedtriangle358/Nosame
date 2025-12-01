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
    NG_WORDS_URL: "./ngwords.json",
    RECONNECT_DELAY_MS: 5000,
};

const NOSTR_KINDS = { TEXT: 1, REACTION: 7 };

const UI_STRINGS = {
    EMPTY_POST: "本文を入力してください",
    INVALID_CONTENT: "NGワードまたは文字数制限です",
    NIP07_REQUIRED: "NIP-07拡張機能が必要です",
    NO_RELAY: "接続中のリレーがありません",
    INVALID_WSS: "正しいwss:// URLを入力してください",
    SAVE_RELAY_SUCCESS: "リレー設定を反映して再接続します",
    SAVE_NG_SUCCESS: "NGワードを保存しました",
};

// =======================
// 2. Event Validator
// =======================
class EventValidator {
    constructor(storage) {
        this.storage = storage;
    }
    
    isContentInvalid(text) {
        if (!text) return false;

        if (text.length > CONFIG.MAX_POST_LENGTH) return true;

        const lower = text.toLowerCase();
        return this.storage.getAllNgWords().some(ng =>
            lower.includes(ng.toLowerCase())
        );
    }
}

// =======================
// 3. Storage Manager
// =======================
class StorageManager {
    constructor() {
        this.defaultNgWords = [];
    }

    _load(key, fallback) {
        return JSON.parse(localStorage.getItem(key)) || fallback;
    }

    _save(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }
    
    getRelays() { return this._load("relays", [...CONFIG.DEFAULT_RELAYS]); }
    saveRelays(relays) { this._save("relays", relays); }

    getUserNgWords() { return this._load("userNgWords", []); }
    saveUserNgWords(words) { this._save("userNgWords", words); }

    async loadDefaultNgWords() {
        try {
            const res = await fetch(`${CONFIG.NG_WORDS_URL}?${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.defaultNgWords = await res.json();
        } catch (err) {
            console.warn("⚠ NGワードJSON読み込み失敗:", err);
        }
    }

    getAllNgWords() {
        return [...new Set([...this.defaultNgWords, ...this.getUserNgWords()])];
    }
}

// =======================
// 4. Nostr Network Client
// =======================
class NostrClient {
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

    // --- Socket Helpers ---
    _createSocket(url) {
        const ws = new WebSocket(url);
        ws._relayUrl = url;
        this._attachSocketListeners(ws);
        return ws;
    }

    _attachSocketListeners(ws) {
        ws.onopen = () => {
            console.log("✅ 接続:", ws._relayUrl);
            this._notifyStatus();
            if (this.subId) this._sendSubscription(ws);
        };

        ws.onclose = () => {
            console.log("🔌 切断:", ws._relayUrl);
            this._notifyStatus();
            setTimeout(() => this._reconnect(ws._relayUrl), CONFIG.RECONNECT_DELAY_MS);
        };

        ws.onerror = (err) => {
            console.error("❌ エラー:", ws._relayUrl, err);
            ws.close();
        };

        ws.onmessage = (ev) => this._handleMessage(ev);
    }

    _notifyStatus() {
        this.onStatusCallback?.();
    }

    // --- Connection ---
    connect() {
        this.sockets.forEach(ws => ws.close());
        this.sockets = [];

        this.storage.getRelays().forEach(url => {
            try {
                this.sockets.push(this._createSocket(url));
            } catch (e) {
                console.error("接続失敗:", url, e);
            }
        });

        this._notifyStatus();
    }

    _reconnect(url) {
        this.sockets = this.sockets.filter(s => s._relayUrl !== url);
        console.log("🔄 再接続:", url);

        try {
            this.sockets.push(this._createSocket(url));
        } catch (e) {
            console.error("再接続失敗:", url, e);
        }
    }

    getRelayStatus(url) {
        const normalize = s => s.replace(/\/+$/, "");
        const ws = this.sockets.find(s => normalize(s._relayUrl) === normalize(url));
        return ws?.readyState === WebSocket.OPEN;
    }

    // --- Subscription ---
    startSubscription() {
        this.subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
        this.seenEventIds.clear();
        this.sockets.forEach(ws => this._sendSubscription(ws));
    }

    _sendSubscription(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify([
            "REQ", 
            this.subId, 
            {
                kinds: [NOSTR_KINDS.TEXT],
                limit: CONFIG.NOSTR_REQ_LIMIT,
                since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
            }
        ]));
    }

    // --- Incoming Events ---
    _handleMessage(ev) {
        try {
            const [type, , event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event) return;
            if (this.seenEventIds.has(event.id)) return;
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            this.onEventCallback?.(event);
        } catch (e) {
            console.error("MSG処理エラー", e);
        }
    }

    // --- Publishing ---
    async publish(content) {
        if (this.validator.isContentInvalid(content))
            throw new Error(UI_STRINGS.INVALID_CONTENT);

        if (!window.nostr)
            throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.TEXT,
            content,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            pubkey
        };

        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        return signed;
    }

    async sendReaction(target) {
        if (this.reactedEventIds.has(target.id)) return;
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.REACTION,
            content: "+",
            created_at: Math.floor(Date.now() / 1000),
            tags: [["e", target.id], ["p", target.pubkey]],
            pubkey
        };

        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        this.reactedEventIds.add(target.id);
    }

    _broadcast(event) {
        const data = JSON.stringify(["EVENT", event]);
        let sent = 0;

        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
                sent++;
            }
        });

        if (sent === 0) throw new Error(UI_STRINGS.NO_RELAY);
    }
}

// =======================
// 5. Settings UI Handler
// =======================
class SettingsUIHandler {
    constructor(dom, storage, client, ui) {
        this.dom = dom;
        this.storage = storage;
        this.client = client;
        this.ui = ui;
    }

    setupListeners() {
        const btn = this.dom.buttons;

        btn.addRelay?.addEventListener("click", () => this._addRelay());
        btn.saveRelays?.addEventListener("click", () => this._saveRelays());
        btn.addNg?.addEventListener("click", () => this._addNgWord());
        btn.saveNg?.addEventListener("click", () => this._saveNgWords());
    }

    // Shortened for readability (logic unchanged)
    _updateList({ container, getItemList, saveItemList, getStatus, updateCallback }) {
        if (!container) return;
        container.innerHTML = "";

        const items = getItemList.call(this.storage);
        items.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            row.innerHTML = `
                <span class="relay-status">${getStatus.call(this.client, item) ? "🟢" : "🔴"}</span>
                <input type="text" value="${this.ui._escape(item)}" data-idx="${idx}">
                <button class="btn-delete-relay">✖</button>
            `;

            row.querySelector(".btn-delete-relay").onclick = () => {
                items.splice(idx, 1);
                saveItemList.call(this.storage, items);
                updateCallback.call(this);
            };

            row.querySelector("input").oninput = (e) => {
                items[idx] = e.target.value.trim();
                saveItemList.call(this.storage, items);
            };

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
        const container = this.dom.lists.ngWords;
        if (!container) return;
        container.innerHTML = "";

        // デフォルト
        this.storage.defaultNgWords.forEach(word => {
            const row = document.createElement("div");
            row.className = "ng-word-item ng-default";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(word)}" disabled>
                <button disabled>✖</button>
            `;
            container.appendChild(row);
        });

        // ユーザー
        const words = this.storage.getUserNgWords();
        words.forEach((w, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(w)}">
                <button class="btn-delete-ng">✖</button>
            `;

            row.querySelector("input").oninput = e => {
                words[idx] = e.target.value.trim();
                this.storage.saveUserNgWords(words);
            };

            row.querySelector(".btn-delete-ng").onclick = () => {
                words.splice(idx, 1);
                this.storage.saveUserNgWords(words);
                this.updateNgList();
            };

            container.appendChild(row);
        });
    }

    _addRelay() {
        const input = this.dom.inputs.relay;
        const url = input?.value?.trim();
        if (!url) return;

        try {
            const u = new URL(url);
            if (u.protocol !== "wss:") throw new Error();
        } catch {
            return alert(UI_STRINGS.INVALID_WSS);
        }

        const relays = this.storage.getRelays();
        if (!relays.includes(url)) {
            relays.push(url);
            this.storage.saveRelays(relays);
            input.value = "";
            this.updateRelayList();
        }
    }

    _saveRelays() {
        alert(UI_STRINGS.SAVE_RELAY_SUCCESS);
        this.ui._toggleModal(this.dom.modals.relay, false);
        this.client.connect();
        this.client.startSubscription();
    }

    _addNgWord() {
        const input = this.dom.inputs.ng;
        const w = input?.value?.trim();
        if (!w) return;

        const words = this.storage.getUserNgWords();
        if (!words.includes(w)) {
            words.push(w);
            this.storage.saveUserNgWords(words);
            input.value = "";
            this.updateNgList();
        }
    }

    _saveNgWords() { alert(UI_STRINGS.SAVE_NG_SUCCESS); }
}

// =======================
// 6. UI Manager
// =======================
class UIManager {
    constructor(client, storage) {
        this.client = client;
        this.storage = storage;
        this.dom = {};

        this.eventBuffer = [];
        this.bufferTimer = null;

        this.settingsHandler = null;
    }

    init() {
        this._cacheDom();
        this.settingsHandler = new SettingsUIHandler(this.dom, this.storage, this.client, this);

        this._setupListeners();
        this.settingsHandler.updateRelayList();
        this.settingsHandler.updateNgList();
    }

    _cacheDom() {
        const $ = id => document.getElementById(id);
        this.dom = {
            timeline: $("timeline"),
            spinner: $("subscribeSpinner"),
            modals: {
                relay: $("relayModal"),
                ng: $("ngModal"),
            },
            buttons: {
                publish: $("btnPublish"),
                openRelay: $("btnRelayModal"),
                closeRelay: $("btnCloseModal"),
                openNg: $("btnNgModal"),
                closeNg: $("btnCloseNgModal"),
                addRelay: $("btnAddRelay"),
                saveRelays: $("btnSaveRelays"),
                addNg: $("btnAddNgWord"),
                saveNg: $("btnSaveNgWords"),
                scrollLeft: $("scrollLeft"),
                scrollRight: $("scrollRight"),
            },
            inputs: {
                compose: $("compose"),
                relay: $("relayInput"),
                ng: $("ngWordInput"),
            },
            lists: {
                relays: $("relayList"),
                ngWords: $("ngWordList"),
            },
            counters: {
                char: $("charCount"),
            }
        };
    }

    _setupListeners() {
        const btn = this.dom.buttons;

        btn.openRelay?.addEventListener("click", () => {
            this._toggleModal(this.dom.modals.relay, true);
            this.settingsHandler.updateRelayList();
        });

        btn.closeRelay?.addEventListener("click", () => 
            this._toggleModal(this.dom.modals.relay, false)
        );

        btn.openNg?.addEventListener("click", () => {
            this._toggleModal(this.dom.modals.ng, true);
            this.settingsHandler.updateNgList();
        });

        btn.closeNg?.addEventListener("click", () => 
            this._toggleModal(this.dom.modals.ng, false)
        );

        btn.publish?.addEventListener("click", () => this._handlePublish());

        // delegate
        this.settingsHandler.setupListeners();

        // scroll
        btn.scrollLeft?.addEventListener("click", () =>
            this.dom.timeline.scrollBy({ left: -300, behavior: "smooth" })
        );
        btn.scrollRight?.addEventListener("click", () =>
            this.dom.timeline.scrollBy({ left: 300, behavior: "smooth" })
        );

        // char count
        this.dom.inputs.compose?.addEventListener("input", e => {
            const len = e.target.value.length;
            const counter = this.dom.counters.char;
            if (!counter) return;
            counter.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
            counter.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
        });

        // modal click outside
        Object.values(this.dom.modals).forEach(modal => {
            modal?.addEventListener("click", e => {
                if (e.target === modal) this._toggleModal(modal, false);
            });
        });
    }

    _toggleModal(el, open) {
        if (!el) return;
        el.style.display = open ? "block" : "none";
        el.setAttribute("aria-hidden", String(!open));
        document.body.style.overflow = open ? "hidden" : "";
    }

    async _handlePublish() {
        const input = this.dom.inputs.compose;
        const content = input?.value?.trim();
        if (!content) return alert(UI_STRINGS.EMPTY_POST);

        try {
            const event = await this.client.publish(content);
            this.renderEvent(event);
            input.value = "";
            this.dom.counters.char.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
        } catch (err) {
            alert(err.message);
        }
    }

    bufferEvent(event) {
        this.eventBuffer.push(event);
        if (!this.bufferTimer) {
            this.bufferTimer = setTimeout(
                () => this._flushBuffer(), 
                CONFIG.EVENT_BUFFER_FLUSH_TIME_MS
            );
        }
    }

    _flushBuffer() {
        const view = this.dom.timeline;
        if (!view) return;

        const atRight = view.scrollLeft >= view.scrollWidth - view.clientWidth - 10;
        const prevW = view.scrollWidth;

        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at)
            .forEach(e => this.renderEvent(e));

        this.eventBuffer = [];
        this.bufferTimer = null;
        if (this.dom.spinner) this.dom.spinner.style.display = "none";

        const newW = view.scrollWidth;
        if (atRight) view.scrollLeft = newW - view.clientWidth;
        else view.scrollLeft += (newW - prevW);
    }

    renderEvent(ev) {
        const view = this.dom.timeline;
        if (!view) return;

        const el = document.createElement("div");
        el.className = "note";
        el.dataset.id = ev.id;
        el.dataset.createdAt = ev.created_at;

        const reacted = this.client.reactedEventIds.has(ev.id);

        el.innerHTML = `
            <div class="content">${this._formatContent(ev.content)}</div>
            <div class="meta">
                <span class="time">${new Date(ev.created_at * 1000).toLocaleString()}</span>
                <span class="author">${this._escape(ev.pubkey?.slice(0, 8))}...</span>
            </div>
            <button class="btn-reaction" ${reacted ? "disabled" : ""}>${reacted ? "❤️" : "♡"}</button>
        `;

        el.querySelector(".btn-reaction").onclick = async (e) => {
            try {
                await this.client.sendReaction(ev);
                e.target.textContent = "❤️";
                e.target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        };

        view.appendChild(el);
    }

    _escape(str) {
        if (typeof str !== "string") return "";
        return str.replace(/[&<>"']/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );
    }

    _formatContent(text) {
        const safe = this._escape(text);
        const mark = "【緊急地震速報】";
        return safe.includes(mark)
            ? safe.replace(mark, `<span style="color:#e63946">${mark}</span>`)
            : safe;
    }
}

// =======================
// 7. Main Execution
// =======================
window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();

    if (!localStorage.getItem("userNgWords")) {
        storage.saveUserNgWords(storage.defaultNgWords);
    }

    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const ui = new UIManager(client, storage);

    ui.init();

    client.onEventCallback = e => ui.bufferEvent(e);
    client.onStatusCallback = () => ui.settingsHandler.updateRelayList();

    client.connect();
    client.startSubscription();

    setTimeout(() => {
        const t = ui.dom.timeline;
        if (t) t.scrollLeft = t.scrollWidth - t.clientWidth;
    }, 500);
});
