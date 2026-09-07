const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'DouyinShuffle.Win', 'Capture', 'Scripts', 'classify.js'), 'utf8');
vm.runInNewContext(script, context);

const classify = context.window.__dsh_classify;
assert.equal(classify('{"status_code":0,"aweme_list":[],"has_more":0}', 200).kind, 'json');
assert.equal(classify('{"status_code":"0","awemeList":[]}', 200).kind, 'json');
assert.equal(classify('{"user":{"sec_uid":"MS4wLjABtest"}}').kind, 'json');
assert.equal(classify('{"status_code":2190008,"status_msg":"rate limited"}', 200).kind, 'api-error');
assert.equal(classify('{"status_code":0,"aweme_list":[]}', 429).kind, 'http-error');
assert.equal(classify('{"status_code":0}', 200).list, null);

console.log('classify tests passed');
