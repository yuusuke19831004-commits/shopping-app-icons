/**
 * 家族 買い物リスト（GitHub Pages版フロントエンド / フェーズB）
 *
 * Apps Script側（Code.gs）に追加したJSON API（フェーズA）に fetch() で接続する。
 * google.script.run は使用しない（GitHub Pagesのような外部オリジンからは使えないため）。
 *
 * UI・状態管理のロジックは、既存のApps Script版 Index.html と同一にしてある。
 * 変更したのは「サーバーとの通信方法」だけ。
 */

// ここにApps ScriptのWebアプリURL（.../exec）を設定する
var API_BASE_URL = 'https://script.google.com/macros/s/AKfycbxCxp6jADyEQkEO8OJwA-i80PKwLSapbhgEVWwtYZ3UvhzM0YLvmjwVT1WKBalBQpERjw/exec';

/**
 * 読み取り系API呼び出し（GET）。
 * 戻り値はPromiseで、成功時は data フィールドの中身（配列やオブジェクト）を返す。
 */
function apiGet(action) {
  var url = API_BASE_URL + '?action=' + encodeURIComponent(action);
  return fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (json) {
      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || 'APIエラー(' + action + ')');
      }
      return json.data;
    });
}

/**
 * 書き込み系API呼び出し（POST）。
 * Content-Type は text/plain にする（application/json だとブラウザが
 * CORSプリフライト(OPTIONS)を送り、Apps ScriptはOPTIONSに応答しないため失敗する）。
 * サーバー側では届いた本文をJSON.parse()しているので、内容自体は通常どおりJSON。
 */
function apiPost(action, payload) {
  var url = API_BASE_URL + '?action=' + encodeURIComponent(action);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload || {})
  })
    .then(function (res) { return res.json(); })
    .then(function (json) {
      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || 'APIエラー(' + action + ')');
      }
      return json.data;
    });
}

var CATEGORIES = ['スーパー', 'ドラッグストア', '100均', 'コストコ', 'その他'];
var MEMO_TAB = 'メモ';
var ALL_TABS = CATEGORIES.concat([MEMO_TAB]);
var CATEGORY_ICONS = {
  'スーパー': '🛒',
  'ドラッグストア': '💊',
  '100均': '🏷️',
  'コストコ': '📦',
  'その他': '🗂️',
  'メモ': '📝'
};
// サーバー側 AISLE_CATEGORIES と同じ並び（① スーパーの売り場順）
var AISLE_CATEGORIES = [
  '野菜', '果物', '精肉', '鮮魚', '乳製品・卵',
  '常温食品', '飲料・お菓子', '日用品', '冷凍食品・アイス・氷', 'その他'
];
var STORAGE_KEY = 'shopping_app_user';
// 前回取得した買い物リストのキャッシュ（起動直後の即時表示用）
var ITEMS_CACHE_KEY = 'shopping_app_items_cache';

var state = {
  currentCategory: CATEGORIES[0],
  items: {},
  memos: [],
  memosLoaded: false,
  user: null,
  aisleTargetId: null,
  memoEditId: null,
  itemEditId: null,
  itemEditCategory: null
};

function getUser() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}
function setUser(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch (e) {}
  state.user = name;
}

/**
 * 前回取得した買い物リストをlocalStorageから読み込む。
 * 壊れている・存在しない・形式が不正な場合は、通常のAPI取得に
 * フォールブックできるよう null を返すだけにする（例外を投げない）。
 */
function loadCachedItems() {
  try {
    var raw = localStorage.getItem(ITEMS_CACHE_KEY);
    if (!raw) return null;
    var cache = JSON.parse(raw);
    if (!cache || typeof cache !== 'object' || !cache.items) return null;
    return cache;
  } catch (e) {
    return null;
  }
}

/**
 * 取得済みの買い物リストをlocalStorageへ保存する。
 * savedAt を持たせておくことで、将来的に古すぎるキャッシュを
 * 無視する等の判断ができるようにしておく（現時点では期限切れ判定はしない）。
 */
function saveItemsCache(items) {
  try {
    localStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify({
      items: items,
      savedAt: Date.now()
    }));
  } catch (e) {
    // 保存に失敗しても致命的ではないため無視する（容量超過等）
  }
}

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('hidden', !show);
}

