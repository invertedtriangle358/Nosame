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
    PROFILE: 0,
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
// 3. Storage Manager (DRY原則に基づき簡素化)
// =======================
class StorageManager {
    constructor() {
        this.defaultNgWords = [];
    }

    // ヘルパー: localStorageから取得/保存
    _getStorageItem(key, defaultValue) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error(`Storage read error for key ${key}:`, e);
            return defaultValue;
        }
    }

    _setStorageItem(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error(`Storage write error for key ${key}:`, e);
        }
    }
    
    getRelays() {
        return this._getStorageItem("relays", [...CONFIG.DEFAULT_RELAYS]);
    }

    saveRelays(relays) {
        this._setStorageItem("relays", relays);
    }

    getUserNgWords() {
        return this._getStorageItem("userNgWords", []);
    }

    saveUserNgWords(words) {
        this._setStorageItem("userNgWords", words);
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


// ------------------------------------
// 4a. Relay Socket Handler
// ------------------------------------
class RelaySocket {
  constructor(url, { onOpen, onClose, onError, onMessage }) {
    if (!url) throw new Error("URL is required.");
    this.url = url;

    // コールバック登録（外部依存を注入する）
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onError = onError;
    this.onMessage = onMessage;

    this.ws = null;

    this.connect();
  }

  connect() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(this.url);
      this._setupListeners();
    } catch (err) {
      this.onError?.(err, this);
    }
  }

  _setupListeners() {
    this.ws.onopen = () => {
      this.onOpen?.(this);
    };

    this.ws.onclose = () => {
      this.onClose?.(this);
      setTimeout(() => this.connect(), CONFIG.RECONNECT_DELAY_MS);
    };

    this.ws.onerror = (err) => {
      this.onError?.(err, this);
      this.ws.close();
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.onMessage?.(msg, this);
      } catch (_) {}
    };
  }

  send(obj) {
    if (this.isOpen()) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.ws?.close();
  }
}


// =======================
// 4. Nostr Network Client (RelaySocketにソケット管理を委譲)
// =======================
class NostrClient {
    constructor(storage, validator) {
        this.storage = storage;
        this.validator = validator;
        this.relaySockets = []; // RelaySocketインスタンスの配列に変更
        this.subId = null;
        this.seenEventIds = new Set();
        this.reactedEventIds = new Set();
        this.onEventCallback = null;
        this.onStatusCallback = null;
        this.onMetadataCallback = null;
        this.metadataCache = new Map();
    }

