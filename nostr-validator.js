import { CONFIG } from "./config.js";
import { EventReference } from "./event-reference.js";
import {
    validateEvent,
    verifyEvent,
    getEventHash,
} from "https://esm.sh/nostr-tools@2";

export class EventValidator {
    constructor(storage) {
        this.storage = storage;
    }

    isHex(value, length) {
        return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
    }

    isKindValid(kind) {
        return Number.isInteger(kind) && kind >= 0 && kind <= 65535;
    }

    _byteLength(value) {
        return new TextEncoder().encode(String(value ?? "")).length;
    }

    isContentSizeAllowed(content, limit = CONFIG.MAX_EVENT_CONTENT_BYTES) {
        return this._byteLength(content) <= limit;
    }

    isEventContentSizeAllowed(event) {
        const limit = event?.kind === 0
            ? CONFIG.MAX_METADATA_CONTENT_BYTES
            : CONFIG.MAX_EVENT_CONTENT_BYTES;

        return this.isContentSizeAllowed(event?.content ?? "", limit);
    }

    isEventShapeValid(event) {
        return Boolean(
            validateEvent(event) &&
            this.isHex(event.id, 64) &&
            this.isHex(event.pubkey, 64) &&
            this.isHex(event.sig, 128) &&
            this.isKindValid(event.kind)
        );
    }
    
    isEventAuthentic(event) {
        if (!this.isEventShapeValid(event)) return false;

        try {
            if (event.id !== getEventHash(event)) return false;
            return verifyEvent(event);
        } catch (err) {
            console.warn("Failed to validate event signature.", err);
            return false;
        }
    }

    _stripEventReferences(text) {
        return stripEventReferences(text);
    }

    isContentInvalid(text) {
    if (!text) return false;
    if (!this.isContentSizeAllowed(text)) {
        return true;
    }

    const visibleText =
        EventReference.stripFromText(text);

    if (
        visibleText.length >
        CONFIG.MAX_POST_LENGTH
    ) {
        return true;
    }

    const lower = visibleText.toLowerCase();

    return this.storage
        .getAllNgWords()
        .some((ng) =>
            lower.includes(ng.toLowerCase())
        );
}

    isPubkeyBlocked(pubkey) {
        if (!pubkey) return false;
        return this.storage.getBlockedPubkeys().includes(pubkey.toLowerCase());
    }

    isContentWarning(event) {
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        const hasContentWarningTag = tags.some((tag) =>
            Array.isArray(tag) &&
            tag.some((value) => String(value ?? "").toLowerCase() === "content-warning")
        );
        const hasNsfwTag = tags.some((tag) =>
            Array.isArray(tag) &&
            tag.some((value) => String(value ?? "").toLowerCase() === "nsfw")
        );
        const hasNsfwText = /(^|\s)#nsfw(\s|$)/i.test(String(event?.content ?? ""));

        return hasContentWarningTag || hasNsfwTag || hasNsfwText;
    }
}
