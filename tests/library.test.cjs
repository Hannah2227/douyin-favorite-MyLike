const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '../src/DouyinShuffle.Win/WebUi');
const library = require(path.join(web, 'library.js'));
const ts = (value) => new Date(value).getTime() / 1000;
const rows = [
  { awemeId: '3', author: 'Alice', desc: 'C', createTime: ts('2026-02-01T00:00:00'), status: 0 },
  { awemeId: '1', author: 'Bob', desc: 'A', createTime: ts('2026-01-31T23:59:59'), status: 2 },
  { awemeId: '2', author: 'Alice', desc: 'B', createTime: ts('2026-01-01T00:00:00'), status: 0 },
  { awemeId: '4', author: 'Alice', desc: 'D', createTime: ts('2026-02-01T12:00:00'), status: 1 },
];
const ids = values => values.map(i => i.awemeId);

test('sorts in all four modes without mutating the source', () => {
  assert.deepEqual(ids(library.sortItems(rows, 'newest')), ['4', '3', '1', '2']);
  assert.deepEqual(ids(library.sortItems(rows, 'oldest')), ['2', '1', '3', '4']);
  assert.deepEqual(ids(library.sortItems(rows, 'author')), ['4', '3', '2', '1']);
  assert.deepEqual(ids(library.sortItems(rows, 'title')), ['1', '2', '3', '4']);
  assert.deepEqual(ids(rows), ['3', '1', '2', '4']);
});
test('sort handles missing metadata and resolves ties deterministically', () => {
  const entries = [{ awemeId: '10' }, { awemeId: '2' }];
  for (const order of ['newest', 'oldest', 'author', 'title'])
    assert.deepEqual(ids(library.sortItems(entries, order)), ['2', '10']);
});
test('multiple authors are exact OR matches and empty author matches nothing', () => {
  assert.deepEqual(library.batchIds(rows, 'author', {}, ['Alice', 'Bob']), ['3', '1', '2']);
  assert.deepEqual(library.batchIds(rows, 'author', {}, ['Ali']), []);
  assert.deepEqual(library.batchIds(rows, 'author', {}, []), []);
});
test('local date range includes both entire boundary days across months', () => {
  const range = library.dateRange('2026-01-31', '2026-02-01');
  assert.equal(range.start, ts('2026-01-31T00:00:00'));
  assert.equal(range.end, ts('2026-02-01T23:59:59'));
  assert.deepEqual(library.batchIds(rows, 'time', range, []), ['3', '1']);
  assert.deepEqual(library.batchIds(rows, 'time', library.dateRange('', '2026-01-31'), []), ['1', '2']);
});
test('invalid or reversed dates cannot silently widen the batch', () => {
  assert.throws(() => library.dateRange('2026-02-02', '2026-02-01'));
  assert.throws(() => library.dateRange('2026-02-30', ''));
  assert.throws(() => library.dateRange('invalid', ''));
  assert.deepEqual(library.dateRange('', ''), { start: 0, end: 0 });
});

