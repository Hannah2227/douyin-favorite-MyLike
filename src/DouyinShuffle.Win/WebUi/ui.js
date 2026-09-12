// 抖·收藏 主界面逻辑 + 与 C# 宿主桥接(纯异步 postMessage,无同步 host object)。
// 桥接:window.chrome.webview.postMessage({cmd,args,id}) → C# UI 线程异步处理 → __dsh_respond(id, result)。
let __msgId = 0;
const __pending = new Map();

function call(cmd, ...args) {
  if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
    return new Promise((resolve) => {
      const id = 'm' + (++__msgId) + '_' + Date.now();
      __pending.set(id, resolve);
      try {
        // 拍平参数:避免 call('shuffle', ids) 把数组嵌套成 [[...]] 导致 C# 端 string[] 反序列化失败
        window.chrome.webview.postMessage({ cmd, args: args.flat(), id });
      } catch (e) {
        __pending.delete(id);
        resolve('err:post:' + e.message);
      }
    });
  }
  return Promise.resolve(null);
}
window.__dsh_respond = function (id, result) {
  const r = __pending.get(id);
  if (r) { __pending.delete(id); r(result); }
};

// ---------- 状态 ----------
let items = [];            // 全部条目(已排序)
let filtered = [];
let selected = new Set();
let yearFilter = '', monthFilter = '', searchText = '';
let navFilter = 'all';     // all | video | gallery
let loggedIn = false;
let curTheme = 'light';    // 当前主题(宿主 settings.json 为准,localStorage 仅首帧回显)
let collecting = false;
let selectMode = false;    // 选择模式:点卡片=勾选,不播放
let renderedCount = 0;     // 分批渲染游标
const PAGE_SIZE = 60;

// ---------- 工具 ----------
let toastTimer = null;
function toast(msg, err) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = err ? '#7f1d1d' : '#1f2329';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 通用确认弹窗(原生 confirm 无法带勾选框)。opts:{title, okText, checkboxText, skipKey}
// - 提供 checkboxText 时显示"勾选框";用户勾选确定后把 localStorage[skipKey]='1'(以后不再询问)。
// - 返回 Promise<boolean>;Esc/遮罩/×/取消 → false。
let cfResolve = null;
function confirmModal(text, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    if (cfResolve) { const old = cfResolve; cfResolve = null; old(false); }   // 并发只留最新
    const mask = document.getElementById('confirm-modal');
    const body = document.getElementById('cf-body');
    const skipWrap = document.getElementById('cf-skip-wrap');
    const skipBox = document.getElementById('cf-skip');
    const finish = v => {
      mask.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      mask.removeEventListener('click', onMask);
      cfResolve = null;
      resolve(v);
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    const onMask = e => { if (e.target === mask) finish(false); };
    cfResolve = finish;
    setText('cf-title', opts.title || '请确认');
    body.textContent = text || '';
    skipBox.checked = false;
    if (opts.checkboxText) {
      setText('cf-skip-text', opts.checkboxText);
      skipWrap.style.display = 'flex';
    } else {
      skipWrap.style.display = 'none';
    }
    setText('cf-ok', opts.okText || '确定');
    document.getElementById('cf-ok').onclick = () => {
      if (skipBox.checked && opts.skipKey) { try { localStorage.setItem(opts.skipKey, '1'); } catch (e) {} }
      finish(true);
    };
    document.getElementById('cf-cancel').onclick = () => finish(false);
    document.getElementById('cf-close').onclick = () => finish(false);
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', onMask);
    mask.classList.remove('hidden');
  });
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 登录态 ----------
// v1.0.7:登录/退出统一收进左下角账号入口(未登录点击=登录;已登录=账号面板),顶栏不再有登录按钮
function applyLoginState() {
  loadAccountEntry();   // 入口显示随登录态刷新(头像/昵称/占位)
}
window.__dsh_state = function (st) {
  loggedIn = !!st.loggedIn;
  applyLoginState();
  setText('stat-total', st.count || items.length);
  // 数据占用(MB):"失效"卡已替换为"占用 (MB)"卡(v1.0.7,失效数卡片信息量低)
  if (typeof st.dataMb === 'number') setText('stat-disk', st.dataMb);
  if (typeof st.autoNext === 'boolean' && window.__dsh_autoNext) window.__dsh_autoNext(st.autoNext);
  // 主题:宿主为准(settings.json,应用级)。localStorage 只是首帧快速回显,
  // 换账号会换 WebView2 profile → localStorage 是另一份,必须靠这里校正回来。
  if (st.theme === 'dark' || st.theme === 'light') window.__dsh_setTheme(st.theme);
};

// 自动连播开关回显(宿主广播;元素惰性获取,任意时机可调)
window.__dsh_autoNext = function (on) {
  const cb = document.getElementById('auto-next');
  const lb = document.getElementById('auto-next-label');
  if (!cb || !lb) return;
  cb.checked = !!on;
  lb.classList.toggle('on', !!on);
};

// ---------- 采集进度 ----------
// 已采数量实时刷新(采集栏大数字 + 仪表盘)
window.__dsh_count = function (count) {
  setText('stat-total', count);
  setText('nav-all-count', count);
};
window.__dsh_collectStatus = function (msg) {
  collecting = true;
  document.getElementById('collect-bar').classList.remove('hidden');
  document.getElementById('btn-collect').disabled = true;
  setText('collect-text', msg || '采集中…');
};
window.__dsh_collectDone = function (count, finished) {
  collecting = false;
  document.getElementById('collect-bar').classList.add('hidden');
  document.getElementById('btn-collect').disabled = false;
  toast(finished ? `采集完成,共 ${count} 条` : `采集已停止,当前 ${count} 条`);
  // 不自动刷新列表:用户点左侧「刷新列表」手动刷新(避免采集频繁结束触发全量重绘卡顿)
};
// 验证窗口打开期间锁定采集按钮(防暴力:此时点采集只会刺激接口);关闭后解锁
window.__dsh_verifyLock = function (locked) {
  document.getElementById('btn-collect').disabled = !!locked;
  if (locked) {
    toast('接口被限,请在验证窗口完成滑块;期间采集已暂停', true);
  } else {
    // 验证窗关闭(通过或取消):进度条收起,采集状态复位;列表由用户手动刷新
    collecting = false;
    document.getElementById('collect-bar').classList.add('hidden');
  }
};
function updateCollectBar() {
  const bar = document.getElementById('collect-bar');
  if (collecting) bar.classList.remove('hidden'); else bar.classList.add('hidden');
}

