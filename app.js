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

const NOSTR_KINDS = {
    TEXT: 1,
    REACTION: 7,
    PROFILE: 0, // ✅ 修正: kind 0 (メタデータ) を追加
};

const UI_STRINGS = {
    EMPTY_POST: "本文を入力してください",
    INVALID_CONTENT: "NGワードまたは文字数制限です",
    NIP07_REQUIRED: "NIP-07拡張機能が必要です",
    NO_RELAY: "接続中のリレーがありません",
    INVALID_WSS: "正しいwss:// URLを入力してください",
    SAVE_RELAY_SUCCESS: "リレー設定を反映して再接続します",
    SAVE_NG_SUCCESS: "NGワードを保存しました",
};

// ✅ 追加: ネットワークリクエスト不要のデフォルトアイコン (シンプルなグレーの円)
const DEFAULT_ICON_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iI2NjY2NjYyIvPjwvc3ZnPg==";

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
        const ngWords = this.storage.getAllNgWords();
        const lower = text.toLowerCase();
        return ngWords.some(ng => lower.includes(ng.toLowerCase()));
    }
}

// =======================
// 3. Storage Manager
// =======================
class StorageManager {
    constructor() {
        this.defaultNgWords = [];
    }
    
    getRelays() {
        return JSON.parse(localStorage.getItem("relays")) || [...CONFIG.DEFAULT_RELAYS];
    }

    saveRelays(relays) {
        localStorage.setItem("relays", JSON.stringify(relays));
    }

    getUserNgWords() {
        return JSON.parse(localStorage.getItem("userNgWords")) || [];
    }

    saveUserNgWords(words) {
        localStorage.setItem("userNgWords", JSON.stringify(words));
    }

