// 播放页「已取消点赞」标记的回归测试。
// 钉住两个曾经的缺陷(2026-10 实测复现):
//  ① 单槽位序号记录被下一次取消覆盖 → 连续取消几条后,回到早先取消过的那条又能再取消;
//  ② 回执按"回执到达时的条目"归位 → 执行期间切歌会误标新条目。
// 手法:mock DOM 里加载 player.html 的内联脚本,只观察按钮行为(文案/禁用态),不碰内部变量。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const playerHtml = path.join(__dirname, '..', 'src', 'DouyinShuffle.Win', 'WebUi', 'player.html');

function makeEl(id) {
  return {
    id: id || '', style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', value: '',
    disabled: false, children: [], handlers: {}, onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { return c; }, removeChild(c) { return c; },
    removeAttribute() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, pause() {}, load() {}, play() { return { catch() {} }; },
    contains() { return false; }, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get parentNode() { return null; }, scrollTop: 0, clientHeight: 300, scrollHeight: 1000,
    videoWidth: 1080, videoHeight: 1920, duration: 60, currentTime: 0, paused: true
  };
}

function loadPlayer() {
  const html = fs.readFileSync(playerHtml, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'player.html 应含内联脚本');
  const posted = [];
  const els = new Map();
  const sandbox = {
    console, JSON, Math, Date, Number, String, Object, Array, RegExp, Promise, Error, TypeError,
    isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    confirm: () => true, alert() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Audio: function () { return makeEl('audio'); },
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, documentElement: makeEl('html'), body: makeEl('body'), hidden: false
    },
    navigator: { userAgent: 'test' }, location: { href: 'file:///player.html', protocol: 'file:' }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};
  sandbox.chrome = { webview: { postMessage(d) { posted.push(typeof d === 'string' ? d : JSON.stringify(d)); } } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(m[1], ctx, { filename: 'player.html:inline' });

  const show = (idx, id) => ctx.__dshPlayerShow({
    id: id, index: idx, total: 10, urls: ['http://v/' + idx], images: [], liveImages: null,
    music: '', title: 't' + idx, author: 'a', time: '', resume: 0, autoNext: false
  });
  const btn = () => els.get('dsh-unlike');
  const clickUnlike = () => {
    const b = btn();
    const f = b.onclick || (b.handlers['click'] && b.handlers['click'][0]);
    assert.equal(typeof f, 'function', '取消点赞按钮应挂有处理器');
    f({ stopPropagation() {} });
  };
  return { ctx, posted, show, btn, clickUnlike };
}

test('连续取消多条后,回到早先取消过的那条仍显示「已取消」(按条目记忆)', () => {
  const p = loadPlayer();
  p.show(5, 'aweme-A'); p.clickUnlike(); p.ctx.__dshUnlikeDone(true, '已取消');
  assert.equal(p.btn().disabled, true, 'A 取消后应置灰');
  assert.equal(p.btn().textContent, '已取消');

  p.show(6, 'aweme-B');
  assert.equal(p.btn().disabled, false, '未取消过的 B 应可点');
  p.clickUnlike(); p.ctx.__dshUnlikeDone(true, '已取消');
  assert.equal(p.btn().disabled, true, 'B 取消后应置灰');

  p.show(5, 'aweme-A');
  assert.equal(p.btn().disabled, true, '★回到早先取消过的 A:必须仍置灰(单槽位记录会在此失效)');
  assert.equal(p.btn().textContent, '已取消');

  p.show(6, 'aweme-B');
  assert.equal(p.btn().disabled, true, '★回到 B:仍置灰');
});

test('回执按发起条目归位:执行期间切歌不误标新条目', () => {
  const p = loadPlayer();
  p.show(5, 'aweme-A');
  p.clickUnlike();                 // 发起 A 的取消(回执未到)
  assert.ok(p.posted.some(s => s.indexOf('aweme-A') >= 0), '请求应带条目 id');
  p.show(6, 'aweme-B');            // 回执到达前切到 B
  assert.equal(p.btn().disabled, true, '在途期间全局禁用(防二次请求)');
  p.ctx.__dshUnlikeDone(true, '已取消');   // 回执此时才到
  assert.equal(p.btn().disabled, false, '★B 未被取消,不应被误标为已取消');
  p.show(5, 'aweme-A');
  assert.equal(p.btn().disabled, true, '★A 才是被取消的那条,应置灰');
});

test('取消失败(ok=false)不落标记,允许重试', () => {
  const p = loadPlayer();
  p.show(5, 'aweme-A');
  p.clickUnlike();
  p.ctx.__dshUnlikeDone(false, '取消失败:接口无响应');
  assert.equal(p.btn().disabled, false, '失败后应可重试');
  assert.equal(p.btn().textContent, '取消点赞');
});
