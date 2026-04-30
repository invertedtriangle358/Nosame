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
        const lower = text.toLowerCase();
        return this.storage.getAllNgWords().some((ng) => lower.includes(ng.toLowerCase()));
    }

    isPubkeyBlocked(pubkey) {
        if (!pubkey) return false;
        return this.storage.getBlockedPubkeys().includes(pubkey.toLowerCase());
    }
}

// =======================
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
        this.subId = null;
        this.seenEventIds = new Set();
        this.reactedEventIds = new Set();
        this.intentionallyClosedRelays = new Set();

        this.onEventCallback = null;
        this.onStatusCallback = null;
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

    }

    connect() {
        this.sockets.forEach((ws) => ws.close());
        this.sockets.forEach((ws) => {
            this.intentionallyClosedRelays.add(ws._relayUrl);
            ws.close();
        });
        this.sockets = [];

        this.storage.getRelays().forEach((url) => {
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

            const [type, , event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event?.id) return;
            if (this.seenEventIds.has(event.id)) return;
            if (this.validator.isPubkeyBlocked(event.pubkey)) return;
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
        }

        const pubkey = await window.nostr.getPublicKey();
        if (this.validator.isPubkeyBlocked(pubkey)) {
            throw new Error(UI_STRINGS.BLOCKED_PUBKEY);
        }

        const event = {
            kind: NOSTR_KINDS.TEXT,
            content,
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        if (this.validator.isPubkeyBlocked(pubkey)) {
            throw new Error(UI_STRINGS.BLOCKED_PUBKEY);
        }

        const event = {
            kind: NOSTR_KINDS.REACTION,
            content: "+",
        btn.saveRelays?.addEventListener("click", () => this._saveRelays());
        btn.addNg?.addEventListener("click", () => this._addNgWord());
        btn.saveNg?.addEventListener("click", () => this._saveNgWords());
        btn.addBlockedPubkey?.addEventListener("click", () => this._addBlockedPubkey());
        btn.saveBlockedPubkeys?.addEventListener("click", () => this._saveBlockedPubkeys());
    }

    _updateList({ container, getItemList, saveItemList, getStatus, updateCallback }) {
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
                <button class="btn-delete-blocked" type="button">Delete</button>
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
        this._setupListeners();
        this.settingsHandler.updateRelayList();
        this.settingsHandler.updateNgList();
        this.settingsHandler.updateBlockedPubkeyList();
    }

    _cacheDom() {
                saveRelays: $("btnSaveRelays"),
                addNg: $("btnAddNgWord"),
                saveNg: $("btnSaveNgWords"),
                addBlockedPubkey: $("btnAddBlockedPubkey"),
                saveBlockedPubkeys: $("btnSaveBlockedPubkeys"),
                scrollLeft: $("scrollLeft"),
                scrollRight: $("scrollRight"),
            },
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
            this.toggleSettingsPanel(true);
            this.settingsHandler.updateRelayList();
            this.settingsHandler.updateNgList();
            this.settingsHandler.updateBlockedPubkeyList();
        });

        btn.closeMenu?.addEventListener("click", () => {
            <div class="content">${this._formatContent(ev.content ?? "")}</div>
            <div class="meta">
                <span class="time">${new Date(ev.created_at * 1000).toLocaleString()}</span>
                <span class="author">${this._escape((ev.pubkey ?? "").slice(0, 8))}...</span>
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