// ---------- 仪表盘 ----------
function renderStats() {
  const total = items.length;
  const videos = items.filter(i => i.status === 0).length;
  const gallery = items.filter(i => i.status === 2).length;
  const invalid = items.filter(i => i.status === 1).length;
  const years = new Set(items.filter(i => i.createTime > 0).map(i => new Date(i.createTime * 1000).getFullYear()));
  setText('stat-total', total);
  setText('stat-videos', videos);
  setText('stat-gallery', gallery);
  // stat-invalid 已被"占用 (MB)"卡替换(占用由 __dsh_state 的 dataMb 驱动;采集期间也随刷新更新)
  setText('stat-years', years.size);
  setText('nav-all-count', total);
  setText('nav-gallery-count', gallery);
  setText('nav-video-count', videos);
  // 数量为 0:提醒用户采集(副文案高亮 + 按钮呼吸效果)
  const sub = document.getElementById('dash-sub');
  const btnCollect = document.getElementById('btn-collect');
  if (sub) {
    sub.textContent = total === 0 ? '还没有数据,点右侧「❤ 采集」抓取你的喜欢列表。' : '可洗牌播放或点击卡片播放。';
    sub.classList.toggle('remind', total === 0);
  }
  if (btnCollect) btnCollect.classList.toggle('pulse', total === 0);
  const yearSel = document.getElementById('year-filter');
  const cur = yearSel.value;
  yearSel.innerHTML = '<option value="">全部年份</option>' + [...years].sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join('');
  if ([...years].includes(parseInt(cur))) yearSel.value = cur;
  renderMonthOptions();
}
function renderMonthOptions() {
  const year = parseInt(document.getElementById('year-filter').value) || 0;
  const ms = document.getElementById('month-filter');
  const cur = ms.value;
  const months = year
    ? [...new Set(items.filter(i => i.createTime > 0 && new Date(i.createTime * 1000).getFullYear() === year).map(i => new Date(i.createTime * 1000).getMonth() + 1))].sort((a, b) => a - b)   // 数值排序(默认 sort 按字符串,10/11/12 会排到 2 前面)
    : Array.from({ length: 12 }, (_, i) => i + 1);
  ms.innerHTML = '<option value="">全部月份</option>' + months.map(m => `<option value="${m}">${m}月</option>`).join('');
  if (months.includes(parseInt(cur))) ms.value = cur;
}