/**
 * サーバーから受け取ったデータを、常に全カテゴリキー・配列を持つ
 * 安全なオブジェクトへ正規化する。
 * data が null/undefined、または一部カテゴリが配列でない場合でも
 * render側でエラーにならないようにするための防御。
 */
function normalizeItems(data) {
  var normalized = {};
  CATEGORIES.forEach(function (cat) {
    var value = data && data[cat];
    normalized[cat] = Array.isArray(value) ? value : [];
  });
  return normalized;
}

function showErrorBanner(err) {
  showLoading(false);
  var banner = document.getElementById('errorBanner');
  var detail = document.getElementById('errorDetail');
  var message = (err && (err.message || (err.toString && err.toString()))) || String(err);
  detail.textContent = message;
  banner.classList.remove('hidden');
}
function hideErrorBanner() {
  document.getElementById('errorBanner').classList.add('hidden');
}
document.getElementById('errorRetryBtn').addEventListener('click', function () {
  hideErrorBanner();
  showLoading(true);
  refreshData(false);
});

function showToast(msg) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function () { toast.classList.remove('show'); }, 1600);
}

function renderTabs() {
  var tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  ALL_TABS.forEach(function (cat) {
    var btn = document.createElement('button');
    btn.className = 'tab' + (cat === state.currentCategory ? ' active' : '');
    btn.textContent = CATEGORY_ICONS[cat] + ' ' + cat;
    btn.addEventListener('click', function () { onSelectTab(cat); });
    tabsEl.appendChild(btn);
  });
  document.getElementById('appTitle').textContent = CATEGORY_ICONS[state.currentCategory] + ' ' + state.currentCategory;
  document.getElementById('shoppingSection').classList.toggle('hidden', state.currentCategory === MEMO_TAB);
  document.getElementById('memoSection').classList.toggle('hidden', state.currentCategory !== MEMO_TAB);
}

function onSelectTab(cat) {
  state.currentCategory = cat;
  renderTabs();
  if (cat === MEMO_TAB) {
    if (!state.memosLoaded) {
      loadMemos();
    } else {
      renderMemoList();
    }
  } else {
    renderList();
  }
}

/**
 * サーバーの登録日時（"yyyy/MM/dd HH:mm:ss" 形式）を、
 * カード表示用の "M/D HH:mm"（年・秒なし）へ変換する。
 * 想定外の形式の場合は空文字を返す（表示を壊さないための防御）。
 */
function formatRegisteredAt(registeredAt) {
  if (!registeredAt) return '';
  var m = String(registeredAt).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return Number(m[2]) + '/' + Number(m[3]) + ' ' + m[4] + ':' + m[5];
}

function formatMeta(item) {
  var by = item.registeredBy || '';
  var at = formatRegisteredAt(item.registeredAt);
  if (by && at) return by + ' ・ ' + at;
  return by || at || '';
}

function renderList() {
  var listEl = document.getElementById('list');
  // state.items が万一 null/undefined でも落ちないように防御する
  var items = (state.items && state.items[state.currentCategory]) || [];
  listEl.innerHTML = '';
  if (items.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '買い物リストは空です。<br>上の「＋」から商品を追加してください。';
    listEl.appendChild(empty);
    return;
  }
  items.forEach(function (item) {
    var card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.id = item.id;

    var checkBtn = document.createElement('button');
    checkBtn.className = 'check-btn';
    checkBtn.textContent = '✓';
    checkBtn.addEventListener('click', function () { onPurchase(item, card); });

    var info = document.createElement('div');
    info.className = 'item-info';
    var name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.name;
    // 商品名タップでも編集モーダルを開けるようにする（鉛筆アイコンと同じ動作）
    name.addEventListener('click', function () { openItemEditModal(item); });
    var meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatMeta(item);
    info.appendChild(name);
    info.appendChild(meta);

    // 売り場カテゴリ（スーパーのみ item.aisle が入っている）。
    // タップで手動修正できるようにする。
    if (item.aisle) {
      var aisleBadge = document.createElement('div');
      aisleBadge.className = 'item-aisle';
      aisleBadge.textContent = item.aisle;
      aisleBadge.addEventListener('click', function () { openAisleModal(item); });
      info.appendChild(aisleBadge);
    }

    var qty = document.createElement('div');
    qty.className = 'item-qty';
    qty.textContent = '×' + item.qty;

    var editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', function () { openItemEditModal(item); });

    var delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () { onDelete(item, card); });

    card.appendChild(checkBtn);
    card.appendChild(info);
    card.appendChild(qty);
    card.appendChild(editBtn);
    card.appendChild(delBtn);
    listEl.appendChild(card);
  });
}

