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
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 登录态 ----------
function applyLoginState() {
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  if (loggedIn) {
    btnLogin.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    setText('login-state', '已登录');
  } else {
    btnLogin.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    setText('login-state', '未登录');
  }
}
window.__dsh_state = function (st) {
  loggedIn = !!st.loggedIn;
  applyLoginState();
  setText('stat-total', st.count || items.length);
  if (typeof st.autoNext === 'boolean' && window.__dsh_autoNext) window.__dsh_autoNext(st.autoNext);
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
  setText('stat-invalid', invalid);
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
  if (!loggedIn) { toast('请先点右上角「登录」', true); return; }
  // 按当前筛选条件(年份/月份/分类/搜索)洗牌
  const ids = filtered.map(i => i.awemeId);
  const r = await call('shuffle', ids);
  if (r === 'empty') toast('没有可播放的内容', true);
  else if (r && String(r).indexOf('err') === 0) toast(String(r), true);
});
on('btn-login', 'click', async () => {
  const r = await call('login');
  if (r === 'already') toast('已是登录状态');
  else if (r && String(r).indexOf('err') === 0) toast(String(r), true);
  else toast('已打开抖音登录页,登录成功后会自动关闭');
});
on('btn-logout', 'click', async () => {
  if (!confirm('确定退出登录吗?\n退出后将清除本机保存的抖音登录信息,下次使用需重新登录。')) return;
  const r = await call('logout');
  if (r === 'ok') { toast('已退出登录'); }
  else toast(r || '操作失败', true);
});
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
  const warn = count > 50
    ? `\n\n⚠ 已选 ${count} 条,数量较大:抖音对批量取消有限流/风控风险,触发后会暂停并弹验证。建议先小批量试或分批操作。`
    : '';
  if (!confirm(
    `确定在抖音中取消选中的 ${count} 个作品的点赞吗?\n` +
    `程序会逐个处理,速度较慢属正常,可随时点进度条旁「停止」。\n` +
    `只有成功取消点赞的条目才会从本地列表移除。${warn}`
  )) return;

  const ids = [...selected];
  setUnlikeBtn(true);
  try {
    const r = await call('unlike', ids);
    if (r === 'started') { /* 进度条由宿主 __dsh_unlikeStart 接管 */ }
    else if (r === 'busy') { toast('已有取消点赞任务正在执行', true); setUnlikeBtn(false); }
    else if (r && String(r).indexOf('err') === 0) { toast(String(r), true); setUnlikeBtn(false); }
    else { toast('启动失败:' + r, true); setUnlikeBtn(false); }
  } finally {
    // 成功启动时按钮由 __dsh_unlikeEnd 恢复;其余路径上面已恢复
  }
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
// 搜索:点击按钮(或回车)后才执行,不再随输入实时过滤
function doSearch() {
  const el = document.getElementById('search');
  searchText = (el ? el.value : '').trim();
  applyFilter();
}
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
  if (e.target.closest('button, input, select, .side-item, .win-controls')) return;
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
window.__dsh_onPlaying = setPlaying;
window.__dsh_refresh = refresh;
window.__dsh_toast = toast;

