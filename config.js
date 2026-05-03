// =======================
// Constants & Config
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
    METADATA: 0,
    TEXT: 1,
    REACTION: 7,
};

const UI_STRINGS = {
    EMPTY_POST: "本文を入力してください。",
    INVALID_CONTENT: "禁句を含むか、文字数制限を超えています。",
    BLOCKED_PUBKEY: "この公開鍵は遮断されています。",
    NIP07_REQUIRED: "NIP-07対応のNostr拡張機能が必要です。",
    NO_RELAY: "接続中のリレーがありません。",
    INVALID_WSS: "有効な wss:// URL を入力してください。",
    INVALID_PUBKEY: "有効な hex 公開鍵 または npub を入力してください。",
    SAVE_RELAY_SUCCESS: "接続設定を保存しました。",
    SAVE_NG_SUCCESS: "禁句を保存しました。",
    SAVE_BLOCKED_SUCCESS: "遮断公開鍵を保存しました。",
    DUPLICATE_RELAY: "そのリレーはすでに登録されています。",
    DUPLICATE_NG: "その禁句はすでに登録されています。",
    DUPLICATE_BLOCKED_PUBKEY: "その公開鍵はすでに遮断されています。",
    COPY_NPUB_SUCCESS: "npub をコピーしました。",
    COPY_NPUB_FAILED: "npub をコピーできませんでした。",
};