    async loadDefaultNgWords() {
        try {
            const res = await fetch(`${CONFIG.NG_WORDS_URL}?${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.defaultNgWords = await res.json();
        } catch (err) {
            console.warn("⚠ NGワードJSONの読み込み失敗:", err);
        }
    }

    getAllNgWords() {
        return [...new Set([...this.defaultNgWords, ...this.getUserNgWords()])];
    }
}

// =======================
// 4. Nostr Network Client (✅ 修正あり)
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
        this.onMetadataCallback = null; // ✅ 追加: メタデータ更新通知用コールバック
        this.metadataCache = new Map(); // ✅ 追加: pubkey -> メタデータ をキャッシュ
    }

    _setupSocketListeners(ws) {
        // 修正: ws.url ではなく ws._relayUrl (カスタムプロパティ) を使用
        ws.onopen = () => {
            console.log("✅ 接続:", ws._relayUrl);
            this.notifyStatus();
            if (this.subId) this._sendReqToSocket(ws);
        };
        
        ws.onclose = () => { 
            console.log("🔌 切断:", ws._relayUrl); 
            this.notifyStatus(); 
            // 自動再接続
            setTimeout(() => this._reconnect(ws._relayUrl), CONFIG.RECONNECT_DELAY_MS); 
        };
        
        ws.onerror = (err) => { 
            console.error("❌ エラー (即時切断):", ws._relayUrl, err); 
            this.notifyStatus(); 
            ws.close();
        };
        
        ws.onmessage = (ev) => this._handleMessage(ev);
    }

    _reconnect(url) {
        // urlプロパティではなく _relayUrl でフィルタリング
        this.sockets = this.sockets.filter(s => s._relayUrl !== url);
        console.log("🔄 再接続試行:", url);
        
        try {
            const ws = new WebSocket(url);
            ws._relayUrl = url; // 修正: 読み取り専用のws.urlではなくカスタムプロパティに保存
            this._setupSocketListeners(ws);
            this.sockets.push(ws);
        } catch (e) {
            console.error("再接続処理失敗:", url, e);
        }
    }

    connect() {
        this.sockets.forEach(ws => ws.close());
        this.sockets = [];

        const relays = this.storage.getRelays();
        relays.forEach(url => {
            if (!url) return;
            try {
                const ws = new WebSocket(url);
                ws._relayUrl = url; // 修正: カスタムプロパティに保存
                this._setupSocketListeners(ws);
                this.sockets.push(ws);
            } catch (e) {
                console.error("接続開始失敗:", url, e);
            }
        });
        this.notifyStatus();
    }

    notifyStatus() {
        if (this.onStatusCallback) this.onStatusCallback();
    }

    startSubscription() {
        this.subId = `sub-${Math.random().toString(36).slice(2, 8)}`;
        this.seenEventIds.clear();
        this.sockets.forEach(ws => this._sendReqToSocket(ws));
    }

    _sendReqToSocket(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const filter = {
            // ✅ kind 0 (プロフィール) を購読に追加
            kinds: [NOSTR_KINDS.TEXT, NOSTR_KINDS.PROFILE],
            limit: CONFIG.NOSTR_REQ_LIMIT,
            since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
        };
        const req = ["REQ", this.subId, filter];
        ws.send(JSON.stringify(req));
    }

    _handleMessage(ev) {
        try {
            const [type, subId, event] = JSON.parse(ev.data);
            if (type !== "EVENT" || !event) return;

            // ✅ kind 0 の処理: キャッシュに保存して終了
            if (event.kind === NOSTR_KINDS.PROFILE) {
                this._cacheMetadata(event);
                return; 
            }

            // kind 1 (ノート) の処理
            if (this.seenEventIds.has(event.id)) return;
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            if (this.onEventCallback) this.onEventCallback(event);
        } catch (e) {
            console.error("MSG処理エラー", e);
        }
    }


    // ✅ 修正: メタデータパース時のエラーハンドリングを強化
    _cacheMetadata(event) {
        // created_atが古いメタデータは無視する (NIP-01)
        const currentMetadata = this.metadataCache.get(event.pubkey);
        if (currentMetadata && currentMetadata.created_at >= event.created_at) {
            return;
        }

        try {
            // contentが空文字列の場合もJSON.parseでエラーになるため、事前にチェック
            if (!event.content) {
                console.warn(`⚠ kind 0 メタデータ content が空です。pubkey: ${event.pubkey.slice(0, 8)}...`);
                return;
            }
            
            const content = JSON.parse(event.content); 
            
            // contentが存在しない、またはオブジェクトでない場合は処理をスキップ
            if (!content || typeof content !== 'object') {
                console.warn("⚠ 無効なメタデータJSON content:", event);
                return;
            }

            this.metadataCache.set(event.pubkey, {
                ...content,
                created_at: event.created_at,
                pubkey: event.pubkey
            });
            
            // UIに更新を通知
            if (this.onMetadataCallback) this.onMetadataCallback(event.pubkey);

        } catch (e) {
            // ❌ メタデータ (kind 0) のパース失敗時、詳細なエラーログを出力
            console.warn("❌ メタデータ (kind 0) パース失敗:", 
                         `Pubkey: ${event.pubkey.slice(0, 8)}...`, 
                         "Content:", event.content.slice(0, 50) + '...', 
                         "Error:", e);
        }
    }

    // ✅ 追加: アイコンURLを取得する
    getProfilePicture(pubkey) {
        return this.metadataCache.get(pubkey)?.picture || null;
    }
    
    // ✅ 追加: プロフィール名を取得する
    getProfileName(pubkey) {
        return this.metadataCache.get(pubkey)?.name || null;
    }

    // ... (publish, sendReaction, _broadcast, getRelayStatus は変更なし)
    async publish(content) {
        if (this.validator.isContentInvalid(content)) throw new Error(UI_STRINGS.INVALID_CONTENT);
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.TEXT,
            content: content,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        return signed;
    }

    async sendReaction(targetEvent) {
        if (this.reactedEventIds.has(targetEvent.id)) return;
        if (!window.nostr) throw new Error(UI_STRINGS.NIP07_REQUIRED);

        const pubkey = await window.nostr.getPublicKey();
        const event = {
            kind: NOSTR_KINDS.REACTION,
            content: "+",
            created_at: Math.floor(Date.now() / 1000),
            tags: [["e", targetEvent.id], ["p", targetEvent.pubkey]],
            pubkey
        };
        const signed = await window.nostr.signEvent(event);
        this._broadcast(signed);
        this.reactedEventIds.add(targetEvent.id);
    }

    _broadcast(event) {
        const payload = JSON.stringify(["EVENT", event]);
        let sentCount = 0;
        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
                sentCount++;
            }
        });
        if (sentCount === 0) throw new Error(UI_STRINGS.NO_RELAY);
    }

    getRelayStatus(url) {
        const normalized = url.replace(/\/+$/, "");
        // 修正: _relayUrlを使用して検索
        const ws = this.sockets.find(s => s._relayUrl.replace(/\/+$/, "") === normalized);
        return ws && ws.readyState === WebSocket.OPEN;
    }
}

// =======================
// 5. Settings UI Handler (変更なし)
// =======================
class SettingsUIHandler {
    constructor(dom, storage, client, uiRef) {
        this.dom = dom;
        this.storage = storage;
        this.client = client;
        this.uiRef = uiRef;
    }

    setupListeners() {
        this.dom.buttons.addRelay?.addEventListener("click", () => this._addRelay());
        this.dom.buttons.saveRelays?.addEventListener("click", () => this._saveRelays());
        this.dom.buttons.addNg?.addEventListener("click", () => this._addNgWord());
        this.dom.buttons.saveNg?.addEventListener("click", () => this._saveNgWords());
    }

    // リレーリスト用（変更なし）
    _updateList(options) {
        const { container, getItemList, saveItemList, getStatus = null, updateCallback } = options;
        if (!container) return;
        container.innerHTML = "";
        const currentItems = getItemList.call(this.storage);

        currentItems.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            const statusHtml = `<span class="relay-status">${getStatus.call(this.client, item) ? "🟢" : "🔴"}</span>`;
            
            row.innerHTML = `
                ${statusHtml}
                <input type="text" value="${this.uiRef._escape(item)}" data-idx="${idx}">
                <button class="btn-delete-relay">✖</button>
            `;

            row.querySelector(".btn-delete-relay")?.addEventListener("click", () => {
                currentItems.splice(idx, 1);
                saveItemList.call(this.storage, currentItems);
                updateCallback.call(this);
            });
            
            row.querySelector("input")?.addEventListener("input", (e) => {
                currentItems[idx] = e.target.value.trim();
                saveItemList.call(this.storage, currentItems);
            });
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

    // NGワードリスト専用の描画ロジック（変更なし）
    updateNgList() {
        const container = this.dom.lists.ngWords;
        if (!container) return;
        container.innerHTML = "";

        // 1. デフォルトNGワード（読み取り専用・グレーアウト）
        const defaultWords = this.storage.defaultNgWords || [];
        defaultWords.forEach(word => {
            const row = document.createElement("div");
            row.className = "ng-word-item ng-default";
            row.innerHTML = `
                <input type="text" value="${this.uiRef._escape(word)}" disabled style="background:#eee; color:#666;">
                <button disabled style="opacity:0.3; cursor:not-allowed;">✖</button>
            `;
            container.appendChild(row);
        });

        // 2. ユーザーNGワード（編集・削除可能）
        const userWords = this.storage.getUserNgWords();
        userWords.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.uiRef._escape(word)}">
                <button class="btn-delete-ng">✖</button>
            `;

            // 削除
            row.querySelector(".btn-delete-ng")?.addEventListener("click", () => {
                userWords.splice(idx, 1);
                this.storage.saveUserNgWords(userWords);
                this.updateNgList(); // 再描画
            });

            // 編集（即時保存）
            row.querySelector("input")?.addEventListener("input", (e) => {
                userWords[idx] = e.target.value.trim();
                this.storage.saveUserNgWords(userWords);
            });

            container.appendChild(row);
        });
    }
    
