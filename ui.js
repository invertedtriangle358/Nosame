import { CONFIG, NOSTR_KINDS, UI_STRINGS } from "./config.js";
import { NostrCodec } from "./nostr-codec.js";

export class SettingsUIHandler {
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

        this.dom.inputs.hideContentWarnings?.addEventListener("change", (e) => {
            this.storage.saveHideContentWarnings(e.target.checked);
            this.ui.rerenderTimelines();
            this.settingsHandler.setupListeners();
            this._setupComposerResize();
        });
    }

    syncContentWarningToggle() {
        if (!this.dom.inputs.hideContentWarnings) return;
        this.dom.inputs.hideContentWarnings.checked = this.storage.getHideContentWarnings();
    }
    
    updateRelayList({ resetDraft = false } = {}) {
        const container = this.dom.lists.relays;
        if (!container) return;

        if (!resetDraft && container.querySelector(".relay-row")) {
            [...container.querySelectorAll(".relay-row")]
                .forEach((row) => this._updateRelayRowStatus(row));
            return;
        }

        container.innerHTML = "";
        this.storage.getRelays().forEach((url) => this._appendRelayRow(url));
    }

    _updateRelayRowStatus(row) {
        const statusSpan = row.querySelector(".relay-status");
        const inputUrl = row.querySelector(".relay-url-input")?.value?.trim();
        const url = inputUrl || row.dataset.relayUrl || "";
        const isConnected = this._isValidRelayUrl(url) && this.client.getRelayStatus(url);

        if (!statusSpan) return;
        statusSpan.textContent = isConnected ? "🔵" : "🔴";
        statusSpan.title = isConnected ? "接続中" : "未接続";
    }

    _appendRelayRow(url) {
        const container = this.dom.lists.relays;
        if (!container) return;

        const row = document.createElement("div");
        row.className = "relay-row";
        row.dataset.relayUrl = url;

        const isConnected = this.client.getRelayStatus(url);
        row.innerHTML = `
            <span class="relay-status" title="${isConnected ? '接続中' : '未接続'}">
                ${isConnected ? '🔵' : '🔴'}
            </span>
            <input type="text" value="${this.ui._escape(url)}" class="relay-url-input">
            <button class="btn-delete-relay" type="button">×</button>
        `;

        row.querySelector(".btn-delete-relay").onclick = () => row.remove();
        container.appendChild(row);
    }

    _isValidRelayUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === "wss:";
        } catch {
            return false;
        }
    }

    _relayKey(url) {
        return String(url ?? "").trim().replace(/\/+$/, "");
    }

    _getDraftRelays() {
        const container = this.dom.lists.relays;
        if (!container) return [];

        const urls = [...container.querySelectorAll(".relay-url-input")]
            .map((input) => input.value.trim())
            .filter(Boolean);
        const seen = new Set();
        const relays = [];

        for (const url of urls) {
            if (!this._isValidRelayUrl(url)) {
                alert(UI_STRINGS.INVALID_WSS);
                return null;
            }

            const key = this._relayKey(url);
            if (seen.has(key)) {
                alert(UI_STRINGS.DUPLICATE_RELAY);
                return null;
            }

            seen.add(key);
            relays.push(url);
        }

        return relays;
    }

    updateNgList() {
            const container = this.dom.lists.ngWords;
            if (!container) return;
            container.innerHTML = "";

        const words = this.storage.getUserNgWords();
        words.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(word)}">
                <button class="btn-delete-ng" type="button">×</button>
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
                <button class="btn-delete-blocked" type="button">×</button>
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

        if (!this._isValidRelayUrl(url)) {
            alert(UI_STRINGS.INVALID_WSS);
            return;
        }

        const relays = this._getDraftRelays();
        if (!relays) return;

        const key = this._relayKey(url);
        if (relays.some((relay) => this._relayKey(relay) === key)) {
            alert(UI_STRINGS.DUPLICATE_RELAY);
            return;
        }

        this._appendRelayRow(url);
        input.value = "";
    }

    _saveRelays() {
        const relays = this._getDraftRelays();
        if (!relays) return;

        this.storage.saveRelays(relays);
        this.updateRelayList({ resetDraft: true });
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

export class UIManager {
    constructor(client, storage, profiles) {
        this.client = client;
        this.storage = storage;
        this.profiles = profiles;
        this.dom = {};

        this.eventBuffer = [];
        this.bufferTimer = null;
        this.settingsHandler = null;
        this.events = [];
        this.timelineEventIds = new Set();
        this.referencedEvents = new Map();
        this.profilePubkey = null;
        this.replyTarget = null;
        this.threadRootId = null;
        this.defaultComposePlaceholder = "";
    }

    init() {
        this._cacheDom();
        this.defaultComposePlaceholder = this.dom.inputs.compose?.getAttribute("placeholder") ?? "";
        this.settingsHandler = new SettingsUIHandler(this.dom, this.storage, this.client, this);

        this._setupListeners();
        this.settingsHandler.updateRelayList();
        this.settingsHandler.updateNgList();
        this.settingsHandler.updateBlockedPubkeyList();
    }

    _cacheDom() {
        const $ = (id) => document.getElementById(id);

        this.dom = {
            composerResizeHandle: $("composerResizeHandle"),
            timeline: $("timeline"),
            profilePage: $("profilePage"),
            profileTimeline: $("profileTimeline"),
            panels: {
                settings: $("settingsPanel"),
                backdrop: $("menuBackdrop"),
            },
            buttons: {
                titleHome: $("appTitle"),
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
                hideContentWarnings: $("hideContentWarningsInput"),
            },
            lists: {
                relays: $("relayList"),
                ngWords: $("ngWordList"),
                blockedPubkeys: $("blockedPubkeyList"),
            },
            counters: {
                char: $("charCount"),
            },
            profile: {
                name: $("profileName"),
                bio: $("profileBio"),
                pubkey: $("profilePubkey"),
                icon: $("profileIcon"),
                iconFallback: $("profileIconFallback"),
            },
        };
    }

    _setupListeners() {
        const btn = this.dom.buttons;

        btn.openMenu?.addEventListener("click", () => {
            this.toggleSettingsPanel(true);
            this.settingsHandler.updateRelayList({ resetDraft: true });
            this.settingsHandler.updateNgList();
            this.settingsHandler.updateBlockedPubkeyList();
            this.settingsHandler.syncContentWarningToggle();
        });

        btn.closeMenu?.addEventListener("click", () => {
            this.toggleSettingsPanel(false);
        });

        btn.publish?.addEventListener("click", () => this._handlePublish());
        btn.titleHome?.addEventListener("click", () => this.showTimeline());
        btn.titleHome?.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.showTimeline();
            }
        });
        this.dom.profile.icon?.addEventListener("click", async () => {
            if (this.profilePubkey) await this._copyNpub(this.profilePubkey);
        });

        this.dom.profile.iconFallback?.addEventListener("click", async () => {
            if (this.profilePubkey) await this._copyNpub(this.profilePubkey);
        });

        this.settingsHandler.setupListeners();
        this._setupComposerResize();

        btn.scrollLeft?.addEventListener("click", () => {
            this._getActiveTimeline()?.scrollBy({ left: -300, behavior: "smooth" });
        });

        btn.scrollRight?.addEventListener("click", () => {
            this._getActiveTimeline()?.scrollBy({ left: 300, behavior: "smooth" });
        });

        this.dom.inputs.compose?.addEventListener("input", (e) => {
            const len = this._getVisibleContentLength(e.target.value);
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

        window.addEventListener("hashchange", () => this._syncRoute());
        this._syncRoute();
    }

        _setupComposerResize() {
        const handle = this.dom.composerResizeHandle;
        const sidebar = handle?.closest(".sidebar");
        if (!handle || !sidebar) return;

        const minWidth = 60;
        const maxWidth = 320;

        handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();

            const startX = e.clientX;
            const startWidth = sidebar.getBoundingClientRect().width;
            document.body.classList.add("is-resizing-composer");

            const onMove = (moveEvent) => {
                moveEvent.preventDefault();
                const nextWidth = Math.min(
                    Math.max(startWidth + startX - moveEvent.clientX, minWidth),
                    maxWidth
                );
                sidebar.style.width = `${nextWidth}px`;
            };

            const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onUp);
                document.body.classList.remove("is-resizing-composer");
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        });
    }

    _getActiveTimeline() {
        return this.profilePubkey ? this.dom.profileTimeline : this.dom.timeline;
    }

    _compareEvents(a, b) {
        if ((a?.created_at ?? 0) !== (b?.created_at ?? 0)) {
            return (a?.created_at ?? 0) - (b?.created_at ?? 0);
        }
        return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    }

    _captureScrollState(view) {
        if (!view) return null;
        return {
            atRight: view.scrollLeft >= view.scrollWidth - view.clientWidth - 10,
            prevWidth: view.scrollWidth,
        };
    }

    _restoreScrollState(view, state) {
        if (!view || !state) return;
        const newWidth = view.scrollWidth;

        if (state.atRight) {
            view.scrollLeft = newWidth - view.clientWidth;
        } else {
            view.scrollLeft += newWidth - state.prevWidth;
        }
    }

    _scrollTimelineToLatest() {
        const timeline = this.dom.timeline;
        if (!timeline) return;

        requestAnimationFrame(() => {
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
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

    if (this._getVisibleContentLength(content) > CONFIG.MAX_POST_LENGTH) {
        alert(UI_STRINGS.INVALID_CONTENT);
        return;
    }

    try {
        const quoteRefs = this._extractEventReferences(content);
        const quoteTags = quoteRefs.map((ref) => ["q", ref.id, ref.relays?.[0] ?? "", ref.author ?? ""]);
        const replyTags = this.replyTarget ? this._buildReplyTags(this.replyTarget) : [];
        const event = await this.client.publish(content, [...replyTags, ...quoteTags]);
        this.renderEvent(event);
        this._clearReplyTarget();
        input.value = "";
        if (this.dom.counters.char) {
            this.dom.counters.char.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
            this.dom.counters.char.style.color = "";
        }
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
        const timelineView = this.dom.timeline;
        if (!timelineView) return;

        const timelineState = this._captureScrollState(timelineView);
        const profileState = this.profilePubkey ? this._captureScrollState(this.dom.profileTimeline) : null;

        this.eventBuffer
            .sort((a, b) => this._compareEvents(a, b))
            .forEach((event) => this.renderEvent(event));

        this.eventBuffer = [];
        this.bufferTimer = null;

        this._restoreScrollState(timelineView, timelineState);
        if (this.profilePubkey) {
            this._restoreScrollState(this.dom.profileTimeline, profileState);
        }
    }

    _storeEvent(ev) {
        if (!ev?.id) return false;

        if (!this.events.some((item) => item.id === ev.id)) {
            this.events.push(ev);
            this.events.sort((a, b) => this._compareEvents(a, b));
            this._trimStoredEvents();
        }

        return this.events.some((item) => item.id === ev.id);
    }

    _trimStoredEvents() {
        if (this.events.length <= CONFIG.MAX_STORED_EVENTS) return;

        const removedEvents = this.events.splice(0, this.events.length - CONFIG.MAX_STORED_EVENTS);
        removedEvents.forEach((event) => {
            this.timelineEventIds.delete(event.id);
            this._removeRenderedEvent(event.id);
        });
    }

    _removeRenderedEvent(id) {
        if (!id) return;

        [this.dom.timeline, this.dom.profileTimeline].forEach((view) => {
            view?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
        });
    }

    renderEvent(ev) {
        if (!ev?.id) return;

        if (!this._storeEvent(ev)) return;
        this.timelineEventIds.add(ev.id);

        if (this._shouldHideEvent(ev)) return;
        if (this.threadRootId && !this._isEventInThread(ev, this.threadRootId)) return;
        this._renderEventInto(this.dom.timeline, ev);

        if (this.profilePubkey && ev.pubkey === this.profilePubkey) {
            this._renderEventInto(this.dom.profileTimeline, ev);
        }
    }

    storeProfileEvent(ev) {
        if (!ev?.id) return;

        if (!this._storeEvent(ev)) return;
        this.client.requestProfiles([ev.pubkey]);

        if (this.profilePubkey && ev.pubkey === this.profilePubkey && !this._shouldHideEvent(ev)) {
            this._renderEventInto(this.dom.profileTimeline, ev);
        }
    }

    renderProfileEvent(ev) {
        this.storeProfileEvent(ev);
    }

    storeReferencedEvent(event) {
        if (!event?.id) return;
        if (this.referencedEvents.has(event.id)) {
            this.referencedEvents.delete(event.id);
        }

        this.referencedEvents.set(event.id, event);
        this._trimReferencedEvents();
        this.client.requestProfiles([event.pubkey]);
        this.rerenderTimelines();
    }

    _trimReferencedEvents() {
        while (this.referencedEvents.size > CONFIG.MAX_REFERENCED_EVENTS) {
            this.referencedEvents.delete(this.referencedEvents.keys().next().value);
        }
    }
    
    rerenderTimelines() {
        if (this.dom.timeline) {
            this.dom.timeline.innerHTML = "";
        }
        if (this.dom.profileTimeline) {
            this.dom.profileTimeline.innerHTML = "";
        }

        const visibleEvents = this.events.filter((event) => !this._shouldHideEvent(event));

        if (this.threadRootId) {
            this._getAllKnownEvents()
                .filter((event) => !this._shouldHideEvent(event))
                .filter((event) => this._isEventInThread(event, this.threadRootId))
                .sort((a, b) => this._compareEvents(a, b))
                .forEach((event) => this._renderEventInto(this.dom.timeline, event));
            this._scrollTimelineToLatest();
            return;
        }

        visibleEvents
            .filter((event) => this.timelineEventIds.has(event.id))
            .forEach((event) => {
                this._renderEventInto(this.dom.timeline, event);
            });

        if (this.profilePubkey) {
            visibleEvents
                .filter((event) => event.pubkey === this.profilePubkey)
                .forEach((event) => this._renderEventInto(this.dom.profileTimeline, event));
        }

        this._scrollTimelineToLatest();
    }

    _shouldHideEvent(event) {
        return this.storage.getHideContentWarnings() && this.client.validator?.isContentWarning(event);
    }
    
    _renderEventInto(view, ev) {
        if (!view || view.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) return;

        const el = document.createElement("div");
        el.className = "note";
        el.dataset.id = ev.id;
        el.dataset.pubkey = ev.pubkey ?? "";
        el.dataset.createdAt = String(ev.created_at);

        const reacted = this.client.reactedEventIds.has(ev.id);
        const reposted = this.client.repostedEventIds.has(ev.id);
        const profile = this.profiles.getProfile(ev.pubkey ?? "");
        const embeddedEvent = this._getEmbeddedEvent(ev);
        const replyRef = this._getReplyParentReference(ev);
        const rootRef = this._getReplyRootReference(ev);
        const replyEvent = replyRef ? this._findKnownEvent(replyRef.id) : null;
        const quoteRefs = this._getQuoteReferences(ev);
        const requestedRefs = [...quoteRefs, replyRef, rootRef]
            .filter(Boolean)
            .filter((ref, index, refs) => refs.findIndex((item) => item.id === ref.id) === index)
            .slice(0, CONFIG.MAX_EVENT_REFERENCE_REQUEST_IDS);
        if (requestedRefs.length > 0) {
            this.client.requestEvents(requestedRefs.map((ref) => ref.id));
        }
        el.innerHTML = `
            ${replyRef ? this._renderReplyContext(replyEvent, replyRef) : ""}
            <div class="content">${this._formatContent(this._getDisplayContent(ev), { stripReferences: Boolean(embeddedEvent) })}</div>
            ${embeddedEvent ? this._renderEmbeddedEvent(embeddedEvent) : ""}
            <div class="meta">
                <button class="author author-link" type="button">${this._escape(profile.displayName)}</button>
                <span class="pubkey">🔑${this._escape(this._formatNpub(ev.pubkey ?? "").short)}</span>
                <span class="time">${this._escape(this._formatTimestamp(ev.created_at))}</span>
            </div>
            <div class="note-actions">
                <button class="btn-reaction" type="button" aria-label="Send reaction" ${reacted ? "disabled" : ""}>${reacted ? "★" : "☆"}</button>
                <button class="btn-reply" type="button">返答</button>
                <button class="btn-thread" type="button">会話</button>
                <button class="btn-quote" type="button">引用</button>
                <button class="btn-repost" type="button" ${reposted ? "disabled" : ""}>${reposted ? "済" : "拡散"}</button>
            </div>
        `;

        el.querySelector(".author-link").onclick = () => {
            this.showProfile(ev.pubkey ?? "");
        };

        el.querySelector(".pubkey").onclick = async () => {
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
        
        el.querySelector(".btn-quote").onclick = () => {
            this._insertQuoteReference(ev);
        };

        el.querySelector(".btn-reply").onclick = () => {
            this._setReplyTarget(ev);
        };

        el.querySelector(".btn-thread").onclick = () => {
            this.showThread(ev);
        };

        el.querySelector(".btn-repost").onclick = async (e) => {
            try {
                const repostEvent = await this.client.sendRepost(ev);
                if (repostEvent) this.renderEvent(repostEvent);
                e.target.textContent = "済";
                e.target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        };
        
        const insertBefore = [...view.querySelectorAll(".note")].find((node) => {
            const otherCreatedAt = Number(node.dataset.createdAt || 0);
            if (otherCreatedAt !== ev.created_at) return otherCreatedAt > ev.created_at;
            return (node.dataset.id || "") > ev.id;
        });

        if (insertBefore) {
            view.insertBefore(el, insertBefore);
        } else {
            view.appendChild(el);
        }
    }

    _insertQuoteReference(event) {
        const input = this.dom.inputs.compose;
        if (!input || !event?.id) return;

        const nevent = NostrCodec.toNevent({
            id: event.id,
            relays: event._relayUrl ? [event._relayUrl] : [],
            author: event.pubkey ?? "",
            kind: event.kind ?? 1,
        });
        const reference = `nostr:${nevent}`;
        const separator = input.value.trim() ? "\n" : "";

        input.value = `${input.value}${separator}${reference}`;
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    _setReplyTarget(event) {
        if (!event?.id) return;

        this.replyTarget = event;
        const profile = this.profiles.getProfile(event.pubkey ?? "");
        if (this.dom.inputs.compose) {
            this.dom.inputs.compose.placeholder = `返答先: ${profile.displayName}`;
            this.dom.inputs.compose.focus();
        }
        if (this.dom.buttons.publish) {
            this.dom.buttons.publish.textContent = "返答";
        }
    }

    _clearReplyTarget() {
        this.replyTarget = null;
        if (this.dom.inputs.compose) {
            this.dom.inputs.compose.placeholder = this.defaultComposePlaceholder;
        }
        if (this.dom.buttons.publish) {
            this.dom.buttons.publish.textContent = "投稿";
        }
    }

    _isHexId(value) {
        return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
    }

    _eventToReference(event) {
        if (!event?.id) return null;

        return {
            id: event.id.toLowerCase(),
            relays: event._relayUrl ? [event._relayUrl] : [],
            author: event.pubkey ?? "",
            kind: event.kind ?? NOSTR_KINDS.TEXT,
        };
    }

    _getEventTagReferences(event) {
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        return tags
            .filter((tag) => Array.isArray(tag) && tag[0] === "e" && this._isHexId(tag[1] ?? ""))
            .map((tag) => ({
                id: tag[1].toLowerCase(),
                relays: tag[2] ? [tag[2]] : [],
                marker: tag[3] ?? "",
                author: tag[4] ?? "",
                kind: NOSTR_KINDS.TEXT,
            }));
    }

    _getReplyRootReference(event) {
        if (event?.kind !== NOSTR_KINDS.TEXT) return null;

        const refs = this._getEventTagReferences(event);
        const markedRoot = refs.find((ref) => ref.marker === "root");
        if (markedRoot) return markedRoot;
        if (refs.length === 0) return null;

        return refs[0];
    }

    _getReplyParentReference(event) {
        if (event?.kind !== NOSTR_KINDS.TEXT) return null;

        const refs = this._getEventTagReferences(event);
        const markedReply = refs.find((ref) => ref.marker === "reply");
        if (markedReply) return markedReply;
        if (refs.length === 0) return null;

        return refs[refs.length - 1];
    }

    _getReplyParticipantPubkeys(event) {
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        return [
            event?.pubkey ?? "",
            ...tags
                .filter((tag) => Array.isArray(tag) && tag[0] === "p" && this._isHexId(tag[1] ?? ""))
                .map((tag) => tag[1].toLowerCase()),
        ].filter((pubkey, index, pubkeys) => this._isHexId(pubkey) && pubkeys.indexOf(pubkey) === index);
    }

    _buildReplyTags(target) {
        const parentRef = this._eventToReference(target);
        if (!parentRef) return [];

        const rootRef = this._getReplyRootReference(target) ?? parentRef;
        const eventTags = rootRef.id === parentRef.id
            ? [["e", parentRef.id, parentRef.relays[0] ?? "", "root", parentRef.author ?? ""]]
            : [
                ["e", rootRef.id, rootRef.relays[0] ?? "", "root", rootRef.author ?? ""],
                ["e", parentRef.id, parentRef.relays[0] ?? "", "reply", parentRef.author ?? ""],
            ];

        const pubkeyTags = this._getReplyParticipantPubkeys(target)
            .map((pubkey) => ["p", pubkey]);

        return [...eventTags, ...pubkeyTags];
    }

    _findKnownEvent(id) {
        if (!id) return null;
        return this.events.find((event) => event.id === id) ?? this.referencedEvents.get(id) ?? null;
    }

    _getAllKnownEvents() {
        const byId = new Map();
        this.events.forEach((event) => byId.set(event.id, event));
        this.referencedEvents.forEach((event, id) => byId.set(id, event));
        return [...byId.values()];
    }

    _isEventInThread(event, rootId) {
        if (!event?.id || !rootId) return false;
        if (event.id === rootId) return true;

        const rootRef = this._getReplyRootReference(event);
        if (rootRef?.id === rootId) return true;

        return this._getEventTagReferences(event).some((ref) => ref.id === rootId);
    }

    _renderReplyContext(event, ref) {
        if (!ref?.id) return "";

        if (!event) {
            return `<div class="reply-context">返信先を取得中</div>`;
        }

        return `
            <div class="reply-context">
                <span>返信先</span>
                ${this._renderEmbeddedEvent(event)}
            </div>
        `;
    }

    _addQuoteReference(refs, ref, limit = CONFIG.MAX_QUOTE_REFERENCES_PER_EVENT) {
        if (!ref?.id || refs.length >= limit) return;
        if (refs.some((item) => item.id === ref.id)) return;
        refs.push(ref);
    }

    _extractEventReferences(text, limit = CONFIG.MAX_QUOTE_REFERENCES_PER_EVENT) {
        const refs = [];
        const pattern = /(?:nostr:)?(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+/gi;

        for (const match of String(text ?? "").matchAll(pattern)) {
            if (refs.length >= limit) break;

            try {
                this._addQuoteReference(refs, NostrCodec.fromNevent(match[0]), limit);
            } catch {
            // Ignore malformed user-pasted references.
            }
        }

        return refs;
    }

    _stripEventReferences(text) {
    return String(text ?? "")
        .replace(/nostr:(nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "")
        .replace(/\b(nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "")
        .trim();
    }

    _getVisibleContentLength(text) {
    return this._stripEventReferences(text).length;
    }
    
    _getQuoteReferences(event) {
        const refs = [];
        const tags = Array.isArray(event?.tags) ? event.tags : [];
        const limit = CONFIG.MAX_QUOTE_REFERENCES_PER_EVENT;

        tags
            .filter((tag) => Array.isArray(tag) && tag[0] === "q" && /^[0-9a-f]{64}$/i.test(tag[1] ?? ""))
            .forEach((tag) => {
                this._addQuoteReference(refs, {
                    id: tag[1].toLowerCase(),
                    relays: tag[2] ? [tag[2]] : [],
                    author: tag[3] ?? "",
                    kind: NOSTR_KINDS.TEXT,
                }, limit);
            });

        if (event?.kind === NOSTR_KINDS.REPOST) {
            tags
                .filter((tag) => Array.isArray(tag) && tag[0] === "e" && /^[0-9a-f]{64}$/i.test(tag[1] ?? ""))
                .forEach((tag) => {
                    this._addQuoteReference(refs, {
                        id: tag[1].toLowerCase(),
                        relays: tag[2] ? [tag[2]] : [],
                        author: "",
                        kind: NOSTR_KINDS.TEXT,
                    }, limit);
                });
        }

        if (event?.kind !== NOSTR_KINDS.REPOST) {
            this._extractEventReferences(event?.content ?? "", limit - refs.length).forEach((ref) => {
                this._addQuoteReference(refs, ref, limit);
            });
        }

        return refs;
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

    _getVerifiedRepostContent(event) {
        if (event?.kind !== NOSTR_KINDS.REPOST) return null;

        let reposted;
        try {
            reposted = JSON.parse(event.content ?? "{}");
        } catch {
            return null;
        }

        if (!this.client.validator?.isEventAuthentic(reposted)) return null;

        const targetId = this._getRepostTargetId(event);
        if (targetId && reposted.id.toLowerCase() !== targetId) return null;

        return reposted;
    }

    _shouldHideEmbeddedEvent(event) {
        if (!event) return true;
        if (this.client.validator?.isPubkeyBlocked(event.pubkey)) return true;
        if (event.kind === NOSTR_KINDS.TEXT && this.client.validator?.isContentInvalid(event.content)) return true;
        return this._shouldHideEvent(event);
    }

    _getDisplayContent(event) {
        if (event?.kind === NOSTR_KINDS.REPOST) {
            return "再投稿";
        }

        return event?.content ?? "";
    }

    _getEmbeddedEvent(event) {
        if (event?.kind === NOSTR_KINDS.REPOST) {
            const reposted = this._getVerifiedRepostContent(event);
            if (reposted && !this._shouldHideEmbeddedEvent(reposted)) return reposted;
        }

        const [ref] = this._getQuoteReferences(event);
        const embedded = ref ? this.events.find((item) => item.id === ref.id) ?? this.referencedEvents.get(ref.id) ?? null : null;
        return embedded && !this._shouldHideEmbeddedEvent(embedded) ? embedded : null;
    }

    _renderEmbeddedEvent(event) {
        const profile = this.profiles.getProfile(event.pubkey ?? "");
        return `
            <div class="embedded-note" data-embedded-id="${this._escape(event.id ?? "")}">
                <div class="embedded-content">${this._formatContent(this._getDisplayContent(event), { stripReferences: true })}</div>
                <div class="embedded-meta">
                    <span>${this._escape(profile.displayName)}</span>
                    <span>${this._escape(this._formatTimestamp(event.created_at))}</span>
                </div>
            </div>
        `;
    }

    showThread(event) {
        const rootRef = this._getReplyRootReference(event) ?? this._eventToReference(event);
        if (!rootRef?.id) return;

        this.threadRootId = rootRef.id;
        this.profilePubkey = null;
        this.client.stopProfileNotes();
        this.client.requestEvents([rootRef.id]);
        this.client.requestThread(rootRef.id);

        this.dom.profilePage.hidden = true;
        this.dom.profilePage.setAttribute("aria-hidden", "true");
        this.dom.timeline.style.display = "flex";
        this.rerenderTimelines();
    }

    showProfile(pubkey) {
        if (!pubkey) return;

        const nextHash = `#profile/${encodeURIComponent(pubkey)}`;
        if (window.location.hash !== nextHash) {
            window.location.hash = nextHash;
            return;
        }

        this.updateProfile(pubkey);
    }

    updateProfile(pubkey) {
        if (!pubkey) return;

        this.threadRootId = null;
        this.profilePubkey = pubkey;
        this.client.requestProfiles([pubkey]);
        this.client.requestProfileNotes(pubkey);

        const profile = this.profiles.getProfile(pubkey);
        const notes = this.events
            .filter((event) => event.pubkey === pubkey)
            .sort((a, b) => this._compareEvents(a, b));

        this.dom.timeline.style.display = "none";
        this.dom.profilePage.hidden = false;
        this.dom.profilePage.setAttribute("aria-hidden", "false");

        this.dom.profile.name.textContent = (profile.displayName || "").slice(0, 8);
        this.dom.profile.bio.textContent = profile.about || "";
        this.dom.profile.pubkey.textContent = this._formatNpub(pubkey).npub;
        this.dom.profile.iconFallback.textContent = "";

        if (profile.picture) {
            this.dom.profile.icon.src = profile.picture;
            // ✅ 修正：エラーハンドリング改善
            this.dom.profile.icon.onerror = () => {
                if (this.dom.profile.iconFallback) {
                    this.dom.profile.icon.hidden = true;
                    this.dom.profile.iconFallback.hidden = false;
                    this.dom.profile.iconFallback.textContent = 
                        profile.displayName?.[0]?.toUpperCase() ?? "?";
                }
            };
            this.dom.profile.icon.hidden = false;
            this.dom.profile.iconFallback.hidden = true;
        } else {
            this.dom.profile.icon.removeAttribute("src");
            this.dom.profile.icon.onerror = null;
            this.dom.profile.icon.hidden = true;
            this.dom.profile.iconFallback.hidden = false;
        }

        this.dom.profileTimeline.innerHTML = "";
        notes
            .filter((event) => !this._shouldHideEvent(event))
            .forEach((event) => this._renderEventInto(this.dom.profileTimeline, event));
    }

    showTimeline() {
        this.client.stopProfileNotes();
        this.profilePubkey = null;
        this.threadRootId = null;
        this.dom.profilePage.hidden = true;
        this.dom.profilePage.setAttribute("aria-hidden", "true");
        this.dom.timeline.style.display = "flex";
        this.rerenderTimelines();
        this._scrollTimelineToLatest();

        if (window.location.hash) {
            history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
    }

    refreshProfileData(pubkey) {
        if (!pubkey) return;

        const profile = this.profiles.getProfile(pubkey);
        document.querySelectorAll(`.note[data-pubkey="${CSS.escape(pubkey)}"]`).forEach((note) => {
            const author = note.querySelector(".author-link");
            if (author) author.textContent = profile.displayName || "";
        });

        if (this.profilePubkey === pubkey) {
            this.updateProfile(pubkey);
        }
    }

    _syncRoute() {
        const match = window.location.hash.match(/^#profile\/(.+)$/);
        if (!match) {
            this.showTimeline();
            return;
        }

        try {
            this.updateProfile(decodeURIComponent(match[1]));
        } catch {
            this.showTimeline();
        }
    }

    _formatTimestamp(timestamp) {
        return new Date(timestamp * 1000).toLocaleString("ja-JP");
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

    _formatContent(text, { stripReferences = false } = {}) {
        const value = stripReferences
            ? String(text ?? "").replace(/(?:nostr:)?(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "").trim()
            : text;
        const safe = this._escape(value);
        return safe
            .replace(/【緊急地震速報】/g, '<span class="alert-eew">【緊急地震速報】</span>')
            .replace(/\n/g, "<br>");
    }
}