// Run the real UI handlers with a minimal DOM; never contact Douyin.
function ui() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return { value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, handlers: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c),
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      querySelector: () => null, insertAdjacentHTML() {} };
  }
  for (const [, id] of fs.readFileSync(path.join(web, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g))
    elements.set(id, element());
  const radios = { scope: 'all', mode: 'selective' };
  const attributes = {};
  const document = { documentElement: { setAttribute: (key, value) => { attributes[key] = value; } },
    getElementById: id => elements.get(id), querySelectorAll: () => [], addEventListener() {},
    querySelector(selector) {
      if (selector.includes('ub-scope')) return { value: radios.scope };
      if (selector.includes('ub-mode')) return { value: radios.mode };
      return element();
    } };
  const context = vm.createContext({ document, window: { addEventListener() {} }, console,
    setTimeout: () => 0, clearTimeout() {}, confirm: () => { throw new Error('Unexpected confirmation'); } });
  vm.runInContext(fs.readFileSync(path.join(web, 'library.js'), 'utf8'), context);
  context.MyLikeLibrary = context.window.MyLikeLibrary;
  vm.runInContext(fs.readFileSync(path.join(web, 'ui.js'), 'utf8'), context);
  const run = source => vm.runInContext(source, context);
  run(`items = ${JSON.stringify(rows)};`);
  return { elements, radios, run, attributes, click: id => elements.get(id).handlers.click() };
}
test('selective author scope replaces stale filters and selections with exact preview', () => {
  const app = ui();
  app.radios.scope = 'author';
  app.elements.get('ub-author').value = 'Alice, Bob';
  app.run("selected.add('4'); searchText = 'stale'; yearFilter = '2000'; navFilter = 'gallery'; ubApplySelective();");
  assert.equal(app.run('JSON.stringify(filtered.map(i => i.awemeId))'), '["3","1","2"]');
  assert.equal(app.run('selected.size'), 0);
  assert.equal(app.elements.get('scope-bar').classList.contains('hidden'), false);
  app.click('btn-select-all');
  app.run("searchText = 'Bob'; applyFilter();");
  assert.equal(app.run('JSON.stringify([...selected])'), '["1"]');
  app.click('btn-clear-scope');
  assert.equal(app.run('batchScopeIds'), null);
  assert.equal(app.run('selected.size'), 0);
});
test('selective date scope retains exact cross-month boundaries', () => {
  const app = ui();
  app.radios.scope = 'time';
  app.elements.get('ub-time-start').value = '2026-01-31';
  app.elements.get('ub-time-end').value = '2026-02-01';
  app.run('ubApplySelective();');
  assert.equal(app.run('JSON.stringify(filtered.map(i => i.awemeId))'), '["3","1"]');
});
test('sort handler passes visible order to playback and retains visible selection', () => {
  const app = ui();
  app.run("selected.add('3'); selectMode = true; applyFilter();");
  app.elements.get('sort-order').handlers.change({ target: { value: 'oldest' } });
  app.run("call = (cmd, ...args) => { window.lastCall = { cmd, args }; return Promise.resolve('ok'); }; playVideo('2');");
  assert.equal(app.run('JSON.stringify(window.lastCall.args[1])'), '["2","1","3","4"]');
  assert.equal(app.run('selected.has("3")'), true);
  assert.match(app.elements.get('list-info').textContent, /已选 1/);
});
test('invalid dates and empty authors disable the batch start button', () => {
  const app = ui();
  app.radios.scope = 'time';
  app.elements.get('ub-time-start').value = '2026-03-02';
  app.elements.get('ub-time-end').value = '2026-03-01';
  app.run('ubUpdatePreview();');
  assert.equal(app.elements.get('ub-start').disabled, true);
  app.click('ub-start'); // Must return before confirmation or a host request.
  app.radios.scope = 'author';
  app.run('ubUpdatePreview();');
  assert.equal(app.elements.get('ub-start').disabled, true);
});

test('upstream theme updates coexist with sorting and batch scope', () => {
  const app = ui();
  app.radios.scope = 'author';
  app.elements.get('ub-author').value = 'Alice';
  app.run("ubApplySelective(); sortOrder = 'oldest'; applyFilter(); window.__dsh_setTheme('dark');");
  assert.equal(app.attributes['data-theme'], 'dark');
  assert.equal(app.run('JSON.stringify(filtered.map(i => i.awemeId))'), '["2","3"]');
  app.run("window.__dsh_setTheme('light');");
  assert.equal(app.attributes['data-theme'], 'light');
});

test('a rebuilt account page starts without the previous account batch selection', () => {
  const oldAccount = ui();
  oldAccount.run("ubApplySelective(); selected.add('3');");
  const newAccount = ui();
  assert.equal(newAccount.run('batchScopeIds'), null);
  assert.equal(newAccount.run('selected.size'), 0);
  assert.equal(newAccount.run('selectMode'), false);
});

test('merged page has unique IDs and contains both account and batch controls', () => {
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const elementIds = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(elementIds).size, elementIds.length);
  for (const id of ['account-modal', 'btn-theme', 'resume-bar', 'unlike-batch-modal', 'sort-order', 'scope-bar'])
    assert.ok(elementIds.includes(id), `Missing ${id}`);
  assert.ok(html.indexOf('src="library.js"') < html.indexOf('src="ui.js"'));
});
