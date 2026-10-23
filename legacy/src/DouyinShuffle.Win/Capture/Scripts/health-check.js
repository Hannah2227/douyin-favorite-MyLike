// 健康检查取数脚本:fetch profile/self → 三态结果经 postMessage 回传。
// 请求原则与直连采集(send-direct.js)完全同款:只带结构性环境参数,
// 不伪造指纹(webid/screen_*/browser_* 等硬编码值与真实环境不一致,反有被风控识别的隐患),
// 其余参数交由页面 webmssdk 拦截器按真实环境现补。
// 结果判定:ok:sec_uid(登录+签名就绪) / html(验证页=真风控) / 其余(NotReady)。
// 响应形态统一由共享分类器 __dsh_classify 判定(见 classify.js)。
(function () {
  var ID = '{{ID}}';
  function post(d) {
    try { window.chrome.webview.postMessage(d); } catch (e) {}
  }
  var p = new URLSearchParams();
  p.set('device_platform', 'webapp');
  p.set('aid', '6383');
  p.set('channel', 'channel_pc_web');
  p.set('version_code', '290100');
  p.set('version_name', '29.1.0');
  p.set('update_version_code', '170400');
  p.set('cookie_enabled', 'true');
  p.set('platform', 'PC');
  var url = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?' + p.toString();
  // 挂起保护:6 秒超时(黑洞时快速失败,C# 侧另有 6 秒 TCS 兜底)
  var timeout = new Promise(function (res, rej) { setTimeout(function () { rej(new Error('timeout6s')); }, 6000); });
  Promise.race([
    fetch(url, { method: 'GET', credentials: 'include', headers: { 'accept': 'application/json, text/plain, */*' } })
      .then(function (resp) { return resp.text(); }),
    timeout
  ]).then(function (text) {
    var c = window.__dsh_classify(text);
    if (c.kind === 'json' && c.data && c.data.user && c.data.user.sec_uid && c.data.user.sec_uid.indexOf('MS4wLjAB') === 0) {
      post({ type: 'health_resp', id: ID, result: 'ok:' + c.data.user.sec_uid }); return;
    }
    if (c.kind === 'verify') { post({ type: 'health_resp', id: ID, result: 'html' }); return; }
    post({ type: 'health_resp', id: ID, result: 'no_uid' });
  }).catch(function () {
    post({ type: 'health_resp', id: ID, result: 'err' });
  });
})();
