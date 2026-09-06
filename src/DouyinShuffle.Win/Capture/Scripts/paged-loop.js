// 翻页采集脚本(单一通道:直连裸 fetch)。宿主模板替换 4 个占位符:
// SEC_USER_ID / START_CURSOR / KNOWN_IDS / RESUME_MODE
// 注意:本文件注释中不得出现占位符原文,否则会被 Replace 误替换导致语法错误(历史事故)。
// - 循环:buildUrl(cursor) → send(url) → 解析 max_cursor/has_more → 回传 body → 下一页
// - 终止(五重):has_more=false / 增量整页已知 / cursor 停滞(3次) / 安全页数上限(200) / 停止标志
// - 消息协议:direct_started / direct_resp / direct_progress / direct_fail / direct_done{reason}
//   reason ∈ complete/incremental/stalled/safety/stopped/blocked/notready
(function () {
  var SEC = '{{SEC_USER_ID}}';
  var CURSOR = {{START_CURSOR}};
  // 模式开关(宿主显式传入,不再由 cursor 推断 —— 两阶段采集后 cursor>0 不再等于断点硬续):
  // hardResume=1 断点硬续:禁用"整页已知→incremental"停(硬续区都该是未采内容,出现整页已知
  //   只可能是接口卡页,停成 incremental 会清断点、重演"卡在几千条再采无新增");
  // hardResume=0 头部增量(首轮/续轮):保持增量停,补完新点赞即秒回。
  var IS_RESUME = '{{RESUME_MODE}}' === '1';
  var KNOWN = {{KNOWN_IDS}};   // 增量模式:已知 aweme_id 查找表(对象字面量,O(1) 命中判断)
  function post(d) {
    try { window.chrome.webview.postMessage(d); } catch (e) {}
  }
  // 参数集 = 抖音 Web 端标准结构性参数(不伪造指纹:不传 webid/screen_*/browser_*
  // 等可能与环境不一致的值,不传 msToken —— 全部交给页面拦截器按真实环境现补)
  function buildUrl(cursor) {
    var p = new URLSearchParams();
    p.set('device_platform', 'webapp');
    p.set('aid', '6383');
    p.set('channel', 'channel_pc_web');
    p.set('sec_user_id', SEC);
    p.set('max_cursor', String(cursor));
    p.set('min_cursor', '0');
    p.set('count', '18');
    p.set('publish_video_strategy_type', '2');
    p.set('pc_client_type', '1');
    p.set('version_code', '290100');
    p.set('version_name', '29.1.0');
    p.set('update_version_code', '170400');
    p.set('cookie_enabled', 'true');
    p.set('platform', 'PC');
    var u = 'https://www.douyin.com/aweme/v1/web/aweme/favorite/?' + p.toString();
    // msToken 从 cookie 现取(没有就空着,拦截器会补)
    try {
      var m = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/);
      if (m && m[1]) u += '&msToken=' + encodeURIComponent(m[1]);
    } catch (e) {}
    return u;
  }
  // 裸 fetch:直接调 window.fetch 即当前最外层(webmssdk 包装层),
  // 由抖音页面自己的拦截器自动补 a_bogus/X-Bogus/msToken。
  function send(url) {
    return fetch(url, { method: 'GET', credentials: 'include', headers: { 'accept': 'application/json, text/plain, */*' } })
      .then(function (r) { return r.text().then(function (t) { return { s: r.status, b: t }; }); });
  }
  window.__dsh_direct_stop__ = false;
  var fetched = 0, empty = 0, emptyDelay = 1200, totalItems = 0, emptyPages = 0;
  var lastCursor = -1, lastFirst = '', stallCount = 0;
  var finished = false;
  function done(reason) {
    if (finished) return;
    finished = true;
    post({ type: 'direct_done', reason: reason, fetched: fetched, totalItems: totalItems });
  }
  // 同步心跳
  post({ type: 'direct_started', cursor: CURSOR });
  function step() {
    if (finished) return;
    if (window.__dsh_direct_stop__) { done('stopped'); return; }
    // 安全上限:200 页 ≈ 3600 条,防异常无限翻页(宿主分轮续采)
    if (fetched >= 200) { done('safety'); return; }
    var url = buildUrl(CURSOR);
    // 挂起保护:Promise.race 6 秒超时(黑洞时快速失败;正常接口响应 <2s,余量充足)
    var timeout = new Promise(function (res, rej) { setTimeout(function () { rej(new Error('timeout6s')); }, 6000); });
    Promise.race([send(url), timeout]).then(function (res) {
      var c = window.__dsh_classify(res.b, res.s);
      if (c.kind !== 'json') {
        // 非合法 JSON(验证页 A / 黑洞超时 B / 解析失败)→ 空响应计数,统一分流
        empty++;
        post({ type: 'direct_fail', fetched: fetched, empty: empty, status: res.s, body: (res.b || '').slice(0, 150) });
        // 首页即不可用 → notready,让宿主分流(网络抖动重试 / 限流弹验证)
        if (fetched === 0 && empty >= 2) { done('notready'); return; }
        if (empty >= 3) { done('blocked'); return; }   // 连续 3 次空响应即判定风控(缩短黑洞空转)
        setTimeout(step, emptyDelay);
        emptyDelay = Math.min(8000, emptyDelay * 2);
        return;
      }
      // 合法 JSON:直接复用分类器解析结果(data/list/hasMore),不再各自 try/parse
      empty = 0;
      emptyDelay = 1200;
      var data = c.data;
      post({ type: 'direct_resp', url: url, status: res.s, body: res.b });
      fetched++;
      var pFirst = c.list && c.list[0] ? c.list[0].aweme_id : '';
      var pCount = c.list.length;
      totalItems += pCount;
      post({ type: 'direct_progress', fetched: fetched, cursor: CURSOR, first: pFirst, items: pCount, totalItems: totalItems });
      var hasMore = c.hasMore;
      var next = data && data.max_cursor ? data.max_cursor : 0;
      var curFirst = pFirst;
      // 增量模式:整页全为已知 ID = 已到断点(喜欢列表倒序,旧内容无需重翻)。
      // 单页混有新旧(用户断点后又有新喜欢)→ 继续,后续页会全旧而停。
      // ★硬续模式(IS_RESUME)整轮禁用此判断:硬续起点 cursor 指向上轮停滞/中断处,往更早翻
      // 的方向理论上都是未采内容,不该出现"整页已知" —— 若出现,只可能是接口仍在重放停滞页
      // (卡页),停成 incremental 会清掉断点标志,重演"卡在几千条再采无新增"的老 bug。
      // 正确做法:放它继续翻 —— 接口恢复 → 翻到全新内容越过断层;仍卡页 → 由下方
      // stallCount(连续同首条/游标不进)判 stalled(保留断点,下次再续)。
      if (KNOWN && !IS_RESUME && pCount > 0) {
        var knownHits = 0;
        try {
          for (var ki = 0; ki < c.list.length; ki++) {
            if (KNOWN[c.list[ki].aweme_id]) knownHits++;
          }
        } catch (e) {}
        if (knownHits === pCount) {
          post({ type: 'direct_progress', fetched: fetched, cursor: CURSOR, first: pFirst, items: 0, totalItems: totalItems });
          done('incremental');
          return;
        }
      }
      // 空数据页检测:接口返回 JSON 但列表为空且 has_more=true = 风控"假数据"响应。
      // 正常页至少 1 条;连续 3 页空说明被风控喂空列表,立即判定 blocked 交给宿主分流,
      // 否则会一直空翻到 200 页 safety 上限(≈数分钟空转,且被当作正常收尾,无风控提示)。
      if (pCount === 0 && hasMore) {
        emptyPages++;
        if (emptyPages >= 3) { done('blocked'); return; }
      } else {
        emptyPages = 0;
      }
      // 游标停滞判定(紧跟在"整页已知"增量停之后):连续 3 次出现
      // 返回游标不前进 / 首页 aweme 与上页相同 = 接口卡页(疑似限流喂假数据)。
      if (next !== 0 && (next === lastCursor || (curFirst && curFirst === lastFirst))) {
        stallCount++;
        if (stallCount >= 3) { done('stalled'); return; }
      } else {
        stallCount = 0;
      }
      lastCursor = next;
      lastFirst = curFirst;
      // 完成判定只用真信号:has_more=false(接口明说没有更多),或接口不再给游标(!next)。
      // ★注意:不能把 next===CURSOR(游标原地不动)当成完成 —— 那正是"卡页被当成采完"的来源,
      // 会清掉断点标志、重演"再采永远无新增"。has_more=true 时游标不前进 = 疑似卡页,
      // 不判完成,原地再探一次,由上面的 stallCount 连续计数收口(3 次 → stalled,断点保留)。
      if (!hasMore || !next) { done('complete'); return; }
      if (next === CURSOR) {
        setTimeout(step, 400 + Math.random() * 400);
        return;
      }
      CURSOR = next;
      setTimeout(step, 200 + Math.random() * 300);   // 拟人间隔
    }).catch(function (e) {
      empty++;
      post({ type: 'direct_fail', fetched: fetched, empty: empty, status: 0, body: 'err:' + String(e && e.message || e) });
      if (fetched === 0 && empty >= 2) { done('notready'); return; }
      if (empty >= 3) { done('blocked'); return; }   // 连续 3 次空响应即判定风控(缩短黑洞空转)
      setTimeout(step, emptyDelay);
      emptyDelay = Math.min(8000, emptyDelay * 2);
    });
  }
  step();
})();