    _addRelay() {
        const url = this.dom.inputs.relay?.value?.trim();
        if (!url) return;
        try {
            const u = new URL(url);
            if(u.protocol !== 'wss:') throw new Error(); 
        } catch {
            return alert(UI_STRINGS.INVALID_WSS);
        }
        const relays = this.storage.getRelays();
        if (!relays.includes(url)) {
            relays.push(url);
            this.storage.saveRelays(relays);
            this.dom.inputs.relay.value = "";
            this.updateRelayList();
        }
    }

    _saveRelays() {
        alert(UI_STRINGS.SAVE_RELAY_SUCCESS);
        this.uiRef._toggleModal(this.dom.modals.relay, false);
        this.client.connect();
        this.client.startSubscription();
    }
    
    _addNgWord() {
        const w = this.dom.inputs.ng?.value?.trim();
        if (!w) return;
        const words = this.storage.getUserNgWords();
        if (!words.includes(w)) {
            words.push(w);
            this.storage.saveUserNgWords(words);
            this.dom.inputs.ng.value = "";
            this.updateNgList();
        }
    }

    _saveNgWords() {
        alert(UI_STRINGS.SAVE_NG_SUCCESS);
    }
}

// =======================
// 6. UI Manager (✅ 修正あり)
// =======================
class UIManager {
    constructor(nostrClient, storage) {
        this.client = nostrClient;
        this.storage = storage;
        this.dom = {};
        this.eventBuffer = [];
        this.bufferTimer = null;
        this.settingsHandler = null; 
    }

