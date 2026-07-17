import { CONFIG, NOSTR_KINDS } from "./config.js";

export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_VERSION_KEY =
    "nosameStorageSchemaVersion";

export class StorageManager {
    constructor(storageAdapter = localStorage) {
    this.storage = storageAdapter;
    this.defaultNgWords = [];
    this.warnedInvalidKeys = new Set();

    this._migrateStorage();
}

    _getStoredVersion() {
        const version = this._load(
            STORAGE_VERSION_KEY,
            0
        );

        return (
            Number.isInteger(version) &&
            version >= 0
        )
            ? version
            : 0;
    }

    _hasStoredValue(key) {
        return (
            this.storage.getItem(key) !== null
        );
    }

    _migrateStorage() {
        let version =
            this._getStoredVersion();

        if (
            version >
            STORAGE_SCHEMA_VERSION
        ) {
            console.warn(
                `Unsupported localStorage schema version: ${version}. ` +
                `Current version: ${STORAGE_SCHEMA_VERSION}.`
            );

            return false;
        }

        try {
            while (
                version <
                STORAGE_SCHEMA_VERSION
            ) {
                if (version === 0) {
                    this._migrateV0ToV1();
                } else {
                    throw new Error(
                        `Missing migration from storage version ${version}.`
                    );
                }
                version += 1;
            /*
             * 各段階のデータ移行がすべて成功した後で
             * バージョンを保存する。
             */
                this._save(
                    STORAGE_VERSION_KEY,
                    version
                );
            }

            return true;
        } catch (err) {
            console.error(
                `Failed to migrate localStorage from version ${version}.`,
                err
            );

        /*
         * バージョンは更新しない。
         * 次回起動時に同じ移行を再試行する。
         */
            return false;
        }
    }

    _migrateV0ToV1() {
        if (
            this._hasStoredValue("relays")
        ) {
            this.saveRelays(
                this._loadArray(
                    "relays",
                    CONFIG.DEFAULT_RELAYS
                )
            );
        }

        if (
            this._hasStoredValue(
                "userNgWords"
            )
        ) {
            this.saveUserNgWords(
                this._loadArray(
                    "userNgWords"
                )
            );
        }

        if (
            this._hasStoredValue(
                "blockedPubkeys"
            )
        ) {
            this.saveBlockedPubkeys(
                this._loadArray(
                    "blockedPubkeys"
                )
            );
        }

        if (
            this._hasStoredValue(
                "hideContentWarnings"
            )
        ) {
            this.saveHideContentWarnings(
                this.getHideContentWarnings()
            );
        }
    }
    
    _load(key, fallback) {
        try {
            const raw = this.storage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (err) {
            console.warn(
                `Failed to parse localStorage key: ${key}`,
                err
            );
            return fallback;
        }
    }

    _loadArray(key, fallback = []) {
        const value = this._load(key, fallback);

        if (Array.isArray(value)) {
            return value;
        }

        if (!this.warnedInvalidKeys.has(key)) {
            console.warn(
                `Invalid localStorage type for key: ${key}. Expected an array.`
            );
            this.warnedInvalidKeys.add(key);
        }

        return [...fallback];
    }

    _normalizeRelays(relays) {
        if (!Array.isArray(relays)) {
            return [];
        }

        const result = [];
        const seen = new Set();

        relays.forEach((value) => {
            if (typeof value !== "string") {
                return;
            }

            const relay = value.trim();

            if (!relay) {
                return;
            }

            try {
                const parsed = new URL(relay);

                if (parsed.protocol !== "wss:") {
                    return;
                }

                const key = parsed.href.replace(/\/+$/, "");

                if (seen.has(key)) {
                    return;
                }

                seen.add(key);
                result.push(relay);
            } catch {
                // 古いデータや破損データの不正なURLは無視する
            }
        });

        return result;
    }

    _normalizeNgWords(words) {
        if (!Array.isArray(words)) {
            return [];
        }

        return [
            ...new Set(
                words
                    .filter((word) => typeof word === "string")
                    .map((word) => word.trim())
                    .filter(Boolean)
            ),
        ];
    }

    _normalizeBlockedPubkeys(pubkeys) {
        if (!Array.isArray(pubkeys)) {
            return [];
        }

        return [
            ...new Set(
                pubkeys
                    .filter((pubkey) => typeof pubkey === "string")
                    .map((pubkey) => pubkey.trim().toLowerCase())
                    .filter((pubkey) =>
                        /^[0-9a-f]{64}$/.test(pubkey)
                    )
            ),
        ];
    }

    _save(key, value) {
        this.storage.setItem(key, JSON.stringify(value));
    }

    getRelays() {
        return this._normalizeRelays(
            this._loadArray(
                "relays",
                CONFIG.DEFAULT_RELAYS
            )
        );
    }

    saveRelays(relays) {
        this._save(
            "relays",
            this._normalizeRelays(relays)
        );
    }

    getUserNgWords() {
        return this._normalizeNgWords(
            this._loadArray("userNgWords")
        );
    }

    saveUserNgWords(words) {
        this._save(
            "userNgWords",
            this._normalizeNgWords(words)
        );
    }

    getBlockedPubkeys() {
        return this._normalizeBlockedPubkeys(
            this._loadArray("blockedPubkeys")
        );
    }

    saveBlockedPubkeys(pubkeys) {
        this._save(
            "blockedPubkeys",
            this._normalizeBlockedPubkeys(pubkeys)
        );
    }

    getHideContentWarnings() {
        const value = this._load(
            "hideContentWarnings",
            true
        );

        return typeof value === "boolean"
            ? value
            : true;
    }

    saveHideContentWarnings(hidden) {
        this._save(
            "hideContentWarnings",
            Boolean(hidden)
        );
    }

    getAllNgWords() {
        return this.getUserNgWords();
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
