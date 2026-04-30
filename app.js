// =======================
// 1. Constants & Config
// =======================
const CONFIG = {
    MAX_POST_LENGTH: 108,
    EVENT_BUFFER_FLUSH_TIME_MS: 200,
    NOSTR_REQ_LIMIT: 100,
    NOSTR_REQ_SINCE_SECONDS_AGO: 3600,
    DEFAULT_RELAYS: [
        "wss://relay-jp.nostr.wirednet.jp",
        "wss://yabu.me",
        "wss://r.kojira.io",
        "wss://nostr.compile-error.net",
    ],
    NG_WORDS_URL: "./ngwords.json",
    RECONNECT_DELAY_MS: 5000,
};

const NOSTR_KINDS = {
    TEXT: 1,
    REACTION: 7,
};

const UI_STRINGS = {
    EMPTY_POST: "Please enter some text.",
    INVALID_CONTENT: "This note contains an NG word or is too long.",
    BLOCKED_PUBKEY: "This pubkey is blocked.",
    NIP07_REQUIRED: "A NIP-07 compatible Nostr extension is required.",
    NO_RELAY: "No relay is currently connected.",
    INVALID_WSS: "Please enter a valid wss:// URL.",
    INVALID_PUBKEY: "Please enter a valid hex pubkey or npub.",
    SAVE_RELAY_SUCCESS: "Relay settings saved.",
    SAVE_NG_SUCCESS: "NG words saved.",
    SAVE_BLOCKED_SUCCESS: "Blocked pubkeys saved.",
    DUPLICATE_RELAY: "That relay is already in the list.",
    DUPLICATE_NG: "That NG word is already in the list.",
    DUPLICATE_BLOCKED_PUBKEY: "That pubkey is already in the block list.",
    COPY_NPUB_SUCCESS: "Copied npub to clipboard.",
    COPY_NPUB_FAILED: "Could not copy npub.",
};

const Bech32 = (() => {
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    const polymod = (values) => {
        const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;

        values.forEach((value) => {
            const top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ value;
            for (let i = 0; i < 5; i += 1) {
                if ((top >> i) & 1) chk ^= generators[i];
            }
        });

        return chk;
    };

    const hrpExpand = (hrp) => {
        const result = [];
        for (let i = 0; i < hrp.length; i += 1) result.push(hrp.charCodeAt(i) >> 5);
        result.push(0);
        for (let i = 0; i < hrp.length; i += 1) result.push(hrp.charCodeAt(i) & 31);
        return result;
    };

    const createChecksum = (hrp, data) => {
        const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
        const mod = polymod(values) ^ 1;
        const checksum = [];

        for (let i = 0; i < 6; i += 1) {
            checksum.push((mod >> (5 * (5 - i))) & 31);
        }

        return checksum;
    };

    const verifyChecksum = (hrp, data) => polymod([...hrpExpand(hrp), ...data]) === 1;

    const encode = (hrp, data) => {
        const combined = [...data, ...createChecksum(hrp, data)];
        return `${hrp}1${combined.map((value) => CHARSET[value]).join("")}`;
    };

    const decode = (value) => {
        const input = value.toLowerCase();
        const pos = input.lastIndexOf("1");
        if (pos < 1 || pos + 7 > input.length) throw new Error("Invalid bech32 string.");

        const hrp = input.slice(0, pos);
        const data = [];
        for (let i = pos + 1; i < input.length; i += 1) {
            const idx = CHARSET.indexOf(input[i]);
            if (idx === -1) throw new Error("Invalid bech32 character.");
            data.push(idx);
        }

        if (!verifyChecksum(hrp, data)) throw new Error("Invalid bech32 checksum.");
        return { hrp, data: data.slice(0, -6) };
    };

    const convertBits = (data, fromBits, toBits, pad) => {
        let acc = 0;
        let bits = 0;
        const result = [];
        const maxv = (1 << toBits) - 1;

        for (const value of data) {
            if (value < 0 || value >> fromBits) throw new Error("Invalid value.");
            acc = (acc << fromBits) | value;
            bits += fromBits;

            while (bits >= toBits) {
                bits -= toBits;
                result.push((acc >> bits) & maxv);
            }
        }

        if (pad) {
            if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
            throw new Error("Invalid padding.");
        }

        return result;
    };

    return { encode, decode, convertBits };
})();

class NostrCodec {
    static isHexPubkey(value) {
        return /^[0-9a-f]{64}$/i.test(value);
    }