    init() {
        // DOM要素取得: 大本のHTML IDに合わせて調整
        this.dom = {
            timeline: document.getElementById("timeline"),
            spinner: document.getElementById("subscribeSpinner"), // HTMLに無い場合は無視されます
            // モダール関連 (大本のHTMLに基づく)
            modals: {
                relay: document.getElementById("relayModal"),
                ng: document.getElementById("ngModal"),
            },
            buttons: {
                // 大本のID: btnPublish, btnRelayModal, btnNgModal など
                publish: document.getElementById("btnPublish"),
                openRelay: document.getElementById("btnRelayModal"),
                closeRelay: document.getElementById("btnCloseModal"),
                openNg: document.getElementById("btnNgModal"),
                closeNg: document.getElementById("btnCloseNgModal"),
                
                addRelay: document.getElementById("btnAddRelay"),
                saveRelays: document.getElementById("btnSaveRelays"),
                addNg: document.getElementById("btnAddNgWord"),
                saveNg: document.getElementById("btnSaveNgWords"),
                scrollLeft: document.getElementById("scrollLeft"),
                scrollRight: document.getElementById("scrollRight"),
            },
            inputs: {
                // 大本のID: compose, relayInput, ngWordInput
                compose: document.getElementById("compose"), 
                relay: document.getElementById("relayInput"),
                ng: document.getElementById("ngWordInput"),
            },
            lists: {
                relays: document.getElementById("relayList"),
                ngWords: document.getElementById("ngWordList"),
            },
            counters: {
                char: document.getElementById("charCount"),
            }
        };

        this.settingsHandler = new SettingsUIHandler(this.dom, this.storage, this.client, this);
        this._setupListeners();
        this.settingsHandler.updateNgList();
        this.settingsHandler.updateRelayList();
    }