// ---------- 帮助弹窗(使用教程 / 常见问题) ----------
const HELP_TUTORIAL = `
<h4>一、快速上手(三步)</h4>
<ol>
  <li><b>登录</b>:点右上角「登录」→ 在弹出的页面完成抖音登录(支持扫码)→ 成功后窗口自动关闭。</li>
  <li><b>采集</b>:点右上角红色「采集」按钮,自动抓取你抖音账号的「喜欢列表」;顶部进度条实时显示新增数量,采完自动停止。</li>
  <li><b>播放</b>:点任意卡片,从该卡片开始顺序播放;或点「洗牌播放」随机播放当前筛选下的全部内容。播放页底部一排按钮都能点(连播 / 倍速 / 评论 / 全屏 / 播放列表)。</li>
</ol>

<h4>二、采集说明</h4>
<ul>
  <li><b>采集前预检</b>:每次点「采集」会先检查接口状态(几秒到十几秒),显示「正在检查接口状态…」属正常流程。</li>
  <li><b>增量采集</b>:再次点「采集」只补上次之后新喜欢的内容,已采集的自动去重,翻到断点即自动停止。</li>
  <li><b>断点续采</b>:采集中途失败、被限流或手动停止后,再点「采集」会自动从上次的进度继续,不会遗漏。</li>
  <li><b>超长列表</b>:单轮最多翻 200 页(约 3600 条),到达上限自动从断点分轮继续,进度条会显示「第 N 轮」,全程无需手动操作。</li>
  <li><b>限流与验证</b>:采集过快可能触发抖音限流,此时会弹出验证窗口——窗口会一直等到接口恢复才自动关闭并继续采集,期间请勿反复点「采集」。</li>
  <li><b>数量说明</b>:抖音接口每页固定返回 18 条;最终总数可能与抖音显示的喜欢数不一致(部分内容已失效、下架或删除)。</li>
</ul>

<h4>三、播放页功能</h4>
<ul>
  <li><b>播放队列</b>:点控制条「播放列表」或按 <kbd>Q</kbd> 展开右侧队列(当前在播的红色呼吸高亮、自动居中)。点任意条目立即跳到那一条;列表很长时向下滚动会自动继续加载。连播 / 跳转时高亮自动跟随。</li>
  <li><b>倍速</b>:控制条「1x」按钮循环切换 0.75x → 1x → 1.25x → 1.5x → 2x,切歌后保持你的倍速。</li>
  <li><b>自动连播</b>:点「连播关/开」或按 <kbd>A</kbd>;开启后一条播完自动播下一条,播到队尾自动停止返回列表,选择会记忆。</li>
  <li><b>评论</b>:点「评论」打开该内容的抖音原页面看评论,关闭后回到原进度继续播放。</li>
  <li><b>全屏 / 时间码</b>:点「全屏」或双击画面进入全屏;右下角实时显示当前 / 总时长。</li>
  <li><b>播放范围跟筛选走</b>:在图集分类下点卡片,顺序播放的都是图集;洗牌播放同样只播当前筛选结果。</li>
  <li><b>实时取链</b>:每次播放都实时向抖音获取最新播放地址(保证链接新鲜),打开前等待 1~2 秒属正常。</li>
</ul>

<h4>四、播放快捷键</h4>
<ul>
  <li><kbd>空格</kbd> 播放 / 暂停</li>
  <li><kbd>↑</kbd> / <kbd>PageUp</kbd> 上一首;<kbd>↓</kbd> / <kbd>PageDown</kbd> 下一首</li>
  <li><kbd>←</kbd> / <kbd>→</kbd> 快退 / 快进 10 秒;图集中为上一张 / 下一张</li>
  <li><kbd>F</kbd> 或双击画面 全屏;<kbd>M</kbd> 静音;<kbd>A</kbd> 自动连播;<kbd>Q</kbd> 播放列表;<kbd>Esc</kbd> 停止并返回列表</li>
  <li>播放页空白处<b>滚动滚轮</b> = 上 / 下一首(抖音式);播放列表展开后,在列表范围内滚动只滚动列表、不切歌。</li>
</ul>

<h4>五、图集</h4>
<ul>
  <li>打开图集后自动轮播;<kbd>空格</kbd> 暂停 / 继续轮播。</li>
  <li>鼠标悬停进度条可预览并直接跳选任意一张;<kbd>←</kbd> <kbd>→</kbd> 手动翻张。</li>
</ul>

<h4>六、筛选与搜索</h4>
<ul>
  <li>左栏「全部 / 图集 / 视频」切换分类,右侧数字为各分类数量。</li>
  <li>列表上方的年份、月份筛选与「洗牌播放」联动:筛选后洗牌只播筛选出的内容。</li>
  <li>顶部搜索框支持按标题、作者搜索;输入后按回车或点「搜索」执行(不实时过滤,避免大列表卡顿)。</li>
</ul>

<h4>七、数据管理</h4>
<ul>
  <li><b>删除</b>:点「选择」进入勾选模式 → 勾选条目 → 「删除」。删除仅移除本地记录,不可恢复。</li>
  <li><b>取消点赞</b>:同样的勾选模式点「取消点赞」,逐个在抖音侧取消(同时移除本地)。逐条自动节流、进度条可随时停止;触发风控会自动暂停并弹验证,验证后可继续(未成功的保留本地)。几百条大操作与采集 / 播放互斥,运行中那两处入口会置灰。</li>
  <li><b>备份</b>:「导出」生成 .dylist 备份文件;「导入」可随时恢复,适合换电脑或重装系统。</li>
  <li><b>退出登录</b>:仅清除本机登录信息,不影响已采集的数据。</li>
</ul>`;

