const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.join(__dirname, '../src/DouyinShuffle.Win/Capture/Scripts');
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const context = {window:{}, document:{cookie:''}, URLSearchParams};
vm.runInNewContext(read('list-source.js'), context);
for (const [source, endpoint] of Object.entries({likes:'/aweme/v1/web/aweme/favorite/', collections:'/aweme/v1/web/aweme/listcollection/', recommendations:'/aweme/v1/web/familiar/recommend/feed/'})) {
  const r = context.window.__dsh_listRequest(source, 'account123', 1234, 18);
  const u = new URL(r.url);
  assert.equal(u.origin, 'https://www.douyin.com');
  assert.equal(u.pathname, endpoint);
  assert.equal(r.options.credentials, 'include');
  if (source === 'collections') {
    assert.equal(r.options.method, 'POST');
    assert.equal(new URLSearchParams(r.options.body).get('cursor'), '1234');
    assert.equal(new URLSearchParams(r.options.body).get('count'), '18');
  } else {
    assert.equal(r.options.method, 'GET');
    assert.equal(u.searchParams.get('max_cursor'), '1234');
    assert.equal(u.searchParams.get('sec_user_id'), 'account123');
  }
}
assert.throws(() => context.window.__dsh_listRequest('feed', '', 0, 1));
assert.throws(() => context.window.__dsh_listRequest('__proto__', '', 0, 1));

async function paginate(source, pages, known = null) {
  const requests = [], messages = [];
  let finish;
  const done = new Promise(resolve => finish = resolve);
  const c = {window:{chrome:{webview:{postMessage(m) { messages.push(m); if(m.type==='direct_done')finish(m); }}}},
    document:{cookie:''}, URLSearchParams,
    setTimeout(fn, delay) { if(delay < 6000) queueMicrotask(fn); },
    fetch:async (url, options) => {
      requests.push({url,options});
      const page = pages[requests.length-1];
      assert.ok(page, 'unexpected extra page');
      return {status:200,text:async()=>JSON.stringify(page)};
    }};
  const loop = read('paged-loop.js').replaceAll('{{SEC_USER_ID}}','account123')
    .replaceAll('{{START_CURSOR}}','0').replaceAll('{{KNOWN_IDS}}',JSON.stringify(known))
    .replaceAll('{{RESUME_MODE}}','0').replaceAll('{{LIST_SOURCE}}',source);
  vm.runInNewContext(read('list-source.js')+'\n'+read('classify.js')+'\n'+loop,c);
  const result = await done;
  return {result,requests,messages};
}

(async () => {
  for (const source of ['likes','collections','recommendations']) {
    const cursorKey = source === 'collections' ? 'cursor' : 'max_cursor';
    const output = await paginate(source,[
      {status_code:0,aweme_list:[{aweme_id:'1'}],has_more:1,[cursorKey]:123},
      {status_code:0,aweme_list:[{aweme_id:'2'}],has_more:'0',[cursorKey]:0}
    ]);
    assert.equal(output.result.reason,'complete');
    assert.equal(output.requests.length,2);
    const second = output.requests[1];
    assert.equal(source==='collections' ? new URLSearchParams(second.options.body).get('cursor') : new URL(second.url).searchParams.get('max_cursor'),'123');
    assert.equal(output.messages.filter(m=>m.type==='direct_resp').length,2);
  }
  const incremental = await paginate('collections',[{status_code:0,aweme_list:[{aweme_id:'existing'}],has_more:1,cursor:99}],{existing:1});
  assert.equal(incremental.result.reason,'incremental');
  const failed = await paginate('recommendations',[{status_code:2190008},{status_code:2190008}]);
  assert.equal(failed.result.reason,'notready');
  assert.equal(failed.messages.filter(m=>m.type==='direct_resp').length,0);
  console.log('list source requests, pagination, incremental sync and failure tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
