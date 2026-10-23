// 主界面「按年月筛选」回归测试。
// 钉住的缺陷(2026-10 实测):年份切换会重建月份选项(只列该年有内容的月份),浏览器把选中项
// 复位到第一个 option(全部月份);旧实现另用一份变量记条件,于是"屏幕显示全部月份、列表仍按
// 旧月份过滤 → 空白"。修法:条件现读下拉框(DOM 唯一真相)。
// ★mock 保真点:<select> 的 innerHTML 被重建时把 value 复位为 '' —— 这正是触发条件。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiJs = process.env.UI_JS || path.join(__dirname, '..', 'src', 'DouyinShuffle.Win', 'WebUi', 'ui.js');   // UI_JS 可指向其他版本(用于反证测试有效性)

function makeEl(id) {
  const el = {
    id: id || '', style: {}, dataset: {}, textContent: '', title: '', value: '', disabled: false,
    checked: false, children: [], handlers: {}, onclick: null, _html: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {}, insertBefore(c) { return c; }, removeChild(c) { return c; },
    removeAttribute() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, contains() { return false; }, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get parentNode() { return null; }, scrollTop: 0, clientHeight: 400, scrollHeight: 2000
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; if (/<option/i.test(v)) el.value = ''; }   // ← 浏览器:重建 option 后选中复位
  });
  return el;
}

function loadUi() {
  const els = new Map();
  const sandbox = {
    console, JSON, Math, Date, Number, String, Object, Array, RegExp, Promise, Error, TypeError,
    isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    confirm: () => true, alert() {}, prompt() { return null; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return makeEl('q'); }, querySelectorAll() { return []; },
      addEventListener() {}, documentElement: makeEl('html'), body: makeEl('body'), hidden: false
    },
    navigator: { userAgent: 'test' }, location: { href: 'file:///index.html', protocol: 'file:' }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};
  sandbox.chrome = { webview: { postMessage() {} } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(uiJs, 'utf8'), ctx, { filename: 'ui.js' });

  const run = s => vm.runInContext(s, ctx, { filename: 'probe' });
  const num = expr => { run('globalThis.__v = (' + expr + ')'); return ctx.__v; };
  const fire = id => {
    const el = els.get(id);
    const f = el.handlers['change'] && el.handlers['change'][0];
    assert.equal(typeof f, 'function', id + ' 应挂有 change 处理器');
    f({ type: 'change', target: el });   // 按浏览器语义派发:带 target 的事件(旧实现从 e.target 取值)
  };
  const setItems = list => run('items = ' + JSON.stringify(list) + ';');
  const setSel = (id, v) => { els.get(id).value = v; };
  const selVal = id => num('document.getElementById("' + id + '").value');
  return { ctx, els, run, num, fire, setItems, setSel, selVal };
}

const ts = s => Math.floor(new Date(s).getTime() / 1000);
const ROWS = [
  { awemeId: 'a1', desc: 'D1', author: 'A', createTime: ts('2024-07-15T12:00:00'), status: 0, coverUrl: '' },
  { awemeId: 'a2', desc: 'D2', author: 'A', createTime: ts('2024-08-02T12:00:00'), status: 2, coverUrl: '' },
  { awemeId: 'a3', desc: 'D3', author: 'B', createTime: ts('2023-09-10T12:00:00'), status: 0, coverUrl: '' },
  { awemeId: 'a4', desc: 'D4', author: 'B', createTime: ts('2023-12-31T12:00:00'), status: 2, coverUrl: '' }
];

test('年月联动筛选:选年份后只列该年月份,选月份后结果正确', () => {
  const ui = loadUi();
  ui.setItems(ROWS);
  ui.setSel('year-filter', '2024');
  ui.fire('year-filter');
  assert.equal(ui.num('filtered.length'), 2, '2024 年应有 2 条');
  const monthsHtml = ui.num('document.getElementById("month-filter").innerHTML');
  assert.ok(monthsHtml.indexOf('7月') >= 0 && monthsHtml.indexOf('8月') >= 0, '月份选项应含 7/8 月');
  assert.ok(monthsHtml.indexOf('9月') < 0, '月份选项不应含 2024 年没有的 9 月');

  ui.setSel('month-filter', '7');
  ui.fire('month-filter');
  assert.equal(ui.num('filtered.length'), 1, '2024-07 应只剩 1 条');
});

test('★切到没有该月份的年份:列表不被旧月份过滤(显示与结果一致)', () => {
  const ui = loadUi();
  ui.setItems(ROWS);
  ui.setSel('year-filter', '2024');
  ui.fire('year-filter');
  ui.setSel('month-filter', '7');
  ui.fire('month-filter');
  assert.equal(ui.num('filtered.length'), 1);

  ui.setSel('year-filter', '2023');   // 2023 年没有 7 月 → 月份框回落"全部月份"
  ui.fire('year-filter');
  assert.equal(ui.selVal('month-filter'), '', '月份下拉框应回到「全部月份」');
  assert.equal(ui.num('filtered.length'), 2, '★列表应为 2023 全量(2 条),而不是被旧月份滤成 0');
});

test('★刷新后所选年份在数据里消失:年份框回落全量,列表随之为全量', () => {
  const ui = loadUi();
  ui.setItems(ROWS);
  ui.setSel('year-filter', '2023');
  ui.fire('year-filter');
  assert.equal(ui.num('filtered.length'), 2);

  ui.setItems([ROWS[0], ROWS[1]]);          // 2023 的条目被取消点赞删掉后刷新
  ui.run('renderStats(); applyFilter();');
  assert.equal(ui.selVal('year-filter'), '', '年份下拉框应回到「全部年份」');
  assert.equal(ui.num('filtered.length'), 2, '★列表应恢复为全量(2 条 2024 内容)');
});

test('分类与年月组合仍正确', () => {
  const ui = loadUi();
  ui.setItems(ROWS);
  ui.setSel('year-filter', '2023');
  ui.fire('year-filter');
  ui.run("setNav('gallery')");
  assert.equal(ui.num('filtered.length'), 1, '2023 年的图集应 1 条');
  assert.equal(ui.num('filtered[0].awemeId === "a4"'), true);
  ui.run("setNav('video')");
  assert.equal(ui.num('filtered.length'), 1, '2023 年的视频应 1 条');
  assert.equal(ui.num('filtered[0].awemeId === "a3"'), true);
  ui.run("setNav('all')");
  assert.equal(ui.num('filtered.length'), 2, '全部:2023 共 2 条');
});
