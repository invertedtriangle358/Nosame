import { CONFIG, NOSTR_KINDS, UI_STRINGS } from "./config.js";

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

export class NostrCodec {
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
            short: `${npub.slice(0, 10)}...${npub.slice(-6)}`,
        };
    }
}

export class EventValidator {
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

export class StorageManager {
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

export class ProfileStore {
    constructor() {
        this.metadataByPubkey = new Map();
    }

    upsertMetadata(event) {
        if (!event?.pubkey || event.kind !== NOSTR_KINDS.METADATA) return null;

        let parsed = {};
        try {
            parsed = JSON.parse(event.content ?? "{}");
        } catch {
            parsed = {};
        }

        const next = {
            pubkey: event.pubkey,
            created_at: event.created_at ?? 0,
            displayName: this._pickDisplayName(parsed, event.pubkey),
            about: typeof parsed.about === "string" ? parsed.about.trim() : "",
            picture: typeof parsed.picture === "string" ? parsed.picture.trim() : "",
        };

        const prev = this.metadataByPubkey.get(event.pubkey);
        if (prev && (prev.created_at ?? 0) > next.created_at) return prev;

        this.metadataByPubkey.set(event.pubkey, next);
        return next;
    }

    getProfile(pubkey) {
        return this.metadataByPubkey.get(pubkey) ?? {
            pubkey,
            displayName: this._fallbackName(pubkey),
            about: "",
            picture: "",
        };
    }

    _pickDisplayName(parsed, pubkey) {
        if (typeof parsed.displayName === "string" && parsed.displayName.trim()) {
            return parsed.displayName.trim();
        }
        if (typeof parsed.display_name === "string" && parsed.display_name.trim()) {
            return parsed.display_name.trim();
        }
        if (typeof parsed.name === "string" && parsed.name.trim()) {
            return parsed.name.trim();
        }
        return this._fallbackName(pubkey);
    }

    _fallbackName(pubkey) {
        return String(pubkey ?? "").slice(0, 8) || "unknown";
    }
}

export class NostrClient {
    constructor(storage, validator) {
        this.storage = storage;
        this.validator = validator;

        this.sockets = [];
        this.subId = null;
        this.profileSubId = null;
        this.activeProfileSubId = null;
        this.profileReqSerial = 0;
        this.seenEventIds = new Set();
        this.reactedEventIds = new Set();
        this.intentionallyClosedRelays = new Set();
        this.requestedProfilePubkeys = new Set();

        this.onEventCallback = null;
        this.onMetadataCallback = null;
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
            if (this.subId) this._sendTextSubscription(ws);
            if (this.requestedProfilePubkeys.size > 0) this._sendProfileSubscription(ws);
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
        this.sockets.forEach((ws) => this._sendTextSubscription(ws));
    }

    _sendTextSubscription(ws) {
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

    requestProfiles(pubkeys) {
        const normalized = [...new Set(
            pubkeys
                .filter((pubkey) => typeof pubkey === "string" && pubkey)
                .map((pubkey) => pubkey.toLowerCase())
        )];

        let changed = false;
        normalized.forEach((pubkey) => {
            if (!this.requestedProfilePubkeys.has(pubkey)) {
                this.requestedProfilePubkeys.add(pubkey);
                changed = true;
            }
        });

        if (!changed) return;
        this.profileSubId = `profile-${this.profileReqSerial += 1}`;
        this.sockets.forEach((ws) => this._sendProfileSubscription(ws));
    }

    _sendProfileSubscription(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (this.requestedProfilePubkeys.size === 0) return;
        if (!this.profileSubId) {
            this.profileSubId = `profile-${this.profileReqSerial += 1}`;
        }

        if (this.activeProfileSubId) {
            ws.send(JSON.stringify(["CLOSE", this.activeProfileSubId]));
        }
        ws.send(JSON.stringify([
            "REQ",
            this.profileSubId,
            {
                kinds: [NOSTR_KINDS.METADATA],
                authors: [...this.requestedProfilePubkeys],
                limit: Math.max(this.requestedProfilePubkeys.size, CONFIG.NOSTR_REQ_LIMIT),
            },
        ]));
        this.activeProfileSubId = this.profileSubId;
    }

    _handleMessage(ev) {
        try {
            const [type, , event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event?.id) return;
            if (this.seenEventIds.has(event.id)) return;
            this.seenEventIds.add(event.id);

            if (this.validator.isPubkeyBlocked(event.pubkey)) return;

            if (event.kind === NOSTR_KINDS.METADATA) {
                this.onMetadataCallback?.(event);
                return;
            }

            if (event.kind !== NOSTR_KINDS.TEXT) return;
            if (this.validator.isContentInvalid(event.content)) return;

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

        if (sent === 0) throw new Error(UI_STRINGS.NO_RELAY);
    }
}
