// 共享响应分类器:所有采集/探测脚本统一判定接口响应的形态,杜绝各脚本各自判断导致的漏判
// (如"假数据":JSON 但列表为空+has_more=true,旧实现误判为有效响应 → 空翻页数分钟)。
// 由 ScriptLoader 自动注入到所有采集脚本头部(用后即弃,不影响页面全局)。
// 形态:
//   json      → 合法的业务成功 JSON,附带 data / list / hasMore 供调用方直接使用
//   verify    → HTML 验证页(风控形态 A:需要滑块)
//   bad-json  → 以 { 开头但解析失败(异常响应)
//   http-error / api-error → HTTP 或业务状态失败
//   error     → 空响应/超时(null body)
//   other     → 其他非 JSON 文本
window.__dsh_classify = function (body, status) {
  if (!body || typeof body !== 'string') return { kind: 'error', status: status || 0 };
  var t = body.trim();
  if (t.charAt(0) === '{') {
    try {
      var d = JSON.parse(t);
      if (status && (status < 200 || status >= 300)) return { kind: 'http-error', status: status, data: d };
      if (d.status_code != null && d.status_code !== 0 && d.status_code !== '0') return { kind: 'api-error', status: status || 0, data: d };
      var list = Array.isArray(d.aweme_list) ? d.aweme_list : (Array.isArray(d.awemeList) ? d.awemeList : null);
      return { kind: 'json', status: status || 0, data: d, list: list, hasMore: !!d.has_more };
    } catch (e) { return { kind: 'bad-json', status: status || 0 }; }
  }
  if (/<html[\s>]/i.test(t.slice(0, 300))) return { kind: 'verify', status: status || 0 };
  return { kind: 'other', status: status || 0 };
};