function refreshData(showSpin) {
  if (showSpin) {
    var fab = document.getElementById('refreshBtn');
    fab.classList.add('spinning');
    setTimeout(function () { fab.classList.remove('spinning'); }, 700);
  }
  if (state.currentCategory === MEMO_TAB) {
    loadMemos();
    return;
  }
  apiGet('getAllItems')
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      hideErrorBanner();
      renderList();
    })
    .catch(function (err) {
      console.error(err);
      showErrorBanner(err);
    });
}

function onAdd() {
  if (!state.user) { openUserModal(false); return; }
  var nameInput = document.getElementById('itemNameInput');
  var qtyInput = document.getElementById('itemQtyInput');
  var name = nameInput.value.trim();
  if (!name) return;
  var qty = qtyInput.value ? Number(qtyInput.value) : 1;
  if (!qty || qty <= 0) qty = 1;

  nameInput.value = '';
  qtyInput.value = '';
  nameInput.focus();

  apiPost('addItem', { category: state.currentCategory, name: name, qty: qty, user: state.user })
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showToast(name + ' を追加しました');
    })
    .catch(function (err) {
      showToast('追加に失敗しました');
      console.error(err);
    });
}

function onPurchase(item, card) {
  if (!state.user) { openUserModal(false); return; }
  card.classList.add('purchasing');
  apiPost('purchaseItem', { category: state.currentCategory, id: item.id, user: state.user })
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showToast(item.name + ' を購入済みにしました');
    })
    .catch(function (err) {
      card.classList.remove('purchasing');
      showToast('処理に失敗しました');
      console.error(err);
    });
}

function onDelete(item, card) {
  if (!confirm(item.name + ' を削除しますか？')) return;
  card.style.opacity = '0.3';
  apiPost('deleteItem', { category: state.currentCategory, id: item.id })
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showToast(item.name + ' を削除しました');
    })
    .catch(function (err) {
      card.style.opacity = '1';
      showToast('削除に失敗しました');
      console.error(err);
    });
}

// ---------------- 売り場カテゴリ選択モーダル（スーパーのみ） ----------------
function openAisleModal(item) {
  state.aisleTargetId = item.id;
  var listEl = document.getElementById('aisleOptionList');
  listEl.innerHTML = '';
  AISLE_CATEGORIES.forEach(function (cat) {
    var btn = document.createElement('button');
    btn.className = 'aisle-option' + (cat === item.aisle ? ' selected' : '');
    btn.textContent = cat;
    btn.addEventListener('click', function () { onSelectAisle(cat); });
    listEl.appendChild(btn);
  });
  document.getElementById('aisleModal').classList.remove('hidden');
}
function closeAisleModal() {
  document.getElementById('aisleModal').classList.add('hidden');
  state.aisleTargetId = null;
}
function onSelectAisle(aisle) {
  var id = state.aisleTargetId;
  if (!id) return;
  closeAisleModal();
  apiPost('updateItemAisle', { id: id, aisle: aisle })
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showToast('売り場カテゴリを「' + aisle + '」に変更しました');
    })
    .catch(function (err) {
      showToast('変更に失敗しました');
      console.error(err);
    });
}
document.getElementById('aisleModalClose').addEventListener('click', closeAisleModal);

