import { CONFIG, NOSTR_KINDS, UI_STRINGS } from "./config.js";

export class NostrClient {
    constructor(storage, validator) {
        this.storage = storage;
        this.validator = validator;

        this.sockets = [];
        this.subId = null;
        this.profileNotesSubId = null;
        this.activeProfileNotesSubId = null;
        this.profileNotesPubkey = null;
        this.profileReqSerial = 0;
        this.oneShotSubscriptionTimers = new Map();
        this.oneShotSubscriptionFilters = new Map();
        this.seenEventIds = new Set();
        this.seenProfileEventIds = new Set();
        this.reactedEventIds = new Set();
        this.repostedEventIds = new Set();
        this.reconnectAttempts = new Map();
        this.reconnectTimers = new Map();
        this.requestedProfilePubkeys = new Map();
        this.requestedReferencedEventIds = new Map();
        this.pendingEventAcks = new Map();

        this.onEventCallback = null;
        this.onProfileEventCallback = null;
        this.onReferencedEventCallback = null;
        this.onMetadataCallback = null;
        this.onStatusCallback = null;
    }

    _createSocket(url) {
        const ws = new WebSocket(url);
        ws._relayUrl = url;
        ws._intentionalClose = false;
        this._attachSocketListeners(ws);
        return ws;
    }

    _attachSocketListeners(ws) {
        ws.onopen = () => {
            console.log("Relay connected:", ws._relayUrl);
            this.reconnectAttempts.delete(ws._relayUrl);
            this._clearReconnectTimer(ws._relayUrl);
            this._notifyStatus();
            if (this.subId) this._sendTextSubscription(ws);
            if (this.profileNotesPubkey) this._sendProfileNotesSubscription(ws);
        };

        ws.onclose = () => {
            console.log("Relay disconnected:", ws._relayUrl);
            this._notifyStatus();

            if (ws._intentionalClose) {
                this.reconnectAttempts.delete(ws._relayUrl);
                this._clearReconnectTimer(ws._relayUrl);
                return;
            }

            this._scheduleReconnect(ws._relayUrl);
        };

        ws.onerror = (err) => {
            console.error("Relay error:", ws._relayUrl, err);
            ws.close();
        };

        ws.onmessage = (ev) => this._handleMessage(ev, ws);
    }

    _notifyStatus() {
        this.onStatusCallback?.();
    }