// ---------- 筛选 ----------
function applyFilter() {
  filtered = items.filter(i => {
    if (navFilter === 'video' && i.status !== 0) return false;
    if (navFilter === 'gallery' && i.status !== 2) return false;
    if (yearFilter && new Date(i.createTime * 1000).getFullYear() !== parseInt(yearFilter)) return false;
    if (monthFilter && new Date(i.createTime * 1000).getMonth() + 1 !== parseInt(monthFilter)) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      const hay = `${i.desc || ''} ${i.author || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderedCount = 0;
  renderGrid();
}

// ---------- 网格(分批渲染 + 点击即播) ----------
function renderGrid() {
  const grid = document.getElementById('list-grid');
  setText('list-info', `共 ${filtered.length} 条`);
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty">${items.length === 0
      ? '还没有数据。<br>点右上角「登录」登录抖音,再点「已采集」栏的「采集」抓取你的喜欢列表。'
      : '没有符合筛选条件的条目。'}</div>`;
    document.getElementById('load-more').classList.add('hidden');
    return;
  }
  // 先渲染第一批
  grid.innerHTML = '';
  renderedCount = 0;
  renderMore();
}

function renderMore() {
  const grid = document.getElementById('list-grid');
  const empty = grid.querySelector('.empty');
  if (empty) empty.remove();
  const end = Math.min(filtered.length, renderedCount + PAGE_SIZE);
  const frag = [];
  for (let k = renderedCount; k < end; k++) {
    const it = filtered[k];
    const sel = selected.has(it.awemeId);
    const dc = 'card-desc ' + (it.status === 1 ? 'invalid' : it.status === 2 ? 'gallery' : '');
    const badge = it.status === 2 ? '图集' : it.status === 1 ? '失效' : '视频';
    frag.push(`<div class="card-item ${sel ? 'selected' : ''} ${selectMode ? 'selecting' : ''}" data-id="${it.awemeId}" title="${escapeHtml(it.desc)}">
      <div class="card-cover">
        <img src="${it.coverUrl || ''}" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">
        <span class="badge ${it.status === 1 ? 'dead' : ''}">${badge}</span>
        <span class="play-overlay">${selectMode ? '' : '&#9654;'}</span>
        <div class="check"></div>
      </div>
      <div class="card-meta">
        <div class="${dc}">${escapeHtml(it.desc) || '(无文案)'}</div>
        <div class="card-author">${escapeHtml(it.author)} · ${fmtDate(it.createTime)}</div>
      </div>
    </div>`);
  }
  grid.insertAdjacentHTML('beforeend', frag.join(''));
  renderedCount = end;
  const more = document.getElementById('load-more');
  if (renderedCount < filtered.length) more.classList.remove('hidden');
  else more.classList.add('hidden');
}

// 事件委托(一次性绑定,分批渲染也不丢)
function bindGrid() {
  const grid = document.getElementById('list-grid');
  grid.addEventListener('click', e => {
    const card = e.target.closest('.card-item');
    if (!card) return;
    const id = card.dataset.id;
    if (selectMode) { toggleSelect(id); return; }
    // 失效内容:点击直接拦截提示,不发播放请求(避免黑屏播放页)
    const it = items.find(i => i.awemeId === id);
    if (it && it.status === 1) { toast('该内容已失效(已删除或私密),无法播放', true); return; }
    playVideo(id);   // 点击卡片即播
  });
}
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  const card = document.querySelector(`.card-item[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', selected.has(id));
    const check = card.querySelector('.check');
    if (check) check.title = selected.has(id) ? '取消选择' : '选择';
  }
  updateSelectUi();
}
function playVideo(id) {
  toast('正在获取播放地址…');
  // 附带当前筛选后的队列 id(与 shuffle 同理):宿主按它建顺序播放队列,
  // 避免图集/视频分类下点卡片,顺序播放混入其他分类
  call('play', id, filtered.map(i => i.awemeId)).then(r => {
    if (r && String(r).indexOf('err') === 0) toast(String(r), true);
  });
}

// ---------- 选择模式(两段式删除:先选择,后删除) ----------
function updateSelectUi() {
  const btnSelect = document.getElementById('btn-select');
  const group = document.getElementById('select-group');
  btnSelect.textContent = selectMode ? '取消' : '选择';
  btnSelect.classList.toggle('active', selectMode);
  group.classList.toggle('hidden', !selectMode);
  const btnDel = document.getElementById('btn-delete');
  if (btnDel) btnDel.textContent = selected.size > 0 ? `删除(${selected.size})` : '删除';
  setText('list-info', `共 ${filtered.length} 条${selectMode ? ` · 已选 ${selected.size}` : ''}`);
}
// ---------- 刷新 ----------
async function refresh() {
  try {
    const r = await call('list');
    items = (typeof r === 'string' ? JSON.parse(r) : (r || []));
    // 数据变化后清掉无效选择(不渲染,由下方 applyFilter 统一渲染一次,避免双重全量渲染卡顿)
    selectMode = false;
    selected.clear();
    updateSelectUi();
    renderStats();
    applyFilter();
  } catch (e) { console.log('[ui] refresh err', e); }
}


// ---------- 批量取消抖音点赞 ----------
// 进度条:宿主 __dsh_unlikeStart/Progress/End 驱动底部 unlike-bar;结束自动恢复按钮并刷新列表
function setUnlikeBar(text) {
  const el = document.getElementById('unlike-text');
  if (el) el.textContent = text;
}
function setUnlikeBtn(busy) {
  const btn = document.getElementById('btn-unlike');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '处理中…' : '取消点赞'; }
}
window.__dsh_unlikeStart = function (total) {
  const bar = document.getElementById('unlike-bar');
  if (bar) bar.classList.remove('hidden');
  setUnlikeBtn(true);
  // 互斥:运行中禁用采集/洗牌入口(与取消点赞共用抖音引擎页)
  ['btn-collect', 'btn-shuffle'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { if (!b.dataset.origTitle) b.dataset.origTitle = b.title || ''; b.disabled = true; b.title = '批量取消点赞运行中,结束后可用'; }
  });
  setUnlikeBar(`准备取消 0/${total}…`);
};
window.__dsh_unlikeProgress = function (done, total, msg) {
  setUnlikeBar(msg || `正在取消 ${done}/${total}`);
};
window.__dsh_unlikeEnd = async function (text) {
  setUnlikeBar(text);
  toast(text);
  setUnlikeBtn(false);
  ['btn-collect', 'btn-shuffle'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.disabled = false; if (b.dataset.origTitle) { b.title = b.dataset.origTitle; delete b.dataset.origTitle; } }
  });
  setTimeout(() => {
    const bar = document.getElementById('unlike-bar');
    if (bar) bar.classList.add('hidden');
  }, 8000);
  await refresh();   // 重拉列表并退出选择模式
};
on('btn-unlike-stop', 'click', () => { call('unlikeStop'); toast('正在停止…'); });

// ---------- 事件 ----------
function on(id, evt, fn) { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); }

on('btn-collect', 'click', async () => {
  if (!loggedIn) { toast('请先点右上角「登录」', true); return; }
  // 防暴力:采集中/停止收尾期(3s 内点过停止)不再发起新采集
  if (collecting) { toast('正在采集中,请看顶部进度条;频繁点击易触发限流', true); return; }
  if (Date.now() - stopAt < 3000) { toast('正在停止收尾,请等进度条消失后再点采集', true); return; }
  const r = await call('collect');
  if (r === 'busy') { toast('正在采集中,请耐心等待;频繁点击易触发限流', true); return; }
  if (r === 'started') window.__dsh_collectStatus('正在检查接口状态…可能需要几十秒');
  else if (r && String(r).indexOf('err') === 0) toast(String(r), true);
});
let stopAt = 0;
on('btn-stop-collect', 'click', async () => {
  if (!collecting) return;
  stopAt = Date.now();
  await call('stopCollect');
  toast('已停止采集,数据已保存;稍后点「采集」可从断点继续');
});
on('btn-shuffle', 'click', async () => {
  if (filtered.length === 0) { toast('当前筛选下没有可播放的内容', true); return; }
  if (!loggedIn) { toast('请先点左下角「账号」登录', true); return; }
  // 按当前筛选条件(年份/月份/分类/搜索)洗牌
  const ids = filtered.map(i => i.awemeId);
  const r = await call('shuffle', ids);
  if (r === 'empty') toast('没有可播放的内容', true);
  else if (r && String(r).indexOf('err') === 0) toast(String(r), true);
});
// 退出登录入口移入账号面板(账号面板内按 profile 触发)
on('btn-select', 'click', () => {
  selectMode = !selectMode;
  if (selectMode) toast('点击卡片勾选内容,再点「删除」或「取消点赞」');
  else selected.clear();
  updateSelectUi();
  renderGrid();
});
on('btn-select-all', 'click', () => { filtered.forEach(i => selected.add(i.awemeId)); updateSelectUi(); renderGrid(); });
on('btn-unselect', 'click', () => { selected.clear(); updateSelectUi(); renderGrid(); });

on('btn-unlike', 'click', async () => {
  if (!selectMode) {
    toast('请先点「选择」再勾选要取消点赞的内容', true);
    return;
  }
  if (selected.size === 0) {
    toast('请先勾选要取消点赞的条目', true);
    return;
  }

  const count = selected.size;
  const skipWarn = (() => { try { return localStorage.getItem('dshSkipUnlikeWarn') === '1'; } catch (e) { return false; } })();
  // 大数量风险确认:>50 且未勾选"不再询问" → 弹确认弹窗(带勾选框);已勾选则直接执行不再打扰。
  // 小批量(<=50)保持轻量 confirm(无勾选框,始终确认,防误触)。
  if (count > 50 && !skipWarn) {
    const go = await confirmModal(
      `确定在抖音中取消选中的 ${count} 个作品的点赞吗?\n` +
      `程序会逐个处理,速度较慢属正常,可随时点进度条旁「停止」。\n` +
      `只有成功取消点赞的条目才会从本地列表移除。\n\n` +
      `⚠ 已选 ${count} 条,数量较大:抖音对批量取消有限流/风控风险,触发后会暂停并弹验证。建议先小批量试或分批操作。`,
      {
        title: '批量取消点赞(大数量)',
        checkboxText: '我已了解风险,此后不再询问此警告',
        skipKey: 'dshSkipUnlikeWarn',
        okText: '继续取消'
      });
    if (!go) return;
  } else if (count <= 50 && !confirm(
    `确定在抖音中取消选中的 ${count} 个作品的点赞吗?\n` +
    `程序会逐个处理,速度较慢属正常,可随时点进度条旁「停止」。\n` +
    `只有成功取消点赞的条目才会从本地列表移除。`
  )) return;

  const ids = [...selected];
  setUnlikeBtn(true);
  const r = await call('unlike', ids);
  if (r === 'started') { /* 进度条由宿主 __dsh_unlikeStart 接管 */ }
  else if (r === 'busy') { toast('已有取消点赞任务正在执行', true); setUnlikeBtn(false); }
  else if (r && String(r).indexOf('err') === 0) { toast(String(r), true); setUnlikeBtn(false); }
  else { toast('启动失败:' + r, true); setUnlikeBtn(false); }
});

on('btn-delete', 'click', async () => {
  if (!selectMode) { toast('请先点「选择」再勾选要删除的内容', true); return; }
  if (selected.size === 0) { toast('请先勾选要删除的条目', true); return; }
  if (!confirm(`确定删除选中的 ${selected.size} 条吗?\n此操作不可恢复。`)) return;
  const ids = [...selected];
  const r = await call('delete', ids);
  if (r && String(r).indexOf('err') === 0) { toast(String(r), true); return; }
  toast(`已删除 ${ids.length} 条`);
  await refresh();   // refresh 内含退出选择模式(单次渲染)
});
on('btn-export', 'click', async () => { const r = await call('export'); toast(r || '已导出'); });
on('btn-import', 'click', async () => { const r = await call('import'); toast(r || '导入完成'); });
on('btn-stop', 'click', async () => { await call('stop'); setPlaying(''); });
on('year-filter', 'change', e => { yearFilter = e.target.value; renderMonthOptions(); applyFilter(); });
on('month-filter', 'change', e => { monthFilter = e.target.value; applyFilter(); });
// 搜索:点击按钮(或回车)后才执行,不随输入实时过滤(几万条实时过滤会卡)。
// ★同步时以"当前输入框内容"为准(issue #3):输入后再清空 + 回车/刷新 → searchText 归零恢复全量,
//   不再残留上次关键词(旧行为只在有词时赋值,清空后变量仍留着旧词,列表永远停在搜索结果)。
function doSearch() {
  const el = document.getElementById('search');
  searchText = (el ? el.value : '').trim();
  applyFilter();
}
// 输入框被清空(退格删空/剪切)→ 立即恢复全量列表,等不到回车
on('search', 'input', e => {
  if (!e.target.value.trim() && searchText) { searchText = ''; applyFilter(); }
});
on('btn-search', 'click', doSearch);
on('search', 'keydown', e => { if (e.key === 'Enter') doSearch(); });
on('nav-all', 'click', () => setNav('all'));
on('nav-gallery', 'click', () => setNav('gallery'));
on('nav-video', 'click', () => setNav('video'));
function setNav(n) {
  navFilter = n;
  ['all', 'gallery', 'video'].forEach(k => {
    const el = document.getElementById('nav-' + k);
    if (el) el.classList.toggle('active', k === n);
  });
  applyFilter();
}
on('load-more', 'click', renderMore);

// ---------- 自绘标题栏:窗口控制(最小化/最大化/关闭) ----------
on('win-min', 'click', () => call('winMin'));
on('win-max', 'click', () => call('winMax'));
on('win-close', 'click', () => call('winClose'));
window.__dsh_winState = function (maximized) {
  const b = document.getElementById('win-max');
  if (b) b.textContent = maximized ? '\u29C9' : '\u25A1';  // 还原(双框)/最大化
};
// 双击顶栏空白处 = 最大化/还原
document.querySelector('.topbar').addEventListener('dblclick', e => {
  if (e.target.closest('button, input, select')) return;
  call('winMax');
});
// 拖动窗口兜底:CSS app-region 不生效时,按住顶栏/侧栏空白处拖动(经宿主 Win32 发起)
function startWindowDrag(e) {
  if (e.button !== 0) return;                                    // 只响应左键
  // ★排除可交互元素与账号入口(否则 mousedown 先启动 Win32 模态拖动循环,click 永远不会触发
  //   —— 这就是"点账号没反应"的根因:account-entry 在 .sidenav 里被拖动兜底劫持)
  if (e.target.closest('button, input, select, .side-item, .win-controls, .account-entry, .help-btn')) return;
  call('winDrag');
}
['.topbar', '.sidenav'].forEach(sel => {
  const el = document.querySelector(sel);
  if (el) el.addEventListener('mousedown', startWindowDrag);
});

// 滚动到底自动追加渲染
document.querySelector('.content').addEventListener('scroll', function () {
  if (renderedCount >= filtered.length) return;
  if (this.scrollTop + this.clientHeight >= this.scrollHeight - 300) renderMore();
});

// ---------- 播放状态(宿主回调) ----------
function setPlaying(text) {
  const bar = document.getElementById('playing-bar');
  if (text) { document.getElementById('playing-text').textContent = text; bar.classList.remove('hidden'); }
  else bar.classList.add('hidden');
}
// ★播放结束/关掉播放页(宿主 Closed → text 为空)时,立刻回读一次快照刷新"继续上次播放"提示条。
// 宿主落盘顺序是 Stopped → SnapshotRequested(写 resume.json)→ Closed(推这里),所以此刻读到的
// 就是刚退出的那条进度;此前只在页面加载时查一次,用户必须刷新主界面才看得到。
function setPlayingAndSyncResume(text) {
  setPlaying(text);
  if (!text) checkResume();
}
window.__dsh_onPlaying = setPlayingAndSyncResume;
window.__dsh_refresh = refresh;
window.__dsh_toast = toast;

// ---------- 帮助弹窗(使用教程 / 常见问题) ----------
const HELP_TUTORIAL = `
<h4>一、三步上手</h4>
<ol>
  <li><b>登录</b>:点左下角<b>账号区</b>(写着「未登录」的那一栏)→ 在弹出的账号面板里点当前这条 → 弹出抖音登录页(支持扫码 / 手机号),登录成功后窗口自动关闭。</li>
  <li><b>采集</b>:点仪表盘右侧的红色「<b>&#10084; 采集</b>」按钮,抓取你抖音账号的「喜欢」列表;顶部进度条实时显示进度,采完自动停止。</li>
  <li><b>播放</b>:点任意卡片从这条开始顺序播放;或点「<b>洗牌播放</b>」随机播放当前筛选下的全部内容。</li>
</ol>

<h4>二、账号(支持多账号)</h4>
<ul>
  <li>左下角账号区随时打开<b>账号面板</b>:切换、新增、改名、退出登录、删除都在里面。</li>
  <li><b>添加账号</b>:点「＋ 添加账号」→ 自动切到新账号并弹出登录页。每个账号有<b>独立的登录态、独立的列表与采集进度</b>,互不干扰。</li>
  <li><b>切换账号</b>:点面板里其他账号那一行,约几秒(屏幕中间转圈),切完列表就换成那个账号的数据。</li>
  <li><b>改名</b>:鼠标移到账号行右侧点「改名」,起个你认得出的名字(比如"小号")。</li>
  <li><b>删除账号</b>:数据与登录态会改名留档(不会立即物理删除),但列表里不再显示。</li>
  <li><b>退出登录</b>(只作用于当前账号):清除本机登录信息,已采集的数据保留;下次用该账号需重新登录。</li>
  <li><b>同一个抖音号只算一个账号</b>:如果在新账号里登录了老的抖音号,两份数据会自动合并(旧的留档),不需要你手工处理。</li>
</ul>

<h4>三、采集</h4>
<ul>
  <li><b>预检</b>:每次点「采集」先检查接口状态,显示「正在检查接口状态…」属正常(几秒到几十秒),通过后自动翻页。</li>
  <li><b>增量</b>:再次采集只补新点赞的内容,已采的自动去重;没有新内容时几秒内结束。</li>
  <li><b>断点续采</b>:中途失败、被限流或手动停止后,再点「采集」会先补头部新内容,再从断点继续采没采完的旧内容,两边都不漏。</li>
  <li><b>超长列表</b>:单轮最多翻 200 页(约 3600 条),到上限自动从断点开下一轮,进度条显示「第 N 轮」,"已采 X 条"一直累加。</li>
  <li><b>限流与验证</b>:采集过快会被抖音限流,此时弹出验证窗口 —— 拖完滑块(或纯限流时等接口自己恢复)就自动关闭并继续采集;这期间请勿反复点「采集」。</li>
  <li><b>数量说明</b>:最终数量通常少于抖音显示的喜欢数,因为已删除 / 下架 / 私密的内容接口不再返回。</li>
</ul>

<h4>四、播放页</h4>
<ul>
  <li><b>先出画面再取链</b>:点播放会立刻打开播放页,再实时获取播放地址(1~2 秒);链接不落盘,所以每次拿到的都是新鲜直链。</li>
  <li><b>控制条</b>:快捷键 · 取消点赞 · 倍速 · 评论 · 上一首 · 播放暂停 · 下一首 · 音量 · 连播 · 全屏 · 播放列表;鼠标不动几秒自动淡出,动一下鼠标就回来。</li>
  <li><b>播放列表</b>:点「播放列表」或按 <kbd>Q</kbd> 展开右侧队列(当前条目红色高亮、自动跟随);点任意条目直接跳播,长列表滚动自动续载。</li>
  <li><b>倍速</b>:点「1x」循环 0.75x → 1x → 1.25x → 1.5x → 2x,切歌后保持。</li>
  <li><b>自动连播</b>:主界面「自动连播」勾选框、播放页「连播」按钮、快捷键 <kbd>A</kbd> 三处同源,选择会记忆。</li>
  <li><b>图集与实况</b>:图集自动轮播,进度条可预览并跳选任意一张,<kbd>←</kbd> <kbd>→</kbd> 手动翻张;带实况(动图)的图集会播放动态画面,播完停一下再继续,和抖音里的节奏一致。</li>
  <li><b>看评论</b>:点「评论」打开抖音原页,关掉后回到刚才的进度继续播。</li>
  <li><b>移动窗口</b>:播放页最顶部一条是拖动区(按住可拖窗口),右上角是最小化;按 <kbd>Esc</kbd> 或点 ✕ 停止播放回到列表。</li>
</ul>

<h4>五、播放快捷键(可自定义)</h4>
<ul>
  <li>控制条「快捷键」里可以<b>改键</b>:点「改键」后直接按新键;也能单个还原或全部恢复默认,设置保存在本机。</li>
  <li><kbd>空格</kbd> 播放 / 暂停 · <kbd>↑</kbd> <kbd>PageUp</kbd> 上一首 · <kbd>↓</kbd> <kbd>PageDown</kbd> 下一首</li>
  <li><kbd>←</kbd> <kbd>→</kbd> 快退 / 快进 10 秒(图集里是上一张 / 下一张)</li>
  <li><kbd>F</kbd> 全屏 · <kbd>M</kbd> 静音 · <kbd>A</kbd> 自动连播 · <kbd>Q</kbd> 播放列表 · <kbd>Esc</kbd> 停止并返回(固定不可改)</li>
  <li>「取消点赞 / 倍速 / 打开原页」默认没有键位,想要就到「快捷键」里自己配。</li>
  <li>播放页空白处<b>滚动滚轮</b> = 上 / 下一首;播放列表展开时,在列表范围内滚动只滚列表、不切歌。</li>
</ul>

<h4>六、主界面</h4>
<ul>
  <li><b>分类</b>:左栏「全部 / 图集 / 视频」,右侧数字是各分类条数。</li>
  <li><b>筛选与搜索</b>:年份、月份下拉与「洗牌播放」联动(筛选后只播筛选结果);搜索按标题 / 作者,<b>按回车或点「搜索」执行</b>(不实时过滤,避免大列表卡顿),<b>清空输入框立即恢复全部</b>。</li>
  <li><b>继续上次播放</b>:上次是手动退出播放页(或播放中直接关掉应用)的话,这里会出现一条提示,点「继续播放」回到那条与那个位置;不想要点 ✕ 忽略。整轮播完不会有这条提示。</li>
  <li><b>占用 (MB)</b>:当前账号数据目录的体积(含导出文件),只是让你心里有数。</li>
</ul>

<h4>七、数据管理</h4>
<ul>
  <li><b>删除</b>:点「选择」→ 勾选 → 「删除」。只删本地记录,抖音上的点赞还在。</li>
  <li><b>取消点赞</b>:勾选后点「取消点赞」,会真的去抖音取消(成功后同步移出本地)。逐条节流、底部进度条随时可「停止」;触发风控会自动暂停,验证后继续;一次超过 50 条会先让你确认一次风险。</li>
  <li><b>导出 / 导入</b>:「导出」生成 .dylist 备份;「导入」是<b>合并式</b>的(按内容去重),所以也能用它把多个账号的内容汇总到一个账号里看。</li>
  <li><b>数据在哪</b>:全部在本机 <b>%LOCALAPPDATA%\DouyinShuffle</b>,每个账号一个子目录。换电脑 / 重装系统前请先「导出」。</li>
</ul>

<h4>八、外观与窗口</h4>
<ul>
  <li>右上角 <b>🌙 / ☀️</b> 一键切换深色 / 浅色;这是应用级设置,<b>切换账号也会保持</b>。</li>
  <li>窗口无边框:按住顶部空白处可拖动窗口,右上角三个按钮是最小化 / 最大化 / 关闭;调整大小用「最大化」或 <kbd>Win</kbd>+<kbd>↑</kbd> / <kbd>Win</kbd>+<kbd>↓</kbd>。</li>
</ul>`;

const HELP_FAQ = `
<p class="faq-q">点「采集」后一直显示「正在检查接口状态…」,要等多久?</p>
<p class="faq-a">这是采集前的接口预检,正常几秒到几十秒,目的是提前发现接口能不能用(而不是开始采集后干等)。通过后自动开始翻页;没通过会明确提示,不会无意义地等。</p>

<p class="faq-q">采集过程中反复点「采集」会更快吗?</p>
<p class="faq-a">不会,反而有害。采集是单线程队列,重复点击只会得到「已有采集在进行」的提示,而频繁请求更容易触发抖音限流。点一次等进度就好。</p>

<p class="faq-q">进度条怎么又从「第 1 页」开始了?</p>
<p class="faq-a">列表超过约 3600 条时,单轮翻页达到 200 页上限,应用会自动开新一轮接着采(不是重采)。「第 N 轮」是当前轮次,总进度看「已采 X 条」,它一直累加。</p>

<p class="faq-q">弹出滑块验证窗口后我该做什么?</p>
<p class="faq-a">三选一:① 有滑块就拖完;② 页面没有滑块(纯接口限流)就放着等,接口恢复的瞬间窗口自动关闭并继续采集;③ 等不及可以关掉窗口,稍后再点「采集」(断点保留,不会重复采)。切忌验证窗口开着的时候反复点「采集」。</p>

<p class="faq-q">被限流了是什么体验?要等多久?</p>
<p class="faq-a">表现为采集停止并弹出验证窗口,或提示接口被限。等待时间由抖音决定,一般几分钟到几十分钟。期间已采到的数据全部安全保留;不要反复点「采集」刺激接口;实在等不了就关掉验证窗,过段时间再点「采集」自动断点续采。</p>

<p class="faq-q">采集中途失败 / 网络断 / 手动停止,之前的进度会丢吗?</p>
<p class="faq-a">不会。已采内容实时落盘,断点自动保存;再点「采集」从断点继续,不重复也不遗漏。中途关掉应用甚至重启电脑,断点同样有效。</p>

<p class="faq-q">为什么每次点「采集」只加几条,甚至一条都不加?</p>
<p class="faq-a">这是增量采集的正常表现:每次只抓"上次采集之后新点赞的那几条"。想验证:先在抖音里给几条新视频点赞,再点「采集」,它们就会进来。真正需要留意的是"上次没采完被中断"(界面会提示可从断点续采),那种情况再点一次会从断点补全。</p>

<p class="faq-q">为什么采集到的数量比抖音里显示的喜欢数少?</p>
<p class="faq-a">正常现象。部分内容已被删除、下架或设为私密,接口不再返回。最终数量 ≤ 抖音显示的喜欢数,少几千到几万条都属正常。</p>

<p class="faq-q">怎么添加 / 切换账号?切换要多久?</p>
<p class="faq-a">左下角账号区 → 面板里「＋ 添加账号」(会直接进登录页)或点其他账号那一行切换。切换要重启一遍内置浏览器环境,约几秒,期间屏幕中间转圈,属正常;每个账号的列表、采集进度、登录态都是独立的。</p>

<p class="faq-q">我在新账号里登录了同一个抖音号,数据怎么合到一起了?</p>
<p class="faq-a">这是有意的:一个抖音号只对应一个应用账号。检测到你登录的抖音号和另一个账号是同一个人时,那份数据会自动合并过来(旧的改名留档,不删除),避免同一个号在本地出现两份互相矛盾的数据。</p>

<p class="faq-q">我有多个抖音号,能把它们的内容放在一个列表里看吗?</p>
<p class="faq-a">可以,用「导出 / 导入」实现:在账号 A 点「导出」,切到账号 B 点「导入」选择这个文件。导入是<b>合并式</b>的(按内容去重),B 里已有的不会重复,没有的会补进来。多个号就重复"导出 → 切换 → 导入"几次,最终一个账号里就是合集(各账号自己的原始数据不受影响)。</p>

<p class="faq-q">删除账号后,那个号的数据去哪了?</p>
<p class="faq-a">数据目录与登录态会被改名留档(形如 <code>user2_deleted_0913_0040</code>),不会立即物理删除,账号面板里不再显示。想找回可以在 <b>%LOCALAPPDATA%\DouyinShuffle</b> 里找到对应目录。</p>

<p class="faq-q">退出登录会删掉采集的数据吗?</p>
<p class="faq-a">不会。退出登录只清除本机登录信息(仅当前账号),数据完整保留,重新登录后可继续增量采集。</p>

<p class="faq-q">点卡片后要等一下才出画面,正常吗?</p>
<p class="faq-a">正常。点下去会立刻打开播放页,然后实时向抖音获取播放地址(1~2 秒);播放地址不落盘,每次都是新的,这是为了链接永久可用。</p>

<p class="faq-q">播放失败、黑屏,或播了几秒卡住怎么办?</p>
<p class="faq-a">播放页有「跳过」逻辑会自动切下一条,也可以直接按 <kbd>↓</kbd> 切歌或 <kbd>→</kbd> 试着快进。长时间暂停后播不动时,切下一条再切回来即可(会重新取链)。</p>

<p class="faq-q">视频有声音但没有画面(或整页白屏)?</p>
<p class="faq-a">分两种:① 内容为 H.265 编码、系统没装 HEVC 解码时会"有声无画",应用会自动尝试备用链接,仍不行请安装 Windows「HEVC 视频扩展」;② 如果整个播放界面都白(连按钮都没有)而用浏览器打开抖音正常,多半是 WebView2 Runtime 版本太旧,装最新 Evergreen 版后重启应用。</p>

<p class="faq-q">实况(动图)为什么有的会动、有的不动?</p>
<p class="faq-a">取决于抖音接口有没有给这条内容返回"动态子链"。给了就按实况播放(动一下、停一下再继续,和抖音一致),接口没给就只能显示静态图 —— 那不是显示问题,是这条内容在网页接口里没有动态版本。</p>

<p class="faq-q">「继续上次播放」什么时候出现?什么时候消失?</p>
<p class="faq-a">出现:上次是手动退出播放页(点 ✕ / 按 Esc),或播放中直接关掉了应用窗口 —— 下次打开主界面就会看到这条提示,点「继续播放」回到那条与那个位置。消失:整轮播完(没有继续的意义)、点 ✕ 忽略、或该内容已被删除 / 取消点赞。想重新开始就点「重新洗牌」。</p>

<p class="faq-q">播放列表里为什么看不到全部几千条?</p>
<p class="faq-a">列表按需加载:打开时围绕当前播放条目加载一段,向下滚动会自动续载后面的条目,不必一次渲染几万行。播放队列只属于本次播放会话,关闭应用不保存(但会用「继续上次播放」记住你的位置)。</p>

<p class="faq-q">全屏后怎么退出?</p>
<p class="faq-a">按 <kbd>F</kbd>、<kbd>Esc</kbd>,或再双击一次画面。</p>

<p class="faq-q">数据保存在哪里?重装系统会丢吗?</p>
<p class="faq-a">全部在本机:<b>%LOCALAPPDATA%\DouyinShuffle</b>。里面按账号分目录 —— <code>Data\&lt;账号&gt;\items.dylist</code> 是列表、<code>state.json</code> 是采集断点、<code>resume.json</code> 是上次播放位置;<code>Profiles\&lt;账号&gt;</code> 是登录态;<code>accounts.json</code> 是账号清单、<code>settings.json</code> 是外观设置;<code>init.log</code> 是运行日志。重装系统 / 换电脑前请先「导出」,新环境用「导入」恢复(登录态需要重新登录)。</p>

<p class="faq-q">仪表盘上的「占用 (MB)」是什么?</p>
<p class="faq-a">当前账号数据目录的体积(含你导出的 .dylist / .csv 文件),纯展示用。如果数字明显偏大,通常是导出文件占的,可以自己清理旧导出文件;列表本体几万条也就二三十 MB。</p>

<p class="faq-q">「删除」和「取消点赞」有什么区别?</p>
<p class="faq-a">「删除」只把这条从本地列表移除,抖音上的点赞还在;「取消点赞」是真的去抖音取消点赞(成功后同步移出本地)。请看清按钮再点:「删除」不可恢复,「取消点赞」在抖音侧也不可逆。</p>

<p class="faq-q">「取消点赞」中途停住 / 失败了,会不会把数据弄乱?</p>
<p class="faq-a">不会。只有抖音确认取消成功的条目才会从本地移除,失败或被风控拦下的都保留;成功一条立即保存,随时可停,重跑只处理剩余的。数量大时请耐心(每条有节流间隔),并留意弹窗里的验证提示。</p>

<p class="faq-q">深色模式切换账号后会丢吗?</p>
<p class="faq-a">不会。外观是应用级设置(存在 settings.json),不属于某个账号,所以切到另一个账号依然是深色。</p>

<p class="faq-q">窗口边缘拖不动、不能自由缩放?</p>
<p class="faq-a">应用是无边框窗口,边缘缩放区域被播放内核占满,属架构限制。调整大小请用右上角「最大化 / 还原」,或 <kbd>Win</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>(最大化 / 还原)、<kbd>Win</kbd>+<kbd>←</kbd> / <kbd>→</kbd>(贴半屏)。</p>

<p class="faq-q">搜索框为什么输入时不过滤,要按回车?</p>
<p class="faq-a">列表可能有几万条,实时过滤会造成输入卡顿,所以按回车或点「搜索」执行;清空输入框会立即恢复全部列表,不用再按回车。</p>

<p class="faq-q">支持采集「收藏夹」吗?</p>
<p class="faq-a">当前版本仅支持「喜欢」列表。</p>`;

function openHelp(title, html) {
  setText('help-title', title);
  document.getElementById('help-body').innerHTML = html;
  document.getElementById('help-modal').classList.remove('hidden');
}
function closeHelp() {
  document.getElementById('help-modal').classList.add('hidden');
  document.getElementById('help-body').innerHTML = '';
}
// 主题按钮:浅 ↔ 深 两档循环;按钮图标随状态
on('btn-theme', 'click', () => {
  const next = curTheme === 'light' ? 'dark' : 'light';   // 两档:浅色 ↔ 深色(v1.0.7 用户反馈去掉"跟随系统")
  applyTheme(next);
  call('themeChanged', next);   // ★用户主动切换:回报宿主(同步窗口底色 + 落盘 settings.json)
  toast(next === 'dark' ? '外观:深色' : '外观:浅色');
});
function syncThemeBtn(theme) {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  btn.title = `外观:${theme === 'dark' ? '深色' : '浅色'}(点击切换)`;
}
// 主题按钮:浅 ↔ 深 两档循环;按钮图标随状态
on('btn-tutorial', 'click', () => openHelp('使用教程', HELP_TUTORIAL));
on('btn-faq', 'click', () => openHelp('常见问题', HELP_FAQ));
on('help-close', 'click', closeHelp);
document.getElementById('help-modal').addEventListener('mousedown', e => {
  if (e.target.id === 'help-modal') closeHelp();   // 点遮罩关闭
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeHelp();
});

// ---------- 继续上次播放提示条(v1.0.7) ----------
async function checkResume() {
  try {
    const bar = document.getElementById('resume-bar');
    if (!bar) return;
    const r = await call('resumeInfo');
    if (!r || r === 'null') { bar.classList.add('hidden'); return; }
    const info = typeof r === 'string' ? JSON.parse(r) : r;
    if (!info || !info.awemeId) { bar.classList.add('hidden'); return; }
    const pos = `${Math.floor((info.posSec || 0) / 60)}:${String((info.posSec || 0) % 60).padStart(2, '0')}`;
    document.getElementById('resume-text').textContent =
      `上次播放到「${info.desc}」(队列 ${info.queueCount} 条, ${pos})`;
    bar.classList.remove('hidden');
  } catch (e) { }
}
on('btn-resume-continue', 'click', async () => {
  const r = await call('resumePlayback');
  if (r && String(r).startsWith('err')) toast(String(r), true);
  else document.getElementById('resume-bar')?.classList.add('hidden');
});
on('btn-resume-new', 'click', () => {
  document.getElementById('resume-bar')?.classList.add('hidden');
  document.getElementById('btn-shuffle')?.click();
});
on('btn-resume-dismiss', 'click', () => document.getElementById('resume-bar')?.classList.add('hidden'));

// ---------- 账号面板(多账号:v1.0.7) ----------
// 入口:侧栏底部头像区 → 弹面板(列表/切换/新增/重命名);宿主命令:accounts / switchAccount / addAccount / renameAccount
function escH(s) { return escapeHtml(s || ''); }
function fmtLastUsed(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((today - that) / 86400000);
  if (days === 0) return '今天使用';
  if (days === 1) return '昨天使用';
  return `上次使用 ${d.getMonth() + 1}/${d.getDate()}`;
}
async function renderAccountPanel() {
  const listEl = document.getElementById('account-list');
  if (!listEl) return;
  const r = await call('accounts');
  let data;
  try { data = typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { data = null; }
  if (!data || !Array.isArray(data.accounts)) { listEl.innerHTML = '<div class="account-tip">账号信息读取失败</div>'; return; }
  listEl.innerHTML = data.accounts.map(a => `
    <div class="account-list-item ${a.current ? 'current' : ''}" data-profile="${escH(a.profileName)}">
      ${a.avatarUrl
        ? `<img class="account-avatar" src="${escH(a.avatarUrl)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;account-avatar account-avatar-ph&quot;>👤</span>'" />`
        : '<span class="account-avatar account-avatar-ph">👤</span>'}
      <span class="a-info">
        <span class="a-name">${escH(a.displayName)}</span>
        <span class="a-sub">${a.current ? loggedIn ? '已登录' : '未登录 — 点此登录' : fmtLastUsed(a.lastUsedAt) || '尚未使用(点击切换)'}</span>
      </span>
      ${a.current
        ? (loggedIn ? `<button class="a-rename a-logout" data-profile="${escH(a.profileName)}" title="清除该账号本机登录信息">退出登录</button>` : '')
        : `<span class="a-ops"><button class="a-rename" data-profile="${escH(a.profileName)}" title="重命名">改名</button>${data.accounts.length > 1 ? `<button class="a-rename a-del" data-profile="${escH(a.profileName)}" title="删除该账号(数据留档可手动找回)">删除</button>` : ''}</span>`}
    </div>`).join('');
  // 事件:点其他账号=切换;点当前未登录条目=登录当前账号;改名/退出/删除各自处理
  listEl.querySelectorAll('.account-list-item').forEach(item => {
    item.addEventListener('click', async e => {
      if (e.target.closest('.a-rename')) return;
      const profile = item.dataset.profile;
      if (profile === data.current) {
        // 点当前账号条目:未登录 → 触发登录(登录的是这个壳,数据也是这个壳的)
        if (profile === data.current && !loggedIn) {
          const r = await call('login');
          if (r && String(r).startsWith('err')) toast(String(r), true);
          else { toast('已打开抖音登录页,登录成功后会自动关闭'); hideAccountModal(); }
        }
        return;
      }
      if (!confirm(`切换账号?\n当前播放/采集将停止,内容将刷新为新账号的数据。`)) return;
      const r2 = await call('switchAccount', profile);
      if (r2 && String(r2).startsWith('err')) toast(String(r2), true);
      else hideAccountModal();
    });
  });
  listEl.querySelectorAll('.a-rename').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const profile = btn.dataset.profile;
      if (btn.classList.contains('a-logout')) {
        // 当前账号的「退出登录」:仅清该账号登录态,数据保留
        if (!confirm('确定退出登录吗?\n将清除该账号在本机的登录信息(采集的数据保留),下次使用该账号需重新登录。')) return;
        const r = await call('logout');
        if (r === 'ok') { toast('已退出登录'); renderAccountPanel(); loadAccountEntry(); }   // 面板保持打开:用户可直接点其他账号切换
        else toast(r || '操作失败', true);
        return;
      }
      if (btn.classList.contains('a-del')) {
        // 删除整个"应用账号"(数据目录改名留档,不物理删除)
        const item = data.accounts.find(a => a.profileName === profile);
        if (!confirm(`删除「${item?.displayName || profile}」?\n\n该账号的采集数据与登录信息将移入回收目录(不会立即删除,可手动找回)。\n应用账号列表中将不再显示。`)) return;
        const r = await call('deleteAccount', profile);
        if (r === 'ok') { toast('已删除(数据已留档)'); renderAccountPanel(); }
        else toast(r || '删除失败', true);
        return;
      }
      const item = data.accounts.find(a => a.profileName === profile);
      const name = prompt('修改显示名:', (item && item.displayName) || '');
      if (name && name.trim()) {
        await call('renameAccount', profile, name.trim());
        renderAccountPanel();
        loadAccountEntry();
      }
    });
  });
}
function showAccountModal() {
  document.getElementById('account-modal').classList.remove('hidden');
  renderAccountPanel();
}
function hideAccountModal() {
  document.getElementById('account-modal').classList.add('hidden');
}
// 侧栏账号入口点击:总是弹账号面板(v1.0.7 修正:退出登录后面板保持打开,
// 用户可直接点其他账号切换,而不是被迫先重新登录当前壳)。
// 未登录时面板同样可用:点其他账号=切换过去再登录;点当前账号条目=登录当前账号。
on('account-entry', 'click', () => showAccountModal());
on('account-modal-close', 'click', hideAccountModal);
document.getElementById('account-modal').addEventListener('mousedown', e => {
  if (e.target.id === 'account-modal') hideAccountModal();
});
on('btn-add-account', 'click', async () => {
  if (!confirm('添加新账号?\n将进入登录页,登录后内容会切换到新账号。')) return;
  hideAccountModal();
  const r = await call('addAccount');
  if (r && String(r).startsWith('err')) toast(String(r), true);
});
// 宿主广播:账号档案变化(登录成功回填昵称头像/切换完成)→ 刷新入口显示
window.__dsh_accountsChanged = function () {
  loadAccountEntry();
};
async function loadAccountEntry() {
  const r = await call('accounts');
  let data;
  try { data = typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return; }
  if (!data || !Array.isArray(data.accounts)) return;
  const cur = data.accounts.find(a => a.current) || {};
  const avatarImg = document.getElementById('account-avatar');
  const avatarPh = document.getElementById('account-avatar-ph');
  const nameEl = document.getElementById('account-name');
  if (nameEl) nameEl.textContent = cur.displayName || (loggedIn ? '已登录' : '未登录');
  if (avatarImg && avatarPh) {
    if (cur.avatarUrl) {
      avatarImg.src = cur.avatarUrl;
      avatarImg.classList.remove('hidden');
      avatarPh.classList.add('hidden');
    } else {
      avatarImg.classList.add('hidden');
      avatarPh.classList.remove('hidden');
    }
  }
}
// 换舱过场(宿主广播):居中转圈,极简(用户反馈三步文案生硬,已简化)
window.__dsh_accountSwitching = function (on) {
  let el = document.querySelector('.account-switching');
  if (on) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'account-switching';
      el.innerHTML = '<div class="as-spin"></div>';
      document.body.appendChild(el);
    }
  } else if (el) {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 400);
  }
};

// ---------- 深色模式(两档:light/dark) ----------
// ★真源在宿主(settings.json,应用级):换账号 = 换 WebView2 profile,localStorage 是另一份,
// 所以这里只做"首帧快速回显",随后由宿主 state 广播里的 theme 校正(见 __dsh_state)。
// ★回报宿主的时机:只有"用户点了按钮"才 call('themeChanged') —— 页面加载时把 localStorage
// 的旧值报上去会把宿主里记着的主题覆盖掉(新 profile 里 localStorage 是空的 → 报 light),
// 于是换账号后深色白丢一次。启动/校正一律只应用、不回报(宿主本来就是对的)。
function applyTheme(theme) {
  curTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', curTheme);
  try { localStorage.setItem('dshTheme', curTheme); } catch (e) { }   // 本 profile 缓存:下次首帧不闪
  syncThemeBtn(curTheme);
}
function initTheme() {
  let theme = 'light';
  try { theme = localStorage.getItem('dshTheme') || 'light'; } catch (e) { }
  if (theme !== 'dark' && theme !== 'light') theme = 'light';   // 兼容旧存储的 'system' 档
  applyTheme(theme);
  // 加载时上报一次:宿主"还没记过主题"(首次运行/旧版本升级)时采纳这个值 —— 老用户的
  // 深色偏好就存在 profile 的 localStorage 里,不能被默认值刷掉。宿主已记过则这次上报被忽略,
  // 随后 state 广播把主题校正回来(换账号后本 profile 的 localStorage 是另一份)。
  call('themeChanged', theme);
}
window.__dsh_setTheme = function (theme) {
  applyTheme(theme);   // 宿主下发(启动校正/换账号后):只应用,不回报
};

// ---------- 初始 ----------
window.addEventListener('DOMContentLoaded', () => {
  bindGrid();
  updateSelectUi();
  initTheme();
  loadAccountEntry();
  // 自动连播开关(与播放页 🔁 / 快捷键 A 同源;宿主广播 __dsh_autoNext 回显勾选态)
  const autoNextEl = document.getElementById('auto-next');
  const autoNextLabel = document.getElementById('auto-next-label');
  autoNextEl.addEventListener('change', () => {
    autoNextLabel.classList.toggle('on', autoNextEl.checked);
    call('autonext', autoNextEl.checked);
  });
  // 手动刷新列表按钮(采集/导入等操作后,由用户点击刷新)
  document.getElementById('btn-refresh-list').addEventListener('click', () => {
    refresh();
    toast('列表已刷新');
  });
  const hasPost = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
  if (!hasPost) toast('桥接未就绪', true);
  refresh();
  checkResume();
  call('state').then(r => {
    if (typeof r === 'string' && r.startsWith('{')) {
      try { window.__dsh_state(JSON.parse(r)); } catch (e) { }
    }
  });
});
