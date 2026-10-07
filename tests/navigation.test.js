/** Source contracts and event doubles. Not real-browser layout/keyboard QA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {renderNavigation,bindNavigationTooltips} from '../src/lib/navigation.js';
import {navigationHeight,pageCapacity,habitPageCapacity} from '../src/lib/workspace.js';
const routes={home:{label:'ホーム',icon:'home'},running:{label:'ランニング',icon:'run'},wake:{label:'早起き',icon:'sun'},habits:{label:'習慣',icon:'habits'},calendar:{label:'カレンダー',icon:'calendar'},diary:{label:'日記',icon:'book'},garden:{label:'暮らしの庭',icon:'leaf'},settings:{label:'設定',icon:'settings'}};
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
const palette=readFileSync(new URL('../src/palette.css',import.meta.url),'utf8');
for(const current of Object.keys(routes))test(`${current}: all eight equal links have accessible names and one selected non-color marker`,()=>{
  const html=renderNavigation(routes,current);
  assert.match(html,/^<nav id="page-navigation" class="page-navigation" aria-label="メインナビゲーション">/);
  assert.deepEqual([...html.matchAll(/href="#([^"]+)"/g)].map(m=>m[1]),Object.keys(routes));
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
  for(const [key,route] of Object.entries(routes)){
    const link=html.match(new RegExp(`<a class="page-link" data-route="${key}"[\\s\\S]*?</a>`))?.[0];
    assert.ok(link,`${key} is a main link`);
    assert.ok(link.includes(`aria-label="${route.label}"`));
    assert.equal(link.includes('aria-current="page"'),key===current);
    assert.match(link,/<svg[^>]*aria-hidden="true"/);
    assert.match(link,/<span class="page-current" aria-hidden="true"><\/span>/);
    assert.match(link,/<span class="page-tooltip" role="tooltip" aria-hidden="true">[^<]+<\/span>/);
    assert.doesNotMatch(link,/(?:tabindex|role="(?:tab|button)"|aria-selected|aria-expanded)=/);
  }
  assert.doesNotMatch(html,/sidebar|divider|secondary|<button/);
});
test('navigation escapes labels and hrefs and uses no persistent text nodes besides hidden tooltips',()=>{
  const html=renderNavigation({'evil"':{label:'<script> & "',icon:'home'}},'evil"');
  assert.doesNotMatch(html,/<script>|data-route="evil""/);
  assert.match(html,/&lt;script&gt; &amp; &quot;/);
  const ordinary=renderNavigation(routes,'home').replace(/<span class="page-tooltip"[^>]*>[^<]*<\/span>/g,'').replace(/<[^>]+>/g,'');
  assert.equal(ordinary,'');
});
test('sidebar module, state/controller hooks and all obsolete shell CSS are removed',()=>{
  assert.equal(existsSync(new URL('../src/lib/sidebar.js',import.meta.url)),false);
  for(const text of [source,css,palette])assert.doesNotMatch(text,/sidebar|desktop-breadcrumb|mobile-brand|nav-divider/);
  assert.match(source,/<header class="topbar">[\s\S]*renderNavigation\(routes,current\)[\s\S]*<\/header><main/);
  assert.match(css,/\.workspace\s*\{[^}]*height:100%[^}]*display:flex/);
  assert.match(css,/main\s*\{\s*width:100%;\s*max-width:(?:none|1680px)/);
});
test('CSS explicitly keeps touch targets, icon marker, focusable tooltips and brand nowrap',()=>{
  assert.match(css,/\.page-link\s*\{[^}]*min-width:44px[^}]*min-height:44px/);
  assert.match(css,/\.page-link\[aria-current="page"\] \.page-current\s*\{[^}]*visibility:visible/);
  for(const state of ['hover','focus-visible'])assert.ok(css.includes(`.page-link:${state} .page-tooltip`));
  assert.match(css,/\.page-link\[data-tooltip-dismissed\] \.page-tooltip\s*\{[^}]*visibility:hidden/);
  for(const selector of ['.topbar-brand','.topbar-brand span'])assert.ok(new RegExp(selector.replaceAll('.','\\.')+'\\s*\\{[^}]*white-space:nowrap').test(css));
  assert.match(css,/@media \(forced-colors:active\)[\s\S]*(?:border-color:Highlight|outline:2px solid Highlight)/);
});
test('responsive grid math reserves every 44px target across mobile and laptop boundaries (not layout measurement)',()=>{
  for(const width of [320,360,390,419,420,600,601,759,760,768,1024,1366,1440,1920,2560]){
    const columns=width<=419?4:8;
    const available=width-(width<=759?24:48);
    const minimum=columns*44+(columns-1)*4;
    assert.ok(available>=minimum,`${width}: icon grid fits declared padding`);
    if(width>=760)assert.ok(available>=minimum+100+110+40,'desktop also reserves brand, status, and gaps');
    assert.equal(navigationHeight(width),width<=419?144:width<=759?96:56);
    for(const height of [390,568,700,768,844,1080]){
      assert.ok(pageCapacity(width,height)>=1&&pageCapacity(width,height)<=7);
      assert.ok(habitPageCapacity(width,height)>=1&&habitPageCapacity(width,height)<=3);
    }
  }
  assert.match(css,/grid-template-columns:repeat\(8,44px\)/);
  assert.match(css,/@media \(max-width:759px\)[\s\S]*flex-basis:96px/);
  assert.match(css,/@media\s*\(max-width:\s*419px\)[\s\S]*flex-basis:144px[\s\S]*repeat\(4,minmax\(44px,1fr\)\)/);
  assert.ok(pageCapacity(390,800)<pageCapacity(420,800));
});
function tooltips(){
  const events=new Map(),attrs=new Map();
  const link={setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),contains:n=>n===link};
  const target={closest:selector=>selector==='#page-navigation .page-link'?link:null};
  bindNavigationTooltips({addEventListener:(type,handler)=>events.set(type,handler)});
  return {attrs,link,target,emit:(type,event)=>events.get(type)(event)};
}
test('Escape dismisses a tooltip without preventing native navigation or touching the app',()=>{
  const ui=tooltips();
  ui.emit('keydown',{key:'Escape',target:ui.target});
  assert.equal(ui.attrs.get('data-tooltip-dismissed'),'true');
  ui.emit('focusout',{target:ui.target});assert.equal(ui.attrs.size,0);
  ui.emit('keydown',{key:'Enter',target:ui.target});assert.equal(ui.attrs.size,0);
  ui.emit('keydown',{key:'Escape',target:{}});assert.equal(ui.attrs.size,0);
});
test('tooltip dismissal lasts within its link and resets after pointer leaves',()=>{
  const ui=tooltips();
  ui.emit('keydown',{key:'Escape',target:ui.target});
  ui.emit('pointerout',{target:ui.target,relatedTarget:ui.link});assert.equal(ui.attrs.size,1);
  ui.emit('pointerout',{target:ui.target,relatedTarget:null});assert.equal(ui.attrs.size,0);
});

test('Escape also dismisses mouse-hover names while keyboard focus is outside navigation',()=>{
  const attrs=new Map(),link={setAttribute:(k,v)=>attrs.set(k,v)},events=new Map();
  bindNavigationTooltips({addEventListener:(type,handler)=>events.set(type,handler),querySelectorAll:selector=>{assert.match(selector,/:hover/);return [link];}});
  events.get('keydown')({key:'Escape',target:{}});
  assert.equal(attrs.get('data-tooltip-dismissed'),'true');
});
test('toasts are centered in the sidebar-free viewport',()=>{
  assert.doesNotMatch(css,/left:calc\(50% \+ 108px\)/);
  assert.match(css,/\.toast\s*\{[^}]*left:50%/);
});

test('taller mobile header reserves content minima instead of clipping record buttons',()=>{
  assert.match(css,/@media\s*\(max-width:900px\)[\s\S]*\.home-dashboard-grid[^}]*grid-template-columns:1fr/);
  assert.match(css,/\.btn\s*\{[^}]*min-height:44px/);
  assert.match(css,/\.view-stage\s*\{[^}]*min-height:0[^}]*overflow:auto/);
});