    connect() {
        this._clearOneShotSubscriptions();
        this._clearReconnectTimers();
        this.reconnectAttempts.clear();
        this._clearRequestCaches();

        this.sockets.forEach((ws) => {
            ws._intentionalClose = true;
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

    _clearOneShotSubscriptions() {
        this.oneShotSubscriptionTimers.forEach((timer) => clearTimeout(timer));
        this.oneShotSubscriptionTimers.clear();
        this.oneShotSubscriptionFilters.clear();
    }

    _clearRequestCaches() {
        this.requestedProfilePubkeys.clear();
        this.requestedReferencedEventIds.clear();
    }

    _clearReconnectTimer(url) {
        const timer = this.reconnectTimers.get(url);
        if (!timer) return;

        clearTimeout(timer);
        this.reconnectTimers.delete(url);
    }

    _clearReconnectTimers() {
        this.reconnectTimers.forEach((timer) => clearTimeout(timer));
        this.reconnectTimers.clear();
    }

    _scheduleReconnect(url) {
        if (!this.storage.getRelays().includes(url)) return;
        if (this.reconnectTimers.has(url)) return;

        const attempts = this.reconnectAttempts.get(url) ?? 0;
        const delay = Math.min(
            CONFIG.RECONNECT_BASE_DELAY_MS * (2 ** attempts),
            CONFIG.RECONNECT_MAX_DELAY_MS
        );

        this.reconnectAttempts.set(url, attempts + 1);
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(url);
            this._reconnect(url);
        }, delay);
        this.reconnectTimers.set(url, timer);
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
        this._clearRequestCaches();

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
                kinds: [NOSTR_KINDS.TEXT, NOSTR_KINDS.REPOST],
                limit: CONFIG.NOSTR_REQ_LIMIT,
                since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO,
            },
        ]));
    }

    _isHexPubkey(value) {
        return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
    }

    requestProfiles(pubkeys) {
        if (!Array.isArray(pubkeys)) return;

        const normalized = [...new Set(
            pubkeys
                .filter((pubkey) => typeof pubkey === "string" && pubkey)
                .map((pubkey) => pubkey.toLowerCase())
                .filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
                .filter((pubkey) => !this._isRecentlyRequested(this.requestedProfilePubkeys, pubkey))
        )];
        if (normalized.length === 0) return;

        const openSockets = this.sockets.filter((ws) => ws.readyState === WebSocket.OPEN);
        if (openSockets.length === 0) return;

        this._chunk(normalized, CONFIG.PROFILE_REQUEST_CHUNK_SIZE).forEach((authors) => {
            const subId = this._registerOneShotSubscription("profile", {
                type: "profile",
                authors: new Set(authors),
            });
            if (!subId) return;

            authors.forEach((pubkey) => this._rememberRequest(this.requestedProfilePubkeys, pubkey));
            openSockets.forEach((ws) => this._sendProfileSubscription(ws, subId, authors));
        });
        this._trimCacheMap(this.requestedProfilePubkeys, CONFIG.PROFILE_REQUEST_CACHE_LIMIT);
    }

    _chunk(values, size) {
        const chunks = [];
        for (let i = 0; i < values.length; i += size) {
            chunks.push(values.slice(i, i + size));
        }
        return chunks;
    }

    _isRecentlyRequested(cache, key) {
        const requestedAt = cache.get(key);
        if (!requestedAt) return false;

        if (Date.now() - requestedAt > CONFIG.REQUEST_CACHE_TTL_MS) {
            cache.delete(key);
            return false;
        }

        return true;
    }

    _rememberRequest(cache, key) {
        cache.set(key, Date.now());
    }

    _trimCacheMap(map, limit) {
        while (map.size > limit) {
            map.delete(map.keys().next().value);
        }
    }

    _registerOneShotSubscription(prefix, filter = {}) {
        if (this.oneShotSubscriptionTimers.size >= CONFIG.MAX_ONE_SHOT_SUBSCRIPTIONS) return null;

        const subId = `${prefix}-${this.profileReqSerial += 1}`;
        const timer = setTimeout(() => {
            this._closeOneShotSubscription(subId);
        }, CONFIG.ONE_SHOT_SUBSCRIPTION_TIMEOUT_MS);
        this.oneShotSubscriptionTimers.set(subId, timer);
        this.oneShotSubscriptionFilters.set(subId, filter);
        return subId;
    }

    _closeOneShotSubscription(subId, ws = null) {
        if (!this.oneShotSubscriptionTimers.has(subId)) return;

        const sockets = ws ? [ws] : this.sockets;
        sockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(["CLOSE", subId]));
            }
        });

        if (!ws) {
            clearTimeout(this.oneShotSubscriptionTimers.get(subId));
            this.oneShotSubscriptionTimers.delete(subId);
            this.oneShotSubscriptionFilters.delete(subId);
        }
    }

    requestProfileNotes(pubkey) {
        if (typeof pubkey !== "string") return;

        const normalized = pubkey.toLowerCase();
        if (!/^[0-9a-f]{64}$/i.test(normalized)) return;
        if (this.profileNotesPubkey === normalized && this.activeProfileNotesSubId) return;

        this.profileNotesPubkey = normalized;
        this.seenProfileEventIds.clear();
        const previousSubId = this.activeProfileNotesSubId;
        this.profileNotesSubId = `profile-notes-${this.profileReqSerial += 1}`;
        this.sockets.forEach((ws) => this._sendProfileNotesSubscription(ws, previousSubId));
        this.activeProfileNotesSubId = this.profileNotesSubId;
    }

    stopProfileNotes() {
        const subId = this.activeProfileNotesSubId ?? this.profileNotesSubId;
        if (subId) {
            this.sockets.forEach((ws) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(["CLOSE", subId]));
                }
            });
        }

        this.profileNotesPubkey = null;
        this.profileNotesSubId = null;
        this.activeProfileNotesSubId = null;
        this.seenProfileEventIds.clear();
    }

    requestEvents(ids) {
        if (!Array.isArray(ids)) return;

        const normalized = [...new Set(
            ids
                .filter((id) => typeof id === "string" && /^[0-9a-f]{64}$/i.test(id))
                .map((id) => id.toLowerCase())
                .filter((id) => !this._isRecentlyRequested(this.requestedReferencedEventIds, id))
        )].slice(0, CONFIG.MAX_EVENT_REFERENCE_REQUEST_IDS);
        if (normalized.length === 0) return;

        const openSockets = this.sockets.filter((ws) => ws.readyState === WebSocket.OPEN);
        if (openSockets.length === 0) return;

        this._chunk(normalized, CONFIG.REFERENCED_EVENT_REQUEST_CHUNK_SIZE).forEach((chunk) => {
            const subId = this._registerOneShotSubscription("refs", {
                type: "refs",
                ids: new Set(chunk),
            });
            if (!subId) return;

            chunk.forEach((id) => this._rememberRequest(this.requestedReferencedEventIds, id));
            openSockets.forEach((ws) => this._sendReferencedEventsSubscription(ws, subId, chunk));
        });
        this._trimCacheMap(this.requestedReferencedEventIds, CONFIG.REFERENCED_EVENT_REQUEST_CACHE_LIMIT);
    }

    _sendProfileSubscription(ws, subId, authors) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!subId || !Array.isArray(authors) || authors.length === 0) return;

        ws.send(JSON.stringify([
            "REQ",
            subId,
            {
                kinds: [NOSTR_KINDS.METADATA],
                authors,
                limit: authors.length,
            },
        ]));
    }

    _sendProfileNotesSubscription(ws, previousSubId = null) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!this.profileNotesPubkey) return;
        if (!this.profileNotesSubId) {
            this.profileNotesSubId = `profile-notes-${this.profileReqSerial += 1}`;
        }

        if (previousSubId) {
            ws.send(JSON.stringify(["CLOSE", previousSubId]));
        }
        ws.send(JSON.stringify([
            "REQ",
            this.profileNotesSubId,
            {
                kinds: [NOSTR_KINDS.TEXT, NOSTR_KINDS.REPOST],
                authors: [this.profileNotesPubkey],
                limit: CONFIG.PROFILE_TIMELINE_LIMIT,
            },
        ]));
    }

    _sendReferencedEventsSubscription(ws, subId, ids) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!subId || !Array.isArray(ids) || ids.length === 0) return;

        ws.send(JSON.stringify([
            "REQ",
            subId,
            {
                ids,
                kinds: [NOSTR_KINDS.TEXT, NOSTR_KINDS.REPOST],
                limit: ids.length,
            },
        ]));
    }

    requestThread(rootId) {
        if (typeof rootId !== "string" || !/^[0-9a-f]{64}$/i.test(rootId)) return;

        const normalized = rootId.toLowerCase();
        const openSockets = this.sockets.filter((ws) => ws.readyState === WebSocket.OPEN);
        if (openSockets.length === 0) return;

        const subId = this._registerOneShotSubscription("thread", {
            type: "thread",
            rootId: normalized,
        });
        if (!subId) return;

        openSockets.forEach((ws) => this._sendThreadSubscription(ws, subId, normalized));
    }

    _sendThreadSubscription(ws, subId, rootId) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!subId || !/^[0-9a-f]{64}$/i.test(rootId)) return;

        ws.send(JSON.stringify([
            "REQ",
            subId,
            {
                kinds: [NOSTR_KINDS.TEXT],
                "#e": [rootId],
                limit: CONFIG.THREAD_REQUEST_LIMIT,
            },
        ]));
    }

    _getRepostTargetId(event) {
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        const targetTag = tags.find((tag) =>
            Array.isArray(tag) &&
            tag[0] === "e" &&
            /^[0-9a-f]{64}$/i.test(tag[1] ?? "")
        );

        return targetTag ? targetTag[1].toLowerCase() : "";
    }

    _hasEventReference(event, id) {
        const normalized = String(id ?? "").toLowerCase();
        if (!/^[0-9a-f]{64}$/i.test(normalized)) return false;

        const tags = Array.isArray(event?.tags) ? event.tags : [];
        return tags.some((tag) =>
            Array.isArray(tag) &&
            tag[0] === "e" &&
            String(tag[1] ?? "").toLowerCase() === normalized
        );
    }

        if (!this.validator.isEventContentSizeAllowed(reposted)) return null;
        if (!this.validator.isEventAuthentic(reposted)) return null;

        const targetId = this._getRepostTargetId(event);
        if (targetId && reposted.id.toLowerCase() !== targetId) return null;

        return reposted;
    }

    _isTextEventAllowed(event) {
        return event.kind === NOSTR_KINDS.TEXT && !this.validator.isContentInvalid(event.content);
    }

    _isRepostEventAllowed(event) {
        if (event.kind !== NOSTR_KINDS.REPOST) return false;
        if (!this._getRepostTargetId(event)) return false;

        const content = String(event.content ?? "").trim();
        if (!content) return true;

        const reposted = this._parseVerifiedRepostContent(event);
        if (!reposted) return false;
        if (this.validator.isPubkeyBlocked(reposted.pubkey)) return false;
        if (reposted.kind === NOSTR_KINDS.TEXT && this.validator.isContentInvalid(reposted.content)) return false;

        return true;
    }

    _isKnownEventSubscription(subId) {
        if (subId === this.subId) return true;
        if (subId === this.activeProfileNotesSubId) return true;
        return typeof subId === "string" && this.oneShotSubscriptionTimers.has(subId);
    }

    _isExpectedEventForSubscription(subId, event) {
        if (subId === this.subId) return true;

        if (subId === this.activeProfileNotesSubId) {
            return event.pubkey === this.profileNotesPubkey;
        }

        const filter = this.oneShotSubscriptionFilters.get(subId);
        if (!filter) return false;

        if (filter.type === "profile") {
            return event.kind === NOSTR_KINDS.METADATA && filter.authors?.has(event.pubkey);
        }

        if (filter.type === "refs") {
            return filter.ids?.has(String(event.id ?? "").toLowerCase());
        }

        if (filter.type === "thread") {
            const rootId = filter.rootId;
            return event.id?.toLowerCase() === rootId || this._hasEventReference(event, rootId);
        }

        return false;
    }

    _handleOkMessage(eventId, accepted, message, ws = null) {
        if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/i.test(eventId)) return;

        this._recordEventAck(
            eventId.toLowerCase(),
            ws?._relayUrl ?? "",
            accepted === true,
            String(message ?? "")
        );
    }

    _resolveEventAck(eventId, result) {
        const pending = this.pendingEventAcks.get(eventId);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingEventAcks.delete(eventId);
        pending.resolve(result);
    }

    _rejectEventAck(eventId, error) {
        const pending = this.pendingEventAcks.get(eventId);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingEventAcks.delete(eventId);
        pending.reject(error);
    }

    _recordEventAck(eventId, relayUrl, accepted, message = "") {
        const pending = this.pendingEventAcks.get(eventId);
        if (!pending) return;

        const url = relayUrl || "unknown";
        pending.responses.set(url, { accepted, message });

        if (accepted) {
            this._resolveEventAck(eventId, {
                eventId,
                relayUrl: url,
                message,
                responses: [...pending.responses.entries()],
            });
            return;
        }

        const allRelaysAnswered = [...pending.expectedRelays]
            .every((expectedUrl) => pending.responses.has(expectedUrl));
        if (!allRelaysAnswered) return;

        const reason = [...pending.responses.values()]
            .map((response) => response.message)
            .find(Boolean) || UI_STRINGS.EVENT_REJECTED;
        this._rejectEventAck(eventId, new Error(reason));
    }
    
    _handleMessage(ev, ws = null) {
        try {
            if (typeof ev.data !== "string") return;
            if (ev.data.length > CONFIG.MAX_RELAY_MESSAGE_BYTES) return;

            const message = JSON.parse(ev.data);
            if (!Array.isArray(message)) return;

            const [type, subId, event] = message;

            if (type === "OK") {
                const [, eventId, accepted, relayMessage] = message;
                this._handleOkMessage(eventId, accepted, relayMessage, ws);
                return;
            }

            if (type === "EOSE") {
                this._closeOneShotSubscription(subId, ws);
                return;
            }

            if (type !== "EVENT" || !event?.id) return;
            if (!this._isKnownEventSubscription(subId)) return;
            if (!this._isExpectedEventForSubscription(subId, event)) return;
            if (!this.validator.isEventContentSizeAllowed(event)) return;

            event._relayUrl = ws?._relayUrl ?? "";

            if (!this.validator.isEventAuthentic(event)) return;

            if (this.oneShotSubscriptionTimers.has(subId) && subId.startsWith("profile-")) {
                if (event.kind !== NOSTR_KINDS.METADATA) return;
                if (this.validator.isPubkeyBlocked(event.pubkey)) return;
                this.onMetadataCallback?.(event);
                return;
            }

            if (this.oneShotSubscriptionTimers.has(subId) && subId.startsWith("refs-")) {
                if (this.validator.isPubkeyBlocked(event.pubkey)) return;
                if (!this._isTextEventAllowed(event) && !this._isRepostEventAllowed(event)) return;
                this.onReferencedEventCallback?.(event);
                return;
            }

            if (this.oneShotSubscriptionTimers.has(subId) && subId.startsWith("thread-")) {
                if (this.validator.isPubkeyBlocked(event.pubkey)) return;
                if (!this._isTextEventAllowed(event)) return;
                this.onReferencedEventCallback?.(event);
                return;
            }

            if (typeof subId === "string" && subId.startsWith("profile-notes-")) {
                if (subId !== this.activeProfileNotesSubId) return;
                if (this.seenProfileEventIds.has(event.id)) return;
                this.seenProfileEventIds.add(event.id);
                if (this.validator.isPubkeyBlocked(event.pubkey)) return;
                if (!this._isTextEventAllowed(event) && !this._isRepostEventAllowed(event)) return;
                this.onProfileEventCallback?.(event);
                return;
            }

            if (subId !== this.subId) return;
            if (this.seenEventIds.has(event.id)) return;
            this.seenEventIds.add(event.id);
            this._trimSeenEventIds();

            if (this.validator.isPubkeyBlocked(event.pubkey)) return;
            if (!this._isTextEventAllowed(event) && !this._isRepostEventAllowed(event)) return;

            this.onEventCallback?.(event);
        } catch (err) {
            console.error("Failed to parse relay message.", err);
        }
    }

    // ✅ メモリリーク対策メソッド
    _trimSeenEventIds() {
        const MAX_EVENTS = 10000;
        const CLEANUP_SIZE = 1000;

        if (this.seenEventIds.size > MAX_EVENTS) {
            const toDelete = [...this.seenEventIds].slice(0, CLEANUP_SIZE);
            toDelete.forEach(id => this.seenEventIds.delete(id));
            console.log(`Trimmed seenEventIds: ${this.seenEventIds.size} remaining`);
        }
    }

    buildPostTags(content) {
        const tags = [];
        tags.push([
            "client",
            "Nosame"
        ]);
        const hashtags = content.match(/#[^\s#]+/g) || [];
        hashtags.forEach(tag => {
            tags.push([
                "t",
                tag.substring(1)
            ]);
        });
    const urls = content.match(/https?:\/\/[^\s)\]}>,]+/g) || [];
        urls.forEach(url => {
            tags.push([
                "r",
                url
            ]);
        });
        return tags;
    }
    
    async publish(content, extraTags = []) {
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
            tags: [...this.buildPostTags(content), ...extraTags],
            pubkey,
        };

        const signed = await window.nostr.signEvent(event);
        if (!this.validator.isEventAuthentic(signed)) {
            throw new Error("Invalid signed event.");
        }

        await this._broadcast(signed);
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
        if (!this.validator.isEventAuthentic(signed)) {
            throw new Error("Invalid signed event.");
        }

        await this._broadcast(signed);
        this.reactedEventIds.add(target.id);
        return signed;
    }

    async sendRepost(target) {
        if (!target?.id) return;
        if (this.repostedEventIds.has(target.id)) return;
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);
        if (!this.validator.isEventAuthentic(target)) {
            throw new Error("Invalid repost target.");
        }

        const pubkey = await window.nostr.getPublicKey();
        if (this.validator.isPubkeyBlocked(pubkey)) {
            throw new Error(UI_STRINGS.BLOCKED_PUBKEY);
        }

        const event = {
            kind: NOSTR_KINDS.REPOST,
            content: JSON.stringify(this._toRepostContentEvent(target)),
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ["e", target.id, target._relayUrl ?? ""],
                ["p", target.pubkey ?? ""],
            ],
            pubkey,
        };
        if (!this.validator.isEventContentSizeAllowed(event)) {
            throw new Error(UI_STRINGS.INVALID_CONTENT);
        }

        const signed = await window.nostr.signEvent(event);
        await this._broadcast(signed);
        this.repostedEventIds.add(target.id);
        return signed;
    }

    _toRepostContentEvent(event) {
        return {
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            kind: event.kind,
            tags: Array.isArray(event.tags) ? event.tags : [],
            content: event.content ?? "",
            sig: event.sig,
        };
    }

    _broadcast(event) {
        const data = JSON.stringify(["EVENT", event]);
        const openSockets = this.sockets.filter((ws) => ws.readyState === WebSocket.OPEN);

        if (openSockets.length === 0) throw new Error(UI_STRINGS.NO_RELAY);

        return new Promise((resolve, reject) => {
            const expectedRelays = new Set(openSockets.map((ws) => ws._relayUrl ?? "unknown"));
            const timer = setTimeout(() => {
                const pending = this.pendingEventAcks.get(event.id);
                const responseMessage = pending
                    ? [...pending.responses.values()].map((response) => response.message).find(Boolean)
                    : "";
                this._rejectEventAck(event.id, new Error(responseMessage || UI_STRINGS.EVENT_ACK_TIMEOUT));
            }, CONFIG.EVENT_ACK_TIMEOUT_MS);

            this.pendingEventAcks.set(event.id, {
                expectedRelays,
                responses: new Map(),
                timer,
                resolve,
                reject,
            });

            openSockets.forEach((ws) => {
                try {
                    ws.send(data);
                } catch (err) {
                    this._recordEventAck(
                        event.id,
                        ws._relayUrl ?? "",
                        false,
                        err instanceof Error ? err.message : String(err)
                    );
                }
            });
        });
    }
}
