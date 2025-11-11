/* ============================================================
   設定・初期化
============================================================ */
const state = {
  relays: [],
  userNgWords: [],
  defaultNgWords: [],
  socket: null,
  subId: null,
  connected: false,
};

/* ============================================================
   NGワード読み込み（JSON）
============================================================ */
async function loadNgWords() {
  try {
    const res = await fetch("./ngwords.json");
    if (!res.ok) throw new Error("NGワードリストの取得に失敗");
    const data = await res.json();
    state.defaultNgWords = Array.isArray(data) ? data : [];
  } catch (e) {
    console.error(e);
    state.defaultNgWords = [];
  }

  const saved = JSON.parse(localStorage.getItem("userNgWords")) || [];
  state.userNgWords = [...new Set([...state.defaultNgWords, ...saved])];
  updateNgWordList();
}

/* ============================================================
   共通DOM取得
============================================================ */
const dom = {
  btnRelayModal: document.getElementById("btnRelayModal"),
  btnNgModal: document.getElementById("btnNgModal"),
  btnConnectModal: document.getElementById("btnConnectModal"),
  btnCloseModal: document.getElementById("btnCloseModal"),
  btnCloseNgModal: document.getElementById("btnCloseNgModal"),
  relayModal: document.getElementById("relayModal"),
  ngModal: document.getElementById("ngModal"),
  btnAddRelay: document.getElementById("btnAddRelay"),
  btnAddNgWord: document.getElementById("btnAddNgWord"),
  relayInput: document.getElementById("relayInput"),
  ngWordInput: document.getElementById("ngWordInput"),
  relayList: document.getElementById("relayList"),
  ngWordList: document.getElementById("ngWordList"),
};

/* ============================================================
   モダール共通開閉処理
============================================================ */
function openModal(modal, updater) {
  modal.style.display = "block";
  if (updater) updater();
}
function closeModal(modal) {
  modal.style.display = "none";
}
[{ btn: dom.btnRelayModal, modal: dom.relayModal, updater: updateRelayList },
 { btn: dom.btnNgModal, modal: dom.ngModal, updater: updateNgWordList }]
.forEach(({ btn, modal, updater }) => {
  btn?.addEventListener("click", () => openModal(modal, updater));
});
[{ btn: dom.btnCloseModal, modal: dom.relayModal },
 { btn: dom.btnCloseNgModal, modal: dom.ngModal }]
.forEach(({ btn, modal }) => {
  btn?.addEventListener("click", () => closeModal(modal));
});
window.addEventListener("click", (e) => {
  [dom.relayModal, dom.ngModal].forEach((modal) => {
    if (e.target === modal) closeModal(modal);
  });
});

/* ============================================================
   NGワード管理
============================================================ */
function updateNgWordList() {
  const list = dom.ngWordList;
  list.innerHTML = "";
  state.userNgWords.forEach((word, index) => {
    const div = document.createElement("div");
    div.className = "ng-word-item";

    const input = document.createElement("input");
    input.type = "text";
    input.value = word;

    const btnDel = document.createElement("button");
    btnDel.textContent = "削除";

    btnDel.addEventListener("click", () => {
      state.userNgWords.splice(index, 1);
      saveNgWords();
      updateNgWordList();
    });

    input.addEventListener("change", () => {
      const newWord = input.value.trim();
      if (!validateNgWord(newWord, index)) {
        input.value = word;
        return;
      }
      state.userNgWords[index] = newWord;
      saveNgWords();
    });

    div.appendChild(input);
    div.appendChild(btnDel);
    list.appendChild(div);
  });
}

function validateNgWord(word, currentIndex = -1) {
  if (!word) {
    alert("空白のNGワードは追加できません。");
    return false;
  }
  if (/\s/.test(word)) {
    alert("NGワードに空白は含められません。");
    return false;
  }
  const lower = word.toLowerCase();
  if (
    state.userNgWords.some((w, i) => i !== currentIndex && w.toLowerCase() === lower)
  ) {
    alert("同じNGワードがすでに存在します。");
    return false;
  }
  if (word.length > 30) {
    alert("NGワードは30文字以内にしてください。");
    return false;
  }
  return true;
}

dom.btnAddNgWord.addEventListener("click", () => {
  const word = dom.ngWordInput.value.trim();
  if (!validateNgWord(word)) return;
  state.userNgWords.push(word);
  saveNgWords();
  updateNgWordList();
  dom.ngWordInput.value = "";
});

function saveNgWords() {
  const userWords = state.userNgWords.filter(
    (w) => !state.defaultNgWords.includes(w)
  );
  localStorage.setItem("userNgWords", JSON.stringify(userWords));
}

/* ============================================================
   リレー管理
============================================================ */
dom.btnAddRelay.addEventListener("click", () => {
  const url = dom.relayInput.value.trim();
  if (!validateRelayUrl(url)) return;
  if (!state.relays.includes(url)) {
    state.relays.push(url);
    updateRelayList();
  }
  dom.relayInput.value = "";
});

function updateRelayList() {
  const list = dom.relayList;
  list.innerHTML = "";
  state.relays.forEach((url, index) => {
    const div = document.createElement("div");
    div.className = "relay-item";

    const span = document.createElement("span");
    span.style.background = "green";

    const input = document.createElement("input");
    input.type = "text";
    input.value = url;

    const btnDel = document.createElement("button");
    btnDel.textContent = "削除";
    btnDel.addEventListener("click", () => {
      state.relays.splice(index, 1);
      updateRelayList();
    });

    input.addEventListener("change", () => {
      const newUrl = input.value.trim();
      if (!validateRelayUrl(newUrl)) {
        input.value = url;
        return;
      }
      if (state.relays.includes(newUrl)) {
        alert("同じリレーURLがすでに存在します。");
        input.value = url;
        return;
      }
      state.relays[index] = newUrl;
    });

    div.appendChild(span);
    div.appendChild(input);
    div.appendChild(btnDel);
    list.appendChild(div);
  });
}

function validateRelayUrl(url) {
  if (!url) {
    alert("URLを入力してください。");
    return false;
  }
  try {
    const u = new URL(url);
    if (!["ws:", "wss:"].includes(u.protocol)) {
      alert("リレーURLは ws:// または wss:// で始まる必要があります。");
      return false;
    }
  } catch {
    alert("有効なURLを入力してください。");
    return false;
  }
  return true;
}

/* ============================================================
   コンテンツ投稿バリデーション
============================================================ */
function isContentInvalid(content) {
  const trimmed = content.trim();
  if (!trimmed) return "投稿内容が空です。";
  const matched = state.userNgWords.find((w) =>
    trimmed.toLowerCase().includes(w.toLowerCase())
  );
  if (matched) return `NGワード「${matched}」が含まれています。`;
  return null;
}

/* ============================================================
   投稿イベント
============================================================ */
document.getElementById("btnPublish").addEventListener("click", () => {
  const text = document.getElementById("composer").value;
  const err = isContentInvalid(text);
  if (err) {
    alert(err);
    return;
  }
  handlePublishClick(text); // 既存関数を呼び出し
});

/* ============================================================
   リレー接続
============================================================ */
dom.btnConnectModal.addEventListener("click", () => {
  if (state.relays.length === 0) {
    alert("リレーURLを追加してください。");
    return;
  }
  connectToRelays(state.relays); // 既存関数を呼び出し
  closeModal(dom.relayModal);
});

/* ============================================================
   起動時
============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  loadNgWords();
  updateRelayList();
});
