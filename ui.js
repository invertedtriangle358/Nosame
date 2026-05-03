import { CONFIG, UI_STRINGS } from "./config.js";
import { NostrCodec } from "./nostr-core.js";

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
    }

    _updateList({ container, getItemList, saveItemList, getStatus, updateCallback }) {
        if (!container) return;
        container.innerHTML = "";

        const items = getItemList.call(this.storage);
        items.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            row.innerHTML = `
                <span class="relay-status">${getStatus.call(this.client, item) ? "On" : "Off"}</span>
                <input type="text" value="${this.ui._escape(item)}" data-idx="${idx}">
                <button class="btn-delete-relay" type="button">Delete</button>
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
                <button type="button" disabled>Fixed</button>
            `;
            container.appendChild(row);
        });

        const words = this.storage.getUserNgWords();
        words.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.ui._escape(word)}">
                <button class="btn-delete-ng" type="button">Delete</button>
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
        this.profilePubkey = null;
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
            profilePage: $("profilePage"),
            profileTimeline: $("profileTimeline"),
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
                backToTimeline: $("btnBackToTimeline"),
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
            this.settingsHandler.updateRelayList();
            this.settingsHandler.updateNgList();
            this.settingsHandler.updateBlockedPubkeyList();
        });

        btn.closeMenu?.addEventListener("click", () => {
            this.toggleSettingsPanel(false);
        });

        btn.publish?.addEventListener("click", () => this._handlePublish());
        btn.backToTimeline?.addEventListener("click", () => this.showTimeline());

        this.settingsHandler.setupListeners();

        btn.scrollLeft?.addEventListener("click", () => {
            this._getActiveTimeline()?.scrollBy({ left: -300, behavior: "smooth" });
        });

        btn.scrollRight?.addEventListener("click", () => {
            this._getActiveTimeline()?.scrollBy({ left: 300, behavior: "smooth" });
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

        window.addEventListener("hashchange", () => this._syncRoute());
        this._syncRoute();
    }

    _getActiveTimeline() {
        return this.profilePubkey ? this.dom.profileTimeline : this.dom.timeline;
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
        const timelineView = this.dom.timeline;
        if (!timelineView) return;

        const timelineState = this._captureScrollState(timelineView);
        const profileState = this.profilePubkey ? this._captureScrollState(this.dom.profileTimeline) : null;

        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at)
            .forEach((event) => this.renderEvent(event));

        this.eventBuffer = [];
        this.bufferTimer = null;

        this._restoreScrollState(timelineView, timelineState);
        if (this.profilePubkey) {
            this._restoreScrollState(this.dom.profileTimeline, profileState);
        }
    }

    renderEvent(ev) {
        if (!ev?.id) return;

        if (!this.events.some((item) => item.id === ev.id)) {
            this.events.push(ev);
            this.events.sort((a, b) => a.created_at - b.created_at);
        }

        this._renderEventInto(this.dom.timeline, ev);

        if (this.profilePubkey && ev.pubkey === this.profilePubkey) {
            this._renderEventInto(this.dom.profileTimeline, ev);
        }
    }

    _renderEventInto(view, ev) {
        if (!view || view.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) return;

        const el = document.createElement("div");
        el.className = "note";
        el.dataset.id = ev.id;
        el.dataset.pubkey = ev.pubkey ?? "";
        el.dataset.createdAt = String(ev.created_at);

        const reacted = this.client.reactedEventIds.has(ev.id);
        const profile = this.profiles.getProfile(ev.pubkey ?? "");
        el.innerHTML = `
            <div class="content">${this._formatContent(ev.content ?? "")}</div>
            <div class="meta">
                <button class="author author-link" type="button">${this._escape(profile.displayName)}</button>
                <span class="pubkey">${this._escape(this._formatNpub(ev.pubkey ?? "").short)}</span>
                <span class="time">${this._escape(this._formatTimestamp(ev.created_at))}</span>
            </div>
            <button class="btn-reaction" type="button" aria-label="Send reaction" ${reacted ? "disabled" : ""}>${reacted ? "Sent" : "+"}</button>
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

        view.appendChild(el);
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

        this.profilePubkey = pubkey;
        const profile = this.profiles.getProfile(pubkey);
        const notes = this.events.filter((event) => event.pubkey === pubkey);
        const fallbackText = (profile.displayName || pubkey.slice(0, 2)).slice(0, 2);

        this.dom.timeline.style.display = "none";
        this.dom.profilePage.hidden = false;
        this.dom.profilePage.setAttribute("aria-hidden", "false");

        this.dom.profile.name.textContent = (profile.displayName || "").slice(0, 8);
        this.dom.profile.bio.textContent = profile.about || "";
        this.dom.profile.pubkey.textContent = this._formatNpub(pubkey).npub;
        this.dom.profile.iconFallback.textContent = fallbackText;

        if (profile.picture) {
            this.dom.profile.icon.src = profile.picture;
            this.dom.profile.icon.onerror = () => {
                this.dom.profile.icon.hidden = true;
                this.dom.profile.iconFallback.hidden = false;
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
        notes.forEach((event) => this._renderEventInto(this.dom.profileTimeline, event));
    }

    showTimeline() {
        this.profilePubkey = null;
        this.dom.profilePage.hidden = true;
        this.dom.profilePage.setAttribute("aria-hidden", "true");
        this.dom.timeline.style.display = "flex";

        if (window.location.hash) {
            history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
    }

    refreshProfileData(pubkey) {
        if (!pubkey) return;

        const profile = this.profiles.getProfile(pubkey);
        document.querySelectorAll(`.note[data-pubkey="${CSS.escape(pubkey)}"]`).forEach((note) => {
            const author = note.querySelector(".author-link");
            if (author) author.textContent = profile.displayName;
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

    _formatContent(text) {
        const safe = this._escape(text);
        return safe.replace(/\n/g, "<br>");
    }
}