    _setupListeners() {
        // モダール開閉 (大本のロジックを再現)
        this.dom.buttons.openRelay?.addEventListener("click", () => {
            this._toggleModal(this.dom.modals.relay, true);
            this.settingsHandler.updateRelayList();
        });
        this.dom.buttons.closeRelay?.addEventListener("click", () => this._toggleModal(this.dom.modals.relay, false));

        this.dom.buttons.openNg?.addEventListener("click", () => {
             this._toggleModal(this.dom.modals.ng, true);
             this.settingsHandler.updateNgList();
        });
        this.dom.buttons.closeNg?.addEventListener("click", () => this._toggleModal(this.dom.modals.ng, false));

        // 投稿
        this.dom.buttons.publish?.addEventListener("click", () => this._handlePublish());

        // 設定関連のリスナー委譲
        this.settingsHandler.setupListeners();

        // スクロール
        this.dom.buttons.scrollLeft?.addEventListener("click", () => this.dom.timeline.scrollBy({ left: -300, behavior: "smooth" }));
        this.dom.buttons.scrollRight?.addEventListener("click", () => this.dom.timeline.scrollBy({ left: 300, behavior: "smooth" }));

        // 文字数カウント
        this.dom.inputs.compose?.addEventListener("input", (e) => {
            const len = e.target.value.length;
            if(this.dom.counters.char) {
                this.dom.counters.char.textContent = `${len} / ${CONFIG.MAX_POST_LENGTH}`;
                this.dom.counters.char.style.color = len > CONFIG.MAX_POST_LENGTH ? "red" : "";
            }
        });
        
        // モダール背景クリックで閉じる
        [this.dom.modals.relay, this.dom.modals.ng].forEach(modal => {
            modal?.addEventListener("click", e => {
                if (e.target === modal) this._toggleModal(modal, false);
            });
        });
    }

    _toggleModal(modalEl, open) {
        if (!modalEl) return;
        modalEl.style.display = open ? "block" : "none";
        modalEl.setAttribute("aria-hidden", String(!open));
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
            if (this.dom.counters.char) this.dom.counters.char.textContent = `0 / ${CONFIG.MAX_POST_LENGTH}`;
        } catch (err) {
            alert(err.message);
        }
    }

    _updateRelayListFromClient() {
        this.settingsHandler.updateRelayList();
    }
    
    // ✅ 追加: メタデータ更新時に、既存のノートのアイコンと名前を更新する
    updateProfilePicture(pubkey) {
        const pictureUrl = this.client.getProfilePicture(pubkey);
        const profileName = this.client.getProfileName(pubkey);
        const displayName = profileName || (pubkey || "").slice(0, 8);

        // pubkeyに対応する全てのノート要素を検索
        const notesToUpdate = this.dom.timeline.querySelectorAll(`.note[data-pubkey="${pubkey}"]`);
        
        notesToUpdate.forEach(noteEl => {
            const img = noteEl.querySelector('.profile-icon');
            if (img) {
                // 画像が見つからなかった場合に 'default_icon.png' にフォールバック
                img.src = this._escape(pictureUrl || 'default_icon.png');
            }
            
            const nameEl = noteEl.querySelector('.author-name');
            if (nameEl) {
                // 名前の更新
                nameEl.textContent = `${this._escape(displayName)}...`;
            }
        });
    }

    // --- Rendering ---
    bufferEvent(event) {
        this.eventBuffer.push(event);
        if (!this.bufferTimer) {
            this.bufferTimer = setTimeout(() => this._flushBuffer(), CONFIG.EVENT_BUFFER_FLUSH_TIME_MS);
        }
    }

    _flushBuffer() {
        const container = this.dom.timeline;
        if (!container) return;
        
        // スクロール判定
        const IS_SCROLLED_RIGHT_TOLERANCE = 10;
        const isScrolledRight = container.scrollLeft >= (container.scrollWidth - container.clientWidth) - IS_SCROLLED_RIGHT_TOLERANCE;
        const wasScrolledRight = isScrolledRight;
        const prevScrollWidth = container.scrollWidth;

        this.eventBuffer
            .sort((a, b) => a.created_at - b.created_at) // 古い順にソート
            .forEach(e => this.renderEvent(e));
        
        this.eventBuffer = [];
        this.bufferTimer = null;
        if(this.dom.spinner) this.dom.spinner.style.display = "none";
        
        // スクロール位置制御 (右端に追加していくので、右端を見ていた場合は追従)
        const newScrollWidth = container.scrollWidth;
        if (wasScrolledRight) {
            container.scrollLeft = newScrollWidth - container.clientWidth;
        } else {
            const addedWidth = newScrollWidth - prevScrollWidth;
            container.scrollLeft += addedWidth;
        }
    }

 // =======================
// 6. UI Manager (✅ 修正箇所抜粋)
// =======================
class UIManager {
    // ...
    
