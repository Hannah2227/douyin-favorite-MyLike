// 裸 fetch 实时取链(播放前刷新直链):在页面上下文直接请求 aweme/detail 接口
// (securitySDK 拦截器自动补签名),拿最新直链/图片/音乐。
// 不依赖页面卡片/位置,比"模拟点击卡片"更稳更快,适合每条播放前刷新。
(function () {
  var AID = '{{AID}}';
  var RID = {{RID}};   // 探测专用关联 token(null = 播放取链通道,按 awemeId 回传;非 null = 探测通道,按 token 回传)
  function post(d) {
    try { window.chrome.webview.postMessage(d); } catch (e) {}
  }
  var p = new URLSearchParams();
  p.set('device_platform', 'webapp');
  p.set('aid', '6383');
  p.set('channel', 'channel_pc_web');
  p.set('aweme_id', AID);
  p.set('min_cursor', '0');
  p.set('count', '18');
  p.set('publish_video_strategy_type', '2');
  p.set('pc_client_type', '1');
  p.set('version_code', '290100');
  p.set('version_name', '29.1.0');
  p.set('update_version_code', '170400');
  p.set('cookie_enabled', 'true');
  p.set('platform', 'PC');
  var url = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + p.toString();
  // 裸 fetch:页面拦截器自动补签名;6 秒超时防黑洞挂死(C# 侧另有 6 秒 TCS 兜底)
  var timeout = new Promise(function (res, rej) { setTimeout(function () { rej(new Error('timeout6s')); }, 6000); });
  Promise.race([
    fetch(url, { method: 'GET', credentials: 'include', headers: { 'accept': 'application/json, text/plain, */*' } })
      .then(function (r) { return r.text(); })
      .then(function (body) { post({ type: 'detail_resp', id: RID || AID, body: body }); }),
    timeout
  ]).catch(function (e) { post({ type: 'detail_resp', id: RID || AID, err: String(e) }); });
})();