    static hexToBytes(hex) {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }
        return bytes;
    }

    static bytesToHex(bytes) {
        return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    static toNpub(pubkeyHex) {
        const normalized = pubkeyHex.toLowerCase();
        if (!this.isHexPubkey(normalized)) throw new Error("Invalid pubkey.");

        const words = Bech32.convertBits(this.hexToBytes(normalized), 8, 5, true);
        return Bech32.encode("npub", words);
    }

    static fromNpub(npub) {
        const { hrp, data } = Bech32.decode(npub);
        if (hrp !== "npub") throw new Error("Only npub is supported.");

        const bytes = Bech32.convertBits(data, 5, 8, false);
        const hex = this.bytesToHex(bytes);
        if (!this.isHexPubkey(hex)) throw new Error("Invalid npub.");
        return hex;
    }

    static normalizePubkey(value) {
        const trimmed = value.trim();
        if (!trimmed) throw new Error("Empty value.");

        if (trimmed.toLowerCase().startsWith("npub1")) return this.fromNpub(trimmed);
        if (this.isHexPubkey(trimmed)) return trimmed.toLowerCase();
        throw new Error("Unsupported pubkey.");
    }

    static formatShortNpub(pubkeyHex) {
        const npub = this.toNpub(pubkeyHex);
        return {
            npub,
            short: `🔑${npub.slice(5, 11)}...${npub.slice(-6)}`,
        };
    }
}

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
        return this.storage.getAllNgWords().some((ng) => lower.includes(ng.toLowerCase()));
    }

    isPubkeyBlocked(pubkey) {
        if (!pubkey) return false;
        return this.storage.getBlockedPubkeys().includes(pubkey.toLowerCase());
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
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            console.warn(`Failed to parse localStorage key: ${key}`, err);
            return fallback;
        }
    }

    _save(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    getRelays() {
        return this._load("relays", [...CONFIG.DEFAULT_RELAYS]);
    }

    saveRelays(relays) {
        this._save("relays", relays);
    }

    getUserNgWords() {
        return this._load("userNgWords", []);
    }

    saveUserNgWords(words) {
        this._save("userNgWords", words);
    }

    getBlockedPubkeys() {
        return this._load("blockedPubkeys", []);
    }

    saveBlockedPubkeys(pubkeys) {
        this._save("blockedPubkeys", pubkeys);
    }

    async loadDefaultNgWords() {
        try {
            const res = await fetch(`${CONFIG.NG_WORDS_URL}?${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            this.defaultNgWords = Array.isArray(data)
                ? data.filter((word) => typeof word === "string" && word.trim())
                : [];
        } catch (err) {
            console.warn("Failed to load default NG words.", err);
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
        this.intentionallyClosedRelays = new Set();

        this.onEventCallback = null;
        this.onStatusCallback = null;
    }

    _createSocket(url) {
        const ws = new WebSocket(url);
        ws._relayUrl = url;
        this._attachSocketListeners(ws);
        return ws;
    }

    _attachSocketListeners(ws) {
        ws.onopen = () => {
            console.log("Relay connected:", ws._relayUrl);
            this.intentionallyClosedRelays.delete(ws._relayUrl);
            this._notifyStatus();
            if (this.subId) this._sendSubscription(ws);
        };

        ws.onclose = () => {
            console.log("Relay disconnected:", ws._relayUrl);
            this._notifyStatus();

            if (this.intentionallyClosedRelays.has(ws._relayUrl)) {
                this.intentionallyClosedRelays.delete(ws._relayUrl);
                return;
            }

            setTimeout(() => this._reconnect(ws._relayUrl), CONFIG.RECONNECT_DELAY_MS);
        };

        ws.onerror = (err) => {
            console.error("Relay error:", ws._relayUrl, err);
            ws.close();
        };

        ws.onmessage = (ev) => this._handleMessage(ev);
    }

    _notifyStatus() {
        this.onStatusCallback?.();
    }

    connect() {
        this.sockets.forEach((ws) => {
            this.intentionallyClosedRelays.add(ws._relayUrl);
            ws.close();
        });
        this.sockets = [];

        this.storage.getRelays().forEach((url) => {
            try {
                this.sockets.push(this._createSocket(url));
            } catch (err) {
                console.error("Failed to create relay socket:", url, err);
            }
        });

        this._notifyStatus();
    }

    _reconnect(url) {
        if (!this.storage.getRelays().includes(url)) return;

        const alreadyOpen = this.sockets.some(
            (socket) =>
                socket._relayUrl === url &&
                (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        );
        if (alreadyOpen) return;

        this.sockets = this.sockets.filter((socket) => socket._relayUrl !== url);
        console.log("Reconnecting relay:", url);

        try {
            this.sockets.push(this._createSocket(url));
        } catch (err) {
            console.error("Failed to reconnect relay:", url, err);
        }
    }

    getRelayStatus(url) {
        const normalize = (value) => value.replace(/\/+$/, "");
        const ws = this.sockets.find((socket) => normalize(socket._relayUrl) === normalize(url));
        return ws?.readyState === WebSocket.OPEN;
    }

    startSubscription() {
        this.subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
        this.seenEventIds.clear();
        this.sockets.forEach((ws) => this._sendSubscription(ws));
    }

    _sendSubscription(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify([
            "REQ",
            this.subId,
            {
                kinds: [NOSTR_KINDS.TEXT],
                limit: CONFIG.NOSTR_REQ_LIMIT,
                since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO,
            },
        ]));
    }

    _handleMessage(ev) {
        try {
            const [type, , event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event?.id) return;
            if (this.seenEventIds.has(event.id)) return;
            if (this.validator.isPubkeyBlocked(event.pubkey)) return;
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            this.onEventCallback?.(event);
        } catch (err) {
            console.error("Failed to parse relay message.", err);
        }
    }

    async publish(content) {
        if (this.validator.isContentInvalid(content)) {
            throw new Error(UI_STRINGS.INVALID_CONTENT);
        }

        if (!window.nostr) {
            throw new Error(UI_STRINGS.NIP07_REQUIRED);
        }

        const pubkey = await window.nostr.getPublicKey();
        if (this.validator.isPubkeyBlocked(pubkey)) {
            throw new Error(UI_STRINGS.BLOCKED_PUBKEY);
        }

        const event = {
            kind: NOSTR_KINDS.TEXT,
            content,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            pubkey,
        };

        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        return signed;
    }

    async sendReaction(target) {
        if (this.reactedEventIds.has(target.id)) return;
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        if (this.validator.isPubkeyBlocked(pubkey)) {
            throw new Error(UI_STRINGS.BLOCKED_PUBKEY);
        }

        const event = {
            kind: NOSTR_KINDS.REACTION,
            content: "+",
            created_at: Math.floor(Date.now() / 1000),
            tags: [["e", target.id], ["p", target.pubkey]],
            pubkey,
        };

        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        this.reactedEventIds.add(target.id);
    }

    _broadcast(event) {
        const data = JSON.stringify(["EVENT", event]);
        let sent = 0;

        this.sockets.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
                sent += 1;
            }
        });

        if (sent === 0) {
            throw new Error(UI_STRINGS.NO_RELAY);
        }
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
        btn.addBlockedPubkey?.addEventListener("click", () => this._addBlockedPubkey());
        btn.saveBlockedPubkeys?.addEventListener("click", () => this._saveBlockedPubkeys());
    }

    _updateList({ container, getItemList, saveItemList, getStatus, updateCallback }) {
        if (!container) return;
        container.innerHTML = "";

        const items = getItemList.call(this.storage);
        items.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            row.innerHTML = `
                <span class="relay-status">${getStatus.call(this.client, item) ? "●" : "○"}</span>
                <input type="text" value="${this.ui._escape(item)}" data-idx="${idx}">
                <button class="btn-delete-relay" type="button">削除</button>
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

        this.storage.defaultNgWords.forEach((word) => {
            const row = document.createElement("div");
            row.className = "ng-word-item ng-default";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(word)}" disabled>
                <button type="button" disabled>既定</button>
            `;
            container.appendChild(row);
        });

        const words = this.storage.getUserNgWords();
        words.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(word)}">
                <button class="btn-delete-ng" type="button">削除</button>
            `;

            row.querySelector("input").oninput = (e) => {
                words[idx] = e.target.value.trim();
                this.storage.saveUserNgWords(words.filter(Boolean));
            };

            row.querySelector(".btn-delete-ng").onclick = () => {
                words.splice(idx, 1);
                this.storage.saveUserNgWords(words);
                this.updateNgList();
            };

            container.appendChild(row);
        });
    }

    updateBlockedPubkeyList() {
        const container = this.dom.lists.blockedPubkeys;
        if (!container) return;
        container.innerHTML = "";

        const pubkeys = this.storage.getBlockedPubkeys();
        pubkeys.forEach((pubkey, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(this.ui._formatNpub(pubkey).short)}" title="${this.ui._escape(pubkey)}" disabled>
                <button class="btn-delete-blocked" type="button">削除</button>
            `;

            row.querySelector(".btn-delete-blocked").onclick = () => {
                pubkeys.splice(idx, 1);
                this.storage.saveBlockedPubkeys(pubkeys);
                this.updateBlockedPubkeyList();
            };

            container.appendChild(row);
        });
    }

    _addRelay() {
        const input = this.dom.inputs.relay;
        const url = input?.value?.trim();
        if (!url) return;

        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "wss:") throw new Error();
        } catch {
            alert(UI_STRINGS.INVALID_WSS);
            return;
        }

        const relays = this.storage.getRelays();
        if (relays.includes(url)) {
            alert(UI_STRINGS.DUPLICATE_RELAY);
            return;
        }

        relays.push(url);
        this.storage.saveRelays(relays);
        input.value = "";
        this.updateRelayList();
    }

    _saveRelays() {
        alert(UI_STRINGS.SAVE_RELAY_SUCCESS);
        this.ui.toggleSettingsPanel(false);
        this.client.connect();
        this.client.startSubscription();
    }

    _addNgWord() {
        const input = this.dom.inputs.ng;
        const word = input?.value?.trim();
        if (!word) return;

        const words = this.storage.getUserNgWords();
        if (words.includes(word)) {
            alert(UI_STRINGS.DUPLICATE_NG);
            return;
        }

        words.push(word);
        this.storage.saveUserNgWords(words);
        input.value = "";
        this.updateNgList();
    }

    _saveNgWords() {
        alert(UI_STRINGS.SAVE_NG_SUCCESS);
        this.ui.toggleSettingsPanel(false);
    }

    _addBlockedPubkey() {
        const input = this.dom.inputs.blockedPubkey;
        const rawValue = input?.value?.trim();
        if (!rawValue) return;

        let normalized;
        try {
            normalized = NostrCodec.normalizePubkey(rawValue);
        } catch {
            alert(UI_STRINGS.INVALID_PUBKEY);
            return;
        }

        const pubkeys = this.storage.getBlockedPubkeys();
        if (pubkeys.includes(normalized)) {
            alert(UI_STRINGS.DUPLICATE_BLOCKED_PUBKEY);
            return;
        }

        pubkeys.push(normalized);
        this.storage.saveBlockedPubkeys(pubkeys);
        input.value = "";
        this.updateBlockedPubkeyList();
    }

    _saveBlockedPubkeys() {
        alert(UI_STRINGS.SAVE_BLOCKED_SUCCESS);
        this.ui.toggleSettingsPanel(false);
    }
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
        this.settingsHandler.updateBlockedPubkeyList();
    }

    _cacheDom() {
        const $ = (id) => document.getElementById(id);

        this.dom = {
            timeline: $("timeline"),
            panels: {
                settings: $("settingsPanel"),
                backdrop: $("menuBackdrop"),
            },
            buttons: {
                publish: $("btnPublish"),
                openMenu: $("btnMenu"),
                closeMenu: $("btnCloseMenu"),
                addRelay: $("btnAddRelay"),
                saveRelays: $("btnSaveRelays"),
                addNg: $("btnAddNgWord"),
                saveNg: $("btnSaveNgWords"),
                addBlockedPubkey: $("btnAddBlockedPubkey"),
                saveBlockedPubkeys: $("btnSaveBlockedPubkeys"),
                scrollLeft: $("scrollLeft"),
                scrollRight: $("scrollRight"),
            },
            inputs: {
                compose: $("compose"),
                relay: $("relayInput"),
                ng: $("ngWordInput"),
                blockedPubkey: $("blockedPubkeyInput"),
            },
            lists: {
                relays: $("relayList"),
                ngWords: $("ngWordList"),
                blockedPubkeys: $("blockedPubkeyList"),
            },
            counters: {
                char: $("charCount"),
            },
        };
    }

    _setupListeners() {
        const btn = this.dom.buttons;

        btn.openMenu?.addEventListener("click", () => {
            this.toggleSettingsPanel(true);
            this.settingsHandler.updateRelayList();
            this.settingsHandler.updateNgList();
            this.settingsHandler.updateBlockedPubkeyList();
        });

        btn.closeMenu?.addEventListener("click", () => {
            this.toggleSettingsPanel(false);
        });

        btn.publish?.addEventListener("click", () => this._handlePublish());

        this.settingsHandler.setupListeners();

        btn.scrollLeft?.addEventListener("click", () => {
            this.dom.timeline?.scrollBy({ left: -300, behavior: "smooth" });
        });

        btn.scrollRight?.addEventListener("click", () => {
            this.dom.timeline?.scrollBy({ left: 300, behavior: "smooth" });
        });

        this.dom.inputs.compose?.addEventListener("input", (e) => {
            const len = e.target.value.length;
            const counter = this.dom.counters.char;
            if (!counter) return;

            counter.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
            counter.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
        });

        this.dom.inputs.compose?.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                this._handlePublish();
            }
        });

        this.dom.panels.backdrop?.addEventListener("click", () => {
            this.toggleSettingsPanel(false);
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                this.toggleSettingsPanel(false);
            }
        });
    }

    toggleSettingsPanel(open) {
        const panel = this.dom.panels.settings;
        const backdrop = this.dom.panels.backdrop;
        const button = this.dom.buttons.openMenu;
        if (!panel || !backdrop) return;

        panel.classList.toggle("is-open", open);
        backdrop.classList.toggle("is-open", open);
        panel.setAttribute("aria-hidden", String(!open));
        backdrop.setAttribute("aria-hidden", String(!open));
        button?.setAttribute("aria-expanded", String(open));
        document.body.style.overflow = open ? "hidden" : "";
    }

    async _handlePublish() {
        const input = this.dom.inputs.compose;
        const content = input?.value?.trim();
        if (!content) {
            alert(UI_STRINGS.EMPTY_POST);
            return;
        }

        try {
            const event = await this.client.publish(content);
            this.renderEvent(event);
            input.value = "";
            this.dom.counters.char.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
            this.dom.counters.char.style.color = "";
        } catch (err) {
            alert(err.message);
        }
    }

    bufferEvent(event) {
        this.eventBuffer.push(event);
        if (this.bufferTimer) return;

        this.bufferTimer = setTimeout(() => this._flushBuffer(), CONFIG.EVENT_BUFFER_FLUSH_TIME_MS);
    }

    _flushBuffer() {
        const view = this.dom.timeline;
        if (!view) return;

        const atRight = view.scrollLeft >= view.scrollWidth - view.clientWidth - 10;
        const prevWidth = view.scrollWidth;

        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at)
            .forEach((event) => this.renderEvent(event));

        this.eventBuffer = [];
        this.bufferTimer = null;

        const newWidth = view.scrollWidth;
        if (atRight) {
            view.scrollLeft = newWidth - view.clientWidth;
        } else {
            view.scrollLeft += newWidth - prevWidth;
        }
    }

    renderEvent(ev) {
        const view = this.dom.timeline;
        if (!view || !ev?.id || view.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) {
            return;
        }

        const el = document.createElement("div");
        el.className = "note";
        el.dataset.id = ev.id;
        el.dataset.createdAt = String(ev.created_at);

        const reacted = this.client.reactedEventIds.has(ev.id);
        el.innerHTML = `
            <div class="content">${this._formatContent(ev.content ?? "")}</div>
            <div class="meta">
                <span class="time">${new Date(ev.created_at * 1000).toLocaleString()}</span>
                <button class="author author-copy" type="button" aria-label="Copy npub">${this._escape(this._formatNpub(ev.pubkey ?? "").short)}</button>
            </div>
            <button class="btn-reaction" type="button" aria-label="Send reaction" ${reacted ? "disabled" : ""}>${reacted ? "Sent" : "+"}</button>
        `;

        el.querySelector(".author-copy").onclick = async () => {
            await this._copyNpub(ev.pubkey ?? "");
        };

        el.querySelector(".btn-reaction").onclick = async (e) => {
            try {
                await this.client.sendReaction(ev);
                e.target.textContent = "Sent";
                e.target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        };

        view.appendChild(el);
    }

    _formatNpub(pubkey) {
        try {
            return NostrCodec.formatShortNpub(pubkey);
        } catch {
            const value = String(pubkey ?? "");
            return {
                npub: value,
                short: value ? `${value.slice(0, 6)}...${value.slice(-6)}` : "",
            };
        }
    }

    async _copyNpub(pubkey) {
        try {
            const { npub } = this._formatNpub(pubkey);
            if (!npub) throw new Error("Missing npub.");
            await navigator.clipboard.writeText(npub);
            alert(UI_STRINGS.COPY_NPUB_SUCCESS);
        } catch {
            alert(UI_STRINGS.COPY_NPUB_FAILED);
        }
    }

    _escape(str) {
        if (typeof str !== "string") return "";
        return str.replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;",
        }[char]));
    }

    _formatContent(text) {
        const safe = this._escape(text);
        return safe.replace(/\n/g, "<br>");
    }
}

// =======================
// 7. Main Execution
// =======================
window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();

    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const ui = new UIManager(client, storage);

    ui.init();

    client.onEventCallback = (event) => ui.bufferEvent(event);
    client.onStatusCallback = () => ui.settingsHandler.updateRelayList();

    client.connect();
    client.startSubscription();

    setTimeout(() => {
        const timeline = ui.dom.timeline;
        if (timeline) {
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
        }
    }, 500);
});