    // ✅ 修正: メタデータ更新時に、既存のノートのアイコンと名前を更新する
    updateProfilePicture(pubkey) {
        const pictureUrl = this.client.getProfilePicture(pubkey);
        const profileName = this.client.getProfileName(pubkey);
        const displayName = profileName || (pubkey || "").slice(0, 8);

        // pubkeyに対応する全てのノート要素を検索
        const notesToUpdate = this.dom.timeline.querySelectorAll(`.note[data-pubkey="${pubkey}"]`);
        
        notesToUpdate.forEach(noteEl => {
            const img = noteEl.querySelector('.profile-icon');
            if (img) {
                // 🚀 ここを修正: 'default_icon.png' を Data URI に変更する
                img.src = this._escape(pictureUrl || DEFAULT_ICON_DATA_URI);
            }
            
            const nameEl = noteEl.querySelector('.author-name');
            if (nameEl) {
                // 名前の更新
                nameEl.textContent = `${this._escape(displayName)}...`;
            }
        });


    // ✅ 修正: アイコンURLと名前の表示ロジックを Data URI フォールバックに変更
    renderEvent(event) {
        if (!this.dom.timeline) return;

        const noteEl = document.createElement("div");
        noteEl.className = "note";
        noteEl.dataset.createdAt = event.created_at.toString();
        noteEl.dataset.id = event.id;
        noteEl.dataset.pubkey = event.pubkey;

        const isReacted = this.client.reactedEventIds.has(event.id);
        
        // アイコンと名前を取得
        const pictureUrl = this.client.getProfilePicture(event.pubkey);
        const profileName = this.client.getProfileName(event.pubkey);
        const displayName = profileName || (event.pubkey || "").slice(0, 8);
        
        // 🚀 修正点: pictureUrlがない場合、Data URIを使用する
        const iconSrc = this._escape(pictureUrl || DEFAULT_ICON_DATA_URI);

        noteEl.innerHTML = `
            <div class="note-header">
                <img 
                    src="${iconSrc}" 
                    class="profile-icon" 
                    alt="Icon" 
                    // ✅ 修正: 外部のpictureUrlが不正だった場合に、Data URIにフォールバックさせる
                    onerror="this.src='${DEFAULT_ICON_DATA_URI}';" 
                    loading="lazy"
                >
                <span class="author-name">${this._escape(displayName)}...</span>
            </div>
            <div class="content">${this._formatContent(event.content)}</div>
            <div class="meta">
                <span class="time">${new Date(event.created_at * 1000).toLocaleString()}</span>
                <span class="pubkey-short">(${this._escape((event.pubkey || "").slice(0, 4))}...)</span>
            </div>
            <button class="btn-reaction" ${isReacted ? "disabled" : ""}>${isReacted ? "❤️" : "♡"}</button>
        `;

        noteEl.querySelector(".btn-reaction")?.addEventListener("click", async (e) => {
            const target = e.target;
            try {
                await this.client.sendReaction(event);
                target.textContent = "❤️";
                target.disabled = true;
            } catch (err) {
                alert(err.message);
            }
        });

        this.dom.timeline.appendChild(noteEl);
    }


    _escape(str) {
        if (typeof str !== "string") return "";
        return str.replace(/[&<>"']/g, s => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[s]));
    }

    _formatContent(text) {
        let safe = this._escape(text);
        const special = "【緊急地震速報】";
        if (safe.includes(special)) {
            safe = safe.replace(special, `<span style="color:#e63946">${special}</span>`);
        }
        return safe;
    }
}

// =======================
// 7. Main Execution (✅ 修正あり)
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

    client.onEventCallback = (e) => ui.bufferEvent(e);
    client.onStatusCallback = () => ui._updateRelayListFromClient();
    client.onMetadataCallback = (pubkey) => ui.updateProfilePicture(pubkey); // ✅ 追加: メタデータ更新時の処理

    client.connect();
    client.startSubscription();
    
    // 初期ロード時は右端(最新)へスクロール
    setTimeout(() => {
        const timeline = ui.dom.timeline;
        if (timeline) {
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
        }
    }, 500);
});