// ---------------- 商品編集モーダル（商品名・数量のみ） ----------------
// 登録日時・登録者・IDは編集対象外（サーバー側 updateItem() も名前・数量以外は変更しない）。
function openItemEditModal(item) {
  state.itemEditId = item.id;
  state.itemEditCategory = state.currentCategory;
  document.getElementById('itemEditNameInput').value = item.name;
  document.getElementById('itemEditQtyInput').value = item.qty;
  document.getElementById('itemEditModal').classList.remove('hidden');
}
function closeItemEditModal() {
  document.getElementById('itemEditModal').classList.add('hidden');
  state.itemEditId = null;
  state.itemEditCategory = null;
}
function onSaveItemEdit() {
  var id = state.itemEditId;
  var category = state.itemEditCategory;
  if (!id || !category) return;
  var name = document.getElementById('itemEditNameInput').value.trim();
  if (!name) return;
  var qtyInput = document.getElementById('itemEditQtyInput').value;
  var qty = qtyInput ? Number(qtyInput) : 1;
  if (!qty || qty <= 0) qty = 1;
  closeItemEditModal();
  apiPost('updateItem', { category: category, id: id, name: name, qty: qty })
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showToast(name + ' を更新しました');
    })
    .catch(function (err) {
      showToast('更新に失敗しました');
      console.error(err);
    });
}
document.getElementById('itemEditCancelBtn').addEventListener('click', closeItemEditModal);
document.getElementById('itemEditSaveBtn').addEventListener('click', onSaveItemEdit);

// ---------------- メモタブ ----------------
function formatMemoMeta(memo) {
  var by = memo.registeredBy || '';
  var at = memo.registeredAt || '';
  if (by && at) return by + 'さんが登録・' + at;
  return by || at || '';
}

function renderMemoList() {
  var listEl = document.getElementById('memoList');
  var memos = state.memos || [];
  listEl.innerHTML = '';
  if (memos.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = 'メモはまだありません。<br>価格比較や購入判断のメモを追加してください。';
    listEl.appendChild(empty);
    return;
  }
  memos.forEach(function (memo) {
    var card = document.createElement('div');
    card.className = 'memo-card';

    var info = document.createElement('div');
    info.className = 'memo-info';
    info.addEventListener('click', function () { openMemoEditModal(memo); });

    var title = document.createElement('div');
    title.className = 'memo-title';
    title.textContent = memo.title;

    var detail = document.createElement('div');
    detail.className = 'memo-detail-preview';
    detail.textContent = memo.detail || '';

    var meta = document.createElement('div');
    meta.className = 'memo-meta';
    meta.textContent = formatMemoMeta(memo);

    info.appendChild(title);
    info.appendChild(detail);
    info.appendChild(meta);

    var delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      onDeleteMemo(memo);
    });

    card.appendChild(info);
    card.appendChild(delBtn);
    listEl.appendChild(card);
  });
}

function loadMemos() {
  showLoading(true);
  apiGet('getAllMemos')
    .then(function (data) {
      state.memos = Array.isArray(data) ? data : [];
      state.memosLoaded = true;
      showLoading(false);
      hideErrorBanner();
      renderMemoList();
    })
    .catch(function (err) {
      console.error(err);
      showErrorBanner(err);
    });
}

function onAddMemo() {
  if (!state.user) { openUserModal(false); return; }
  var titleInput = document.getElementById('memoTitleInput');
  var detailInput = document.getElementById('memoDetailInput');
  var title = titleInput.value.trim();
  if (!title) return;
  var detail = detailInput.value;

  titleInput.value = '';
  detailInput.value = '';
  titleInput.focus();

  apiPost('addMemo', { title: title, detail: detail, user: state.user })
    .then(function (data) {
      state.memos = Array.isArray(data) ? data : [];
      state.memosLoaded = true;
      renderMemoList();
      showToast(title + ' を追加しました');
    })
    .catch(function (err) {
      showToast('追加に失敗しました');
      console.error(err);
    });
}

function openMemoEditModal(memo) {
  state.memoEditId = memo.id;
  document.getElementById('memoEditTitleInput').value = memo.title;
  document.getElementById('memoEditDetailInput').value = memo.detail || '';
  document.getElementById('memoEditModal').classList.remove('hidden');
}
function closeMemoEditModal() {
  document.getElementById('memoEditModal').classList.add('hidden');
  state.memoEditId = null;
}
function onSaveMemo() {
  var id = state.memoEditId;
  if (!id) return;
  var title = document.getElementById('memoEditTitleInput').value.trim();
  if (!title) return;
  var detail = document.getElementById('memoEditDetailInput').value;
  closeMemoEditModal();
  apiPost('updateMemo', { id: id, title: title, detail: detail })
    .then(function (data) {
      state.memos = Array.isArray(data) ? data : [];
      renderMemoList();
      showToast('メモを更新しました');
    })
    .catch(function (err) {
      showToast('更新に失敗しました');
      console.error(err);
    });
}
function onDeleteMemo(memo) {
  if (!confirm(memo.title + ' を削除しますか？')) return;
  apiPost('deleteMemo', { id: memo.id })
    .then(function (data) {
      state.memos = Array.isArray(data) ? data : [];
      renderMemoList();
      showToast(memo.title + ' を削除しました');
    })
    .catch(function (err) {
      showToast('削除に失敗しました');
      console.error(err);
    });
}

