const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const elements = new Map();
function element(id) {
  if(!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {id,value:'',textContent:'',style:{},dataset:{},children:[],
      classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,on){if(on===undefined)on=!classes.has(k);on?classes.add(k):classes.delete(k);}},
      setAttribute(){},addEventListener(){},appendChild(){},querySelectorAll:()=>[],
      get innerHTML(){return '';},set innerHTML(v){} });
  }
  return elements.get(id);
}
const sources = ['likes','collections','recommendations'].map(key=>{const el=element('source-'+key);el.dataset.source=key;return el;});
const commands=[];
const c={console,setTimeout:()=>0,clearTimeout(){},localStorage:{getItem:()=>null,setItem(){}},
  document:{getElementById:element,querySelector:()=>element('search'),querySelectorAll:()=>sources,
    addEventListener(){},removeEventListener(){},documentElement:element('root'),body:element('body')},
  window:{addEventListener(){},chrome:{webview:{postMessage(m){commands.push(m);queueMicrotask(()=>c.window.__dsh_respond(m.id,
    m.cmd==='setSource'?'ok':m.cmd==='list'?'[]':m.cmd==='resumeInfo'?'null':null));}}}},
  IntersectionObserver:class{observe(){}},requestAnimationFrame:fn=>fn()};
vm.createContext(c);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/DouyinShuffle.Win/WebUi/ui.js'),'utf8'),c);
(async()=>{
  await vm.runInContext("switchSource('collections')",c);
  assert.equal(element('source-heading').textContent,'我的收藏');
  assert.equal(element('btn-unlike').style.display,'none');
  assert.equal(element('source-collections').classList.contains('active'),true);
  await vm.runInContext("switchSource('recommendations')",c);
  assert.equal(element('source-heading').textContent,'我推荐过的作品');
  assert.equal(commands.filter(m=>m.cmd==='setSource').length,2);
  vm.runInContext('collecting = true',c);
  await vm.runInContext("switchSource('likes')",c);
  assert.equal(commands.filter(m=>m.cmd==='setSource').length,2,'must not switch while collecting');
  vm.runInContext('collecting = false',c);
  await vm.runInContext("switchSource('likes')",c);
  assert.equal(element('btn-unlike').style.display,'');
  assert.equal(element('source-heading').textContent,'我的喜欢');
  assert.ok(sources.every(el=>!el.disabled),'buttons must unlock');
  console.log('Source UI switching, labels, unlike visibility and busy guard passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
