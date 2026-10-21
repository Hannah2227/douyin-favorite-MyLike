// 收藏接口探测脚本:裸 fetch 喜欢列表第一页(count=1 最小开销)→ 结果经 postMessage 回传。
// 用途:风控分接口场景 —— 收藏接口被限时 profile/self 健康检查仍 Ok,
// 验证窗口的"验证通过"必须以收藏接口恢复为准,否则会误判通过(实测踩坑)。
(function () {
  var ID = '{{ID}}';
  function post(d) {
    try { window.chrome.webview.postMessage(d); } catch (e) {}
  }
  var request = window.__dsh_listRequest('{{LIST_SOURCE}}', '{{SEC_USER_ID}}', 0, 1);
  // 挂起保护:6 秒超时(黑洞时快速失败;正常响应 <2s)
  var timeout = new Promise(function (res, rej) { setTimeout(function () { rej(new Error('timeout6s')); }, 6000); });
  Promise.race([
    fetch(request.url, request.options)
      .then(function (resp) { return resp.text(); }),
    timeout
  ]).then(function (text) {
    var c = window.__dsh_classify(text);
    if (c.kind === 'verify') { post({ type: 'fav_resp', id: ID, result: 'blocked' }); return; }
    if (c.kind === 'json') {
      if (Array.isArray(c.list)) { post({ type: 'fav_resp', id: ID, result: 'ok' }); return; }
      if (c.data && c.data.status_code && c.data.status_code !== 0) { post({ type: 'fav_resp', id: ID, result: 'code:' + c.data.status_code }); return; }
    }
    post({ type: 'fav_resp', id: ID, result: 'notready' });
  }).catch(function () {
    post({ type: 'fav_resp', id: ID, result: 'notready' });
  });
})();