document.getElementById('memoAddBtn').addEventListener('click', onAddMemo);
document.getElementById('memoTitleInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); onAddMemo(); }
});
document.getElementById('memoEditCancelBtn').addEventListener('click', closeMemoEditModal);
document.getElementById('memoEditSaveBtn').addEventListener('click', onSaveMemo);

// ---------------- ユーザー選択モーダル ----------------
function openUserModal(isSettings) {
  var modal = document.getElementById('userModal');
  var title = document.getElementById('userModalTitle');
  var closeBtn = document.getElementById('userModalClose');
  title.textContent = isSettings ? '利用者を変更' : 'この端末を使う人は？';
  closeBtn.classList.toggle('hidden', !isSettings);
  updateUserOptionStyles();
  modal.classList.remove('hidden');
}
function closeUserModal() {
  document.getElementById('userModal').classList.add('hidden');
}
function updateUserOptionStyles() {
  var opts = document.querySelectorAll('.user-option');
  opts.forEach(function (opt) {
    opt.classList.toggle('selected', opt.dataset.user === state.user);
  });
}

document.querySelectorAll('.user-option').forEach(function (opt) {
  opt.addEventListener('click', function () {
    setUser(opt.dataset.user);
    updateUserOptionStyles();
    closeUserModal();
    showToast('利用者を「' + opt.dataset.user + '」に設定しました');
  });
});
document.getElementById('userModalClose').addEventListener('click', closeUserModal);
document.getElementById('settingsBtn').addEventListener('click', function () { openUserModal(true); });
document.getElementById('addBtn').addEventListener('click', onAdd);
document.getElementById('itemNameInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
});
document.getElementById('refreshBtn').addEventListener('click', function () { refreshData(true); });

// ---------------- 初期化 ----------------
/**
 * 起動時のバックグラウンド更新。
 * キャッシュを先に表示済みの状態で呼ばれる想定なので、
 * ローディングオーバーレイは出さない（体感の「待たされ感」を出さないため）。
 * 取得結果が前回表示分と同じ場合は再描画しない（不要なチラつき防止）。
 * 失敗時も、キャッシュ表示はそのまま維持し、エラーバナーではなく
 * 控えめなトースト表示だけにする。
 */
function refreshItemsInBackground(hadCache) {
  apiGet('getAllItems')
    .then(function (data) {
      var normalized = normalizeItems(data);
      var changed = JSON.stringify(normalized) !== JSON.stringify(state.items);
      state.items = normalized;
      saveItemsCache(state.items);
      hideErrorBanner();
      if (changed) renderList();
    })
    .catch(function (err) {
      console.error(err);
      if (hadCache) {
        // キャッシュ表示は維持したまま、通信失敗だけ小さく知らせる
        showToast('最新データの取得に失敗しました（前回の内容を表示中）');
      } else {
        showErrorBanner(err);
      }
    });
}

function init() {
  renderTabs();
  state.user = getUser();

  var cached = loadCachedItems();
  if (cached) {
    // キャッシュがあれば即座に前回の一覧を表示し、
    // ローディング表示なしで裏から最新データを取得する
    state.items = normalizeItems(cached.items);
    renderList();
    if (!state.user) openUserModal(false);
    refreshItemsInBackground(true);
    return;
  }

  // キャッシュが無い（壊れている場合も含む）初回起動時は、
  // これまでどおりAPI取得完了後に表示する
  showLoading(true);
  apiGet('getAllItems')
    .then(function (data) {
      state.items = normalizeItems(data);
      saveItemsCache(state.items);
      renderList();
      showLoading(false);
      hideErrorBanner();
      if (!state.user) openUserModal(false);
    })
    .catch(function (err) {
      console.error(err);
      showErrorBanner(err);
    });
}
init();
