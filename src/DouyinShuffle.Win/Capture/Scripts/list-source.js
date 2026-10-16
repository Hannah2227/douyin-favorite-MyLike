// Read-only list requests; authentication/signing stays with the existing page.
window.__dsh_listRequest = function (source, secUid, cursor, count) {
  var paths = {
    likes: '/aweme/v1/web/aweme/favorite/',
    collections: '/aweme/v1/web/aweme/listcollection/',
    recommendations: '/aweme/v1/web/familiar/recommend/feed/'
  };
  if (!Object.prototype.hasOwnProperty.call(paths, source)) throw new Error('Unknown list source');
  var p = new URLSearchParams({device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
    pc_client_type:'1', version_code:'170400', version_name:'17.4.0',
    update_version_code:'170400', cookie_enabled:'true', platform:'PC', publish_video_strategy_type:'2'});
  var options = {method:'GET', credentials:'include', headers:{accept:'application/json, text/plain, */*'}};
  if (source === 'collections') {
    // This endpoint takes cursor/count as form data, unlike the likes endpoint.
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    options.body = new URLSearchParams({cursor:String(cursor), count:String(count)}).toString();
  } else {
    p.set('sec_user_id', secUid);
    p.set('max_cursor', String(cursor));
    p.set('min_cursor', '0');
    p.set('count', String(count));
    if (source === 'recommendations') p.set('from', '1');
  }
  var m = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/);
  if (m && m[1]) p.set('msToken', decodeURIComponent(m[1]));
  return {url:'https://www.douyin.com' + paths[source] + '?' + p.toString(), options:options};
};
