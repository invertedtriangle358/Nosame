export class StorageManager {
    constructor(storageAdapter = localStorage) {
        this.storage = storageAdapter;
        this.defaultNgWords = [];
    }

    _load(key, fallback) {
        try {
            const raw = this.storage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            console.warn(`Failed to parse localStorage key: ${key}`, err);
            return fallback;
        }
    }

    _save(key, value) {
        this.storage.setItem(key, JSON.stringify(value));
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

    getHideContentWarnings() {
        return this._load("hideContentWarnings", true) === true;
    }

    saveHideContentWarnings(hidden) {
        this._save("hideContentWarnings", Boolean(hidden));
    }

    getAllNgWords() {
        return this.getUserNgWords()
            .filter((word) => typeof word === "string" && word.trim());
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
        if (prev && (prev.created_at ?? 0) > next.created_at) {
            this._trimMetadataCache();
            return prev;
        }

        this.metadataByPubkey.delete(event.pubkey);
        this.metadataByPubkey.set(event.pubkey, next);
        this._trimMetadataCache();
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

    _trimMetadataCache() {
        while (this.metadataByPubkey.size > CONFIG.MAX_PROFILE_CACHE) {
            this.metadataByPubkey.delete(this.metadataByPubkey.keys().next().value);
        }
    }
}