    connect() {
        // 既存ソケットを閉じる
        this.relaySockets.forEach(rs => rs.close());
        this.relaySockets = [];

        const relays = this.storage.getRelays();
        relays.forEach(url => {
            if (!url) return;
            try {
                // RelaySocketインスタンスを作成し、接続を開始
                const rs = new RelaySocket(url, {
                    onOpen: () => {
                        console.log("✅ 接続:", url);
                        this.notifyStatus();
                        // 接続後に購読リクエストを送信
                        if (this.subId) this._sendReqToSocket(rs);
                    },
                    onClose: () => {
                        console.log("🔌 切断:", url);
                        this.notifyStatus();
                    },
                    onError: (err) => {
                        console.error("❌ エラー:", url, err);
                        this.notifyStatus();
                    },
                    onMessage: (msg) => this._handleMessage(msg, rs)
                });
                this.relaySockets.push(rs);
            } catch (e) {
                console.error("接続開始失敗:", url, e);
                this.notifyStatus();
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
        // RelaySocketのインスタンスを使ってREQを送信
        this.relaySockets.forEach(rs => this._sendReqToSocket(rs)); 
    }

    _sendReqToSocket(rs) {
        if (!rs.isOpen()) return;
        const filter = {
            kinds: [NOSTR_KINDS.TEXT, NOSTR_KINDS.PROFILE],
            limit: CONFIG.NOSTR_REQ_LIMIT,
            since: Math.floor(Date.now() / 1000) - CONFIG.NOSTR_REQ_SINCE_SECONDS_AGO
        };
        const req = ["REQ", this.subId, filter];
        rs.send(req);
    }

    _handleMessage([type, subId, event]) {
        try {
            if (type !== "EVENT" || !event) return;

            if (event.kind === NOSTR_KINDS.PROFILE) {
                this._cacheMetadata(event);
                return; 
            }

            if (this.seenEventIds.has(event.id)) return;
            if (this.validator.isContentInvalid(event.content)) return;

            this.seenEventIds.add(event.id);
            if (this.onEventCallback) this.onEventCallback(event);
        } catch (e) {
            console.error("MSG処理エラー", e);
        }
    }

    _cacheMetadata(event) {
        const currentMetadata = this.metadataCache.get(event.pubkey);
        if (currentMetadata && currentMetadata.created_at >= event.created_at) {
            return;
        }

        try {
            if (!event.content) {
                console.warn(`⚠ kind 0 メタデータ content が空です。pubkey: ${event.pubkey.slice(0, 8)}...`);
                return;
            }
            
            const content = JSON.parse(event.content); 
            
            if (!content || typeof content !== 'object') {
                console.warn("⚠ 無効なメタデータJSON content:", event);
                return;
            }

            // ⭐ 修正箇所: pictureが空文字列などの場合は強制的に null にする
            const picture = content.picture || null; 

            this.metadataCache.set(event.pubkey, {
                ...content,
                picture: picture, // null または有効なURL
                created_at: event.created_at,
                pubkey: event.pubkey
            });
            
            if (this.onMetadataCallback) this.onMetadataCallback(event.pubkey);

        } catch (e) {
            console.warn("❌ メタデータ (kind 0) パース失敗:", 
                         `Pubkey: ${event.pubkey.slice(0, 8)}...`, 
                         "Content:", event.content.slice(0, 50) + '...', 
                         "Error:", e);
        }
    }

    getProfilePicture(pubkey) {
        // null または有効な URL が返る
        return this.metadataCache.get(pubkey)?.picture || null;
    }
    
    getProfileName(pubkey) {
        return this.metadataCache.get(pubkey)?.name || null;
    }

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
        const payload = ["EVENT", event];
        let sentCount = 0;
        this.relaySockets.forEach(rs => {
            if (rs.send(payload)) {
                sentCount++;
            }
        });
        if (sentCount === 0) throw new Error(UI_STRINGS.NO_RELAY);
    }

    getRelayStatus(url) {
        const normalized = url.replace(/\/+$/, "");
        const rs = this.relaySockets.find(s => s.url.replace(/\/+$/, "") === normalized);
        return rs ? rs.isOpen() : false;
    }
}


// =======================
// 5. Settings UI Handler
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

    _updateList(options) {
        const { container, getItemList, saveItemList, getStatus = null, updateCallback } = options;
        if (!container) return;
        container.innerHTML = "";
        const currentItems = getItemList.call(this.storage);

        currentItems.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "relay-row";
            const statusHtml = getStatus ? `<span class="relay-status">${getStatus.call(this.client, item) ? "🟢" : "🔴"}</span>` : '';
            
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

    updateNgList() {
        const container = this.dom.lists.ngWords;
        if (!container) return;
        container.innerHTML = "";

        // 1. デフォルトNGワード
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

        // 2. ユーザーNGワード
        const userWords = this.storage.getUserNgWords();
        userWords.forEach((word, idx) => {
            const row = document.createElement("div");
            row.className = "ng-word-item";
            row.innerHTML = `
                <input type="text" value="${this.uiRef._escape(word)}">
                <button class="btn-delete-ng">✖</button>
            `;

            row.querySelector(".btn-delete-ng")?.addEventListener("click", () => {
                userWords.splice(idx, 1);
                this.storage.saveUserNgWords(userWords);
                this.updateNgList();
            });

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
// 6. UI Manager (修正版)
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
    // ... (init, _setupListeners, _toggleModal, _handlePublish, _updateRelayListFromClient は省略)
    
    // ⭐ 修正箇所: メタデータ更新時に、既存のノートのアイコンと名前を更新する
    updateProfilePicture(pubkey) {
        const pictureUrl = this.client.getProfilePicture(pubkey);
        const profileName = this.client.getProfileName(pubkey);
        const displayName = profileName || (pubkey || "").slice(0, 8);

        const notesToUpdate = this.dom.timeline.querySelectorAll(`.note[data-pubkey="${pubkey}"]`);
        
        notesToUpdate.forEach(noteEl => {
            // ⭐ 修正: .profile-icon-placeholder を探す
            const iconEl = noteEl.querySelector('.profile-icon-placeholder');
            if (iconEl) {
                if (pictureUrl) {
                    // 外部URLがある場合、背景画像を上書き
                    iconEl.style.backgroundImage = `url('${this._escape(pictureUrl)}')`;
                } else {
                    // URLがない場合、CSSで設定されたデフォルトに戻す
                    iconEl.style.backgroundImage = ''; 
                }
            }
            
            const nameEl = noteEl.querySelector('.author-name');
            if (nameEl) {
                // 名前の更新
                nameEl.textContent = `${this._escape(displayName)}...`;
            }
        });
    }

    // ... (_flushBuffer は省略)

    // ⭐ 修正箇所: HTMLテンプレートを <span> ベースに変更
    renderEvent(event) {
        if (!this.dom.timeline) return;

        const noteEl = document.createElement("div");
        noteEl.className = "note";
        noteEl.dataset.createdAt = event.created_at.toString();
        noteEl.dataset.id = event.id;
        noteEl.dataset.pubkey = event.pubkey;

        const isReacted = this.client.reactedEventIds.has(event.id);
        
        const pictureUrl = this.client.getProfilePicture(event.pubkey);
        const profileName = this.client.getProfileName(event.pubkey);
        const displayName = profileName || (event.pubkey || "").slice(0, 8);
        
        // pictureUrlがある場合のみインラインスタイルを定義
        const inlineStyle = pictureUrl ? 
            `style="background-image: url('${this._escape(pictureUrl)}');"` : 
            '';

        noteEl.innerHTML = `
            <div class="note-header">
                <span 
                    class="profile-icon-placeholder" 
                    alt="Icon" 
                    ${inlineStyle} 
                ></span>
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
// 7. Main Execution
// =======================
window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();
    
    // 初回実行時、デフォルトNGワードをローカルストレージにコピー
    if (!localStorage.getItem("userNgWords")) {
        storage.saveUserNgWords(storage.defaultNgWords);
    }

    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const ui = new UIManager(client, storage);

    ui.init(); 

    client.onEventCallback = (e) => ui.bufferEvent(e);
    client.onStatusCallback = () => ui._updateRelayListFromClient();
    client.onMetadataCallback = (pubkey) => ui.updateProfilePicture(pubkey);

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
