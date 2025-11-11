// =======================
// 1. 定数・初期設定
// =======================
const MAX_POST_LENGTH = 108;
const DEFAULT_RELAYS = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay.barine.co",
];

let defaultNgWords = [];

// 外部JSONからNGワードを読み込み
fetch("./ngwords.json")
  .then(res => res.json())
  .then(json => {
    defaultNgWords = Array.isArray(json) ? json : [];
    updateNgWordList();
  })
  .catch(err => console.error("NGワードJSONの読み込み失敗:", err));

// =======================
// 2. 状態管理
// =======================
const state = {
  sockets: [],
  subId: null,
  seenEventIds: new Set(),
  reactedEventIds: new Set(),
  relayList: JSON.parse(localStorage.getItem("relays")) || [...DEFAULT_RELAYS],
  userNgWords: JSON.parse(localStorage.getItem("userNgWords")) || [],
};

// =======================
// 3. DOMキャッシュ
// =======================
const dom = {
  timeline: document.getElementById("timeline"),
  spinner: document.getElementById("subscribeSpinner"),
  relayListEl: document.getElementById("relayList"),
  relayModal: document.getElementById("relayModal"),
  composeArea: document.getElementById("compose"),
  charCount: document.getElementById("charCount"),
  btnPublish: document.getElementById("btnPublish"),
  btnRelayModal: document.getElementById("btnRelayModal"),
  btnCloseModal: document.getElementById("btnCloseModal"),
  btnAddRelay: document.getElementById("btnAddRelay"),
  btnSaveRelays: document.getElementById("btnSaveRelays"),
  btnScrollLeft: document.getElementById("scrollLeft"),
  btnScrollRight: document.getElementById("scrollRight"),
  relayInput: document.getElementById("relayInput"),
  btnNgModal: document.getElementById("btnNgModal"),
  ngModal: document.getElementById("ngModal"),
  btnAddNgWord: document.getElementById("btnAddNgWord"),
  btnSaveNgWords: document.getElementById("btnSaveNgWords"),
  btnCloseNgModal: document.getElementById("btnCloseNgModal"),
  ngWordInput: document.getElementById("ngWordInput"),
  ngWordListEl: document.getElementById("ngWordList"),
};

// =======================
// 4. ユーティリティ
// =======================
const escapeHtml = str =>
  typeof str === "string"
    ? str.replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]))
    : "";

const normalizeUrl = url => url.replace(/\/+$/, "");

const getAllNgWords = () => [...new Set([...defaultNgWords, ...state.userNgWords])];

const isContentInvalid = text => {
  if (!text) return false;
  if (text.length > MAX_POST_LENGTH) return true;
  const lower = text.toLowerCase();
  return getAllNgWords().some(ng => lower.includes(ng.toLowerCase()));
};

const isValidRelayUrl = url => {
  try {
    const u = new URL(url);
    return (u.protocol === "wss:" || u.protocol === "ws:") && !!u.hostname;
  } catch {
    return false;
  }
};

// =======================
// 5. モダール・UI
// =======================
function toggleModal(modalEl, open = true) {
  if (!modalEl) return;
  modalEl.style.display = open ? "block" : "none";
  modalEl.setAttribute("aria-hidden", String(!open));
  document.body.style.overflow = open ? "hidden" : "";
}

function updateNgWordList() {
  const list = dom.ngWordListEl;
  if (!list) return;
  list.innerHTML = "";

  const all = [...state.userNgWords];
  all.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "ng-word-item";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(word)}">
      <button class="btn-delete-ng" data-index="${i}">✖</button>
    `;
    row.querySelector("input").addEventListener("input", e => {
      state.userNgWords[i] = e.target.value.trim();
    });
    list.appendChild(row);
  });
}

function addNgWord(word) {
  const trimmed = word.trim().toLowerCase();
  if (!trimmed) return alert("空のNGワードは登録できません。");
  if (state.userNgWords.includes(trimmed)) return alert("すでに登録済みです。");
  state.userNgWords.push(trimmed);
  updateNgWordList();
  dom.ngWordInput.value = "";
}

function addRelayUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return alert("URLを入力してください。");
  if (!isValidRelayUrl(trimmed)) return alert("無効なリレーURLです。");
  if (state.relayList.some(u => u.toLowerCase() === trimmed.toLowerCase()))
    return alert("すでに登録済みのURLです。");

  state.relayList.push(trimmed);
  updateRelayModalList();
  dom.relayInput.value = "";
}

// ===========================
// 6. WebSocketロジック (略)
// ===========================
// connectToRelays(), handleMessage(), renderEvent() などは現行のまま使用可能。

// ============================
// 7. イベントリスナー
// ============================
function setupEventListeners() {
  dom.btnPublish?.addEventListener("click", handlePublishClick);

  // モダール共通
  [
    { btn: dom.btnRelayModal, modal: dom.relayModal, updater: updateRelayModalList },
    { btn: dom.btnNgModal, modal: dom.ngModal, updater: updateNgWordList },
  ].forEach(({ btn, modal, updater }) => {
    btn?.addEventListener("click", () => {
      toggleModal(modal, true);
      updater();
    });
  });

  dom.btnCloseModal?.addEventListener("click", () => toggleModal(dom.relayModal, false));
  dom.btnCloseNgModal?.addEventListener("click", () => toggleModal(dom.ngModal, false));

  // ESC / 背景クリックで閉じる
  window.addEventListener("keydown", e => e.key === "Escape" && [dom.relayModal, dom.ngModal].forEach(m => toggleModal(m, false)));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => e.target === m && toggleModal(m, false)));

  // NGワード追加・削除・保存
  dom.btnAddNgWord?.addEventListener("click", () => addNgWord(dom.ngWordInput.value));
  dom.ngWordListEl?.addEventListener("click", e => {
    if (e.target.classList.contains("btn-delete-ng")) {
      state.userNgWords.splice(Number(e.target.dataset.index), 1);
      updateNgWordList();
    }
  });
  dom.btnSaveNgWords?.addEventListener("click", () => {
    localStorage.setItem("userNgWords", JSON.stringify(state.userNgWords.filter(Boolean)));
    alert("NGワードを保存しました。");
  });

  // リレー追加・削除・保存
  dom.btnAddRelay?.addEventListener("click", () => addRelayUrl(dom.relayInput.value));
  dom.relayListEl?.addEventListener("click", e => {
    if (e.target.classList.contains("btn-delete-relay")) {
      state.relayList.splice(Number(e.target.dataset.index), 1);
      updateRelayModalList();
    }
  });
  dom.btnSaveRelays?.addEventListener("click", () => {
    localStorage.setItem("relays", JSON.stringify(state.relayList.filter(Boolean)));
    alert("リレー設定を保存しました。");
    toggleModal(dom.relayModal, false);
    connectToRelays();
    startSubscription();
  });
}

// ============================
// 8. 初期化
// ============================
function main() {
  setupEventListeners();
  connectToRelays();
  setTimeout(startSubscription, 500);
}

window.addEventListener("DOMContentLoaded", main);