const HELP_FAQ = `
<p class="faq-q">点了「采集」,进度条显示「正在检查接口状态…」要等多久?</p>
<p class="faq-a">这是采集前的接口预检,正常几秒到十几秒,目的是提前发现接口是否可用(而不是开始采集后黑等半分钟)。通过后自动开始翻页;没通过会给出明确提示,不会干等。</p>

<p class="faq-q">采集进行中反复点「采集」会加快速度吗?</p>
<p class="faq-a">不会,反而有害。采集是单线程队列,反复点击只会得到「已有采集在进行」的提示;更糟糕的是频繁请求更容易触发抖音限流。点一次后耐心等进度即可,采完自动停止。</p>

<p class="faq-q">为什么进度条显示的页数会重新从「第 1 页」开始?</p>
<p class="faq-a">列表超过约 3600 条时,单轮翻页达到 200 页上限,应用会自动开新的一轮接着采(不是重采!)。进度条上的「第 N 轮」就是当前轮次,总进度看「已采 X 条」那个数字,它是一直累加的。</p>

<p class="faq-q">弹出滑块验证窗口后,我该做什么?</p>
<p class="faq-a">三选一:① 有滑块就拖完它;② 页面没有滑块(纯接口限流)就放着等,接口恢复的瞬间窗口自动关闭并继续采集;③ 等不及可以点右上角 × 关闭窗口,稍后再点「采集」(断点会保留,不会重复采)。切忌:验证窗口开着的时候反复点「采集」。</p>

<p class="faq-q">限流了是什么体验?要等多久?</p>
<p class="faq-a">表现:采集停止并弹出验证窗口,或提示「接口被限」。等待时间由抖音决定,一般几分钟到几十分钟。期间:已采到的数据全部安全保留;不要反复点「采集」刺激接口;实在等不了就关掉验证窗,过段时间再点「采集」自动断点续采。</p>

<p class="faq-q">采集中途失败了(网络断/限流/手动停止),之前的进度会丢吗?</p>
<p class="faq-a">不会。已采到的内容实时落盘,断点自动保存;再点「采集」从断点继续,不重复也不遗漏。中途关掉应用甚至重启电脑,断点同样有效。</p>

<p class="faq-q">采集会重复抓取吗?</p>
<p class="faq-a">不会。已入库内容自动去重;上次采完后再次采集,翻到断点即自动完成,只补新内容。</p>

<p class="faq-q">为什么采集到的数量比抖音里显示的喜欢数少?</p>
<p class="faq-a">正常现象。部分内容已被删除、下架或设为私密,接口不再返回;能返回但无法播放的在列表中标记「失效」。最终数量 ≤ 抖音显示的喜欢数。</p>

<p class="faq-q">点「停止」之后马上又点「采集」,怎么没反应?</p>
<p class="faq-a">停止需要几秒钟收尾(旧循环退出+数据落盘),应用会等收尾完成后再接受新一次采集。稍等几秒再点即可,进度条消失后再点最稳。</p>

<p class="faq-q">为什么有些条目标着「失效」?</p>
<p class="faq-a">内容已被作者删除或设为私密。失效条目不参与播放与洗牌;可以留着,也可以在「选择」模式下勾选删除。</p>

<p class="faq-q">点卡片后提示「正在获取播放地址…」要等一下?</p>
<p class="faq-a">正常现象。播放地址实时向抖音获取(不落盘,保证链接始终可播),首次打开需 1~2 秒。</p>

<p class="faq-q">播放失败、黑屏,或播了几秒卡住怎么办?</p>
<p class="faq-a">播放页有「跳过」按钮,点它直接切下一首;也可以按 <kbd>→</kbd> 快进看看是否是卡顿。长时间暂停后播不动,切下一首再切回来即可(会重新取链)。</p>

<p class="faq-q">视频有声音但没有画面(或整个画面白屏)?</p>
<p class="faq-a">分两种:① 部分内容为 H.265 编码,系统没装 HEVC 解码时会「有声无画」,会自动尝试备用链接,仍不行请安装 Windows「HEVC 视频扩展」;② 如果整个播放界面都白(连按钮都没有)而浏览器打开抖音正常,多半是 WebView2 Runtime 版本太旧,请到微软官网下载安装最新 Evergreen 版后重启应用。</p>

<p class="faq-q">「取消点赞」中途停住/失败了,会不会把数据弄乱?</p>
<p class="faq-a">不会。只有抖音确认取消成功的条目才会从本地移除,失败/被风控拦下的都会保留;成功一条立即保存,随时可停止,重跑只处理剩余。勾选数量大时请耐心(每条有节流间隔),并留意弹窗里的验证提示。</p>

<p class="faq-q">「删除」和「取消点赞」有什么区别?</p>
<p class="faq-a">「删除」只把这条从本地列表移除,抖音上的点赞还在;「取消点赞」是真正去抖音取消点赞(成功后本地同步移除),请看清按钮再点。</p>

<p class="faq-q">播放列表里为什么看不到全部几千条?</p>
<p class="faq-a">列表按需加载:打开时围绕当前播放条目加载一段,向下滚动会自动继续加载后面的条目,不必一次渲染几万行。播放列表只是当前这次播放会话的队列,关闭应用不保存。</p>

<p class="faq-q">窗口能自由拖动大小吗?感觉边缘拖不动。</p>
<p class="faq-a">应用是无边框窗口,边缘缩放被播放内核占满,无法拖边;调整大小请用右上角「最大化 / 还原」,或 Windows 快捷键 <kbd>Win</kbd>+<kbd>↑</kbd>(最大化)、<kbd>Win</kbd>+<kbd>↓</kbd>(还原)、<kbd>Win</kbd>+<kbd>←</kbd>/<kbd>→</kbd>(贴半屏)。</p>

<p class="faq-q">数据保存在哪里?重装系统会丢吗?</p>
<p class="faq-a">全部数据在本机:C:\\Users\\&lt;用户名&gt;\\AppData\\Local\\DouyinShuffle\\Data。重装系统或换电脑前请先用「导出」备份,新环境用「导入」恢复。</p>

<p class="faq-q">退出登录会删掉采集的数据吗?</p>
<p class="faq-a">不会。退出登录只清除登录信息,数据完整保留;重新登录后可继续增量采集。</p>

<p class="faq-q">全屏后怎么退出?</p>
<p class="faq-a">按 <kbd>F</kbd>、<kbd>Esc</kbd>,或再双击一次画面。</p>

<p class="faq-q">搜索框为什么输入时不过滤,要按回车?</p>
<p class="faq-a">列表可能有几万条,实时过滤会造成输入卡顿,所以按回车或点「搜索」手动执行。</p>

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
on('btn-tutorial', 'click', () => openHelp('使用教程', HELP_TUTORIAL));
on('btn-faq', 'click', () => openHelp('常见问题', HELP_FAQ));
on('help-close', 'click', closeHelp);
document.getElementById('help-modal').addEventListener('mousedown', e => {
  if (e.target.id === 'help-modal') closeHelp();   // 点遮罩关闭
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeHelp();
});

// ---------- 初始 ----------
window.addEventListener('DOMContentLoaded', () => {
  bindGrid();
  updateSelectUi();
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
  call('state').then(r => {
    if (typeof r === 'string' && r.startsWith('{')) {
      try { window.__dsh_state(JSON.parse(r)); } catch (e) { }
    }
  });
});
