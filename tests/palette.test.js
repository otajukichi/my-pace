/** Source-level cascade and WCAG color checks, not browser rendering or an
 * accessibility certification. The small resolver covers the selectors used
 * in these fixtures; viewport geometry and native controls still need browser QA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderWake} from '../src/views/wake.js';
import {renderRunning} from '../src/views/running.js';
import {renderDashboard} from '../src/views/dashboard.js';
import {createInitialState} from '../src/lib/domain.js';
import {wakeChart,runChart} from '../src/lib/charts.js';

const original=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
const palette=readFileSync(new URL('../src/palette.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const minimums={text:Infinity,graphics:Infinity};

// Read ordinary rules. Media queries are deliberately excluded: the new layer
// has no responsive colors, and forced-colors behavior is checked separately.
function parseRules(css){
  css=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const rules=[];let start=0;
  while(start<css.length){
    const open=css.indexOf('{',start);if(open<0)break;
    const selector=css.slice(start,open).trim();let end=open+1,depth=1;
    for(;end<css.length&&depth;end++){if(css[end]==='{')depth++;if(css[end]==='}')depth--;}
    assert.equal(depth,0,'balanced CSS blocks');
    if(!selector.startsWith('@')){
      const declarations=css.slice(open+1,end-1).split(';').map(s=>{
        const colon=s.indexOf(':');if(colon<0)return null;
        const value=s.slice(colon+1).trim();
        return {property:s.slice(0,colon).trim(),value:value.replace(/\s*!important\s*$/,''),important:/!important\s*$/.test(value)};
      }).filter(Boolean);
      for(const part of selector.split(','))rules.push({selector:part.trim(),declarations});
    }
    start=end;
  }
  return rules;
}
const rules=parseRules(original+'\n'+palette);
const make=(tag,classes='',parent=null,attrs={},states=[],pseudo='')=>({tag,classes:classes.split(' ').filter(Boolean),parent,attrs,states,pseudo});
function simpleMatches(selector,node){
  if(!node)return false;
  let ok=true;
  selector=selector.replace(/:not\(([^)]+)\)/g,(_,inner)=>{if(simpleMatches(inner,node))ok=false;return '';});
  selector=selector.replace(/::([\w-]+)/g,(_,pseudo)=>{if(node.pseudo!==pseudo)ok=false;return '';});
  if(node.pseudo&&!/::/.test(arguments[0]))return false;
  selector=selector.replace(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g,(_,name,value)=>{if(!(name in node.attrs)||(value!==undefined&&node.attrs[name]!==value))ok=false;return '';});
  selector=selector.replace(/\.([\w-]+)/g,(_,name)=>{if(!node.classes.includes(name))ok=false;return '';});
  selector=selector.replace(/#([\w-]+)/g,(_,name)=>{if(node.attrs.id!==name)ok=false;return '';});
  selector=selector.replace(/:([\w-]+)(?:\([^)]*\))?/g,(_,name)=>{if(name==='root'?!node.root:!node.states.includes(name))ok=false;return '';});
  return ok&&(!selector||selector==='*'||selector===node.tag);
}
function matches(selector,node){
  const parts=selector.replace(/\s*>\s*/g,' > ').trim().split(/\s+/);
  function from(index,current){
    if(!simpleMatches(parts[index],current))return false;
    if(index===0)return true;
    if(parts[index-1]==='>')return from(index-2,current.parent);
    for(let parent=current.parent;parent;parent=parent.parent)if(from(index-1,parent))return true;
    return false;
  }
  return from(parts.length-1,node);
}
function specificity(selector){
  selector=selector.replace(/:not\(([^)]+)\)/g,'$1');
  const ids=(selector.match(/#[\w-]+/g)||[]).length;
  const pseudos=(selector.match(/::[\w-]+/g)||[]).length;
  selector=selector.replace(/::[\w-]+/g,'');
  const parts=(selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g)||[]).length;
  const tags=(selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g,'').match(/[\w-]+/g)||[]).length;
  return ids*10000+parts*100+tags+pseudos;
}
function declaration(node,property){
  let winner=null;
  for(const rule of rules){
    if(!matches(rule.selector,node))continue;
    for(const d of rule.declarations){
      if(d.property!==property)continue;
      const score=Number(d.important)*1000000+specificity(rule.selector);
      if(!winner||score>=winner.score)winner={...d,score};
    }
  }
  return winner?.value;
}
function value(node,property){
  const result=declaration(node,property);
  if(result===undefined||result==='inherit')return node.parent?value(node.parent,property):undefined;
  return result.replace(/var\((--[\w-]+)\)/g,(_,token)=>value(node,token));
}
function foreground(node){return value(node,'color')||'#182638';}
function background(node){
  if(!node)return '#ffffff';
  const bg=declaration(node,'background-color')||declaration(node,'background');
  if(!bg||bg==='transparent')return background(node.parent);
  return bg.replace(/var\((--[\w-]+)\)/g,(_,token)=>value(node,token));
}
function rgb(hex){
  if(hex==='white')hex='#ffffff';if(hex==='black')hex='#000000';
  assert.match(hex,/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i,`opaque tested color ${hex}`);
  let s=hex.slice(1);if(s.length===3)s=[...s].map(c=>c+c).join('');
  return [0,2,4].map(i=>parseInt(s.slice(i,i+2),16)/255);
}
function luminance(hex){return rgb(hex).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function check(a,b,kind,label){const ratio=contrast(a,b),min=kind==='text'?4.5:3;minimums[kind]=Math.min(minimums[kind],ratio);assert.ok(ratio>=min,`${label}: ${a} / ${b} = ${ratio.toFixed(2)}:1, expected ${min}:1`);return ratio;}
function textCheck(node,label){check(foreground(node),background(node),'text',label);}
function rootFor(page){const root=make('html','',null,{'data-page':page});root.root=true;return root;}

test('palette loads after the existing layout, uses complete route tokens, and remains presentation-only',()=>{
  assert.ok(html.indexOf('./src/palette.css')>html.indexOf('./src/style.css'));
  for(const page of ['home','running','wake','habits','calendar','diary','garden','settings']){
    const root=rootFor(page);
    for(const token of ['--accent','--accent-dark','--accent-soft','--accent-hover','--accent-ink'])assert.match(value(root,token),/^#[a-f\d]{6}$/);
  }
  for(const token of ['--sky','--apricot','--forest','--slate','--lilac','--sage','--plum','--ochre'])assert.match(value(rootFor('home'),token),/^#[a-f\d]{6}$/);
  assert.doesNotMatch(palette,/(?:^|[;{])\s*(?:width|height|min-width|max-width|display|position|overflow|margin|padding|font-size)\s*:/);
  assert.match(original+'\n'+palette,/@media\s*\(forced-colors:\s*active\)/);
});

for(const page of ['home','running','wake','habits','calendar','diary','garden','settings']){
  test(`${page}: source-resolved shell, text and control state contrast`,()=>{
    const root=rootFor(page),body=make('body','',root),main=make('main','',body),card=make('section','card',main);
    textCheck(body,'body');textCheck(card,'card');
    for(const surface of [card,make('section','card wake-focus',main),make('div','diary-paper',card)]){
      for(const [tag,classes] of [['p','hint'],['p','hero-caption'],['p','hero-note'],['p','empty'],['div','card-eyebrow'],['a','text-link'],['button','text-link danger'],['strong','hero-time'],['span','muted']])textCheck(make(tag,classes,surface),`${page} ${classes}`);
      check(value(root,'--focus'),background(surface),'graphics',`${page} focus on surface`);
    }
    const header=make('header','topbar',body),nav=make('nav','page-navigation',header);
    for(const states of [[],['hover']]){
      textCheck(make('a','page-link',nav,{},states),'inactive navigation');
      const selected=make('a','page-link',nav,{'aria-current':'page'},states);
      textCheck(selected,'current navigation');
      check(background(make('span','page-current',selected)),background(selected),'graphics','selected underline');
      textCheck(make('span','page-tooltip',selected),'page name tooltip');
      for(const classes of ['btn primary','btn secondary','btn ghost','icon-button']){
        textCheck(make('button',classes,card,{},states),`${classes} ${states}`);
        const disabled=make('button',classes,card,{disabled:''},['disabled',...states]);
        textCheck(disabled,`${classes} disabled ${states}`);
        assert.equal(background(disabled),value(root,'--disabled-bg'),'disabled background does not turn active on hover');
        assert.equal(value(disabled,'opacity'),'1');
      }
      const tabs=make('nav','view-tabs',main),segments=make('div','segmented',card);
      for(const pressed of ['true','false'])for(const group of [tabs,segments])textCheck(make('button','',group,{'aria-pressed':pressed},states),'tab or segment');
      textCheck(make('button','calendar-day',card,{},states),'calendar date');
      textCheck(make('button','calendar-day outside-month',card,{},states),'outside date');
      textCheck(make('button','calendar-day is-selected outside-month',card,{},states),'selected outside date');
    }
    const field=make('label','field',card);
    for(const tag of ['input','select','textarea']){
      const input=make(tag,'',field);textCheck(input,tag);
      check(value(input,'border-color'),background(input),'graphics','input border');
      textCheck(make(tag,'',field,{disabled:''},['disabled']),`${tag} disabled`);
      if(tag!=='select')textCheck(make(tag,'',field,{},[],'placeholder'),`${tag} placeholder`);
    }
    const readonly=make('input','',field,{readonly:''});textCheck(readonly,'readonly distance');
    const toast=make('div','toast',body);textCheck(toast,'toast');
    textCheck(make('button','toast-undo',toast),'toast undo');textCheck(make('button','toast-close',toast),'toast close');
    for(const cls of ['form-error','error-banner','hint warning'])textCheck(make('p',cls,card),cls);
  });
  test(`${page}: chart, progress, selected calendar markers and small habit date contrast`,()=>{
    const root=rootFor(page),card=make('section','card',root),chart=make('div','chart-wrap',card),svg=make('svg','',chart);
    check(value(make('text','',svg),'fill'),background(card),'text','chart labels');
    for(const [tag,cls,property] of [['path','chart-line','stroke'],['circle','chart-dot','fill'],['line','chart-target','stroke'],['rect','run-bar','fill'],['rect','run-bar-empty','fill']])check(value(make(tag,cls,svg),property),background(card),'graphics',cls);
    const route=make('div','route-map',card);check(value(make('path','route-line',route),'stroke'),background(route),'graphics','GPX route');
    check(value(root,'--accent'),'#d6dfe9','graphics','progress fill against track');
    const week=make('div','habit-week',card);
    textCheck(make('span','',week),'unfilled habit date');textCheck(make('span','filled',week),'filled habit date');
    for(const states of [[],['hover']]){
      textCheck(make('button','habit-toggle',card,{},states),'empty habit toggle');
      textCheck(make('button','habit-toggle done',card,{},states),'done habit toggle');
      const disabled=make('button','habit-toggle done',card,{disabled:''},['disabled',...states]);textCheck(disabled,'disabled done toggle');
      assert.equal(background(disabled),value(root,'--disabled-bg'));
    }
    for(const selected of [false,true]){
      const day=make('button',`calendar-day${selected?' is-selected':''}`,card),markers=make('span','calendar-markers',day);
      for(const cls of ['event-marker','diary-marker','record-marker'])check(background(make('i',cls,markers)),background(day),'graphics',`${cls} selected=${selected}`);
    }
  });
}

test('Home regions use readable real-content surfaces in empty and populated renderers',()=>{
  const state=createInitialState(),date='2026-10-06';
  for(const populated of [false,true]){
    if(populated){state.wake[date]='06:30';state.habits=[{id:'h',name:'本',type:'check',target:1,unit:'',archived:false}];state.habitLogs.h={[date]:true};}
    const markup=renderDashboard({state,date,today:date});
    for(const cls of ['home-entry-sheet','home-lifetime','home-history','home-reflection']){
      assert.ok(new RegExp(`class="${cls}(?: |")`).test(markup),cls);
      const region=make('section',cls,rootFor('home'));
      for(const tag of ['h2','h3','p','strong','small','dt','dd'])textCheck(make(tag,'',region),`${cls} ${tag}`);
    }
    const sheet=make('section','home-entry-sheet',rootFor('home'));
    for(const classes of ['text-link','btn primary','btn secondary'])textCheck(make('button',classes,sheet),`home entry ${classes}`);
  }
});

test('home quick-record and selected history controls have readable normal, hover and disabled states',()=>{
  const sheet=make('section','home-entry-sheet',rootFor('home'));
  for(const done of [false,true])for(const hovered of [false,true])for(const disabled of [false,true]){
    const states=[...(hovered?['hover']:[]),...(disabled?['disabled']:[])];
    const button=make('button',`home-habit-quick${done?' done':''}`,sheet,disabled?{disabled:''}:{},states);
    textCheck(button,'home quick habit');
    textCheck(make('small','',button),'home quick habit value');
    check(foreground(make('svg','',button)),background(button),'graphics','home quick habit symbol');
    if(disabled)assert.equal(background(button),value(sheet,'--disabled-bg'));
  }
  const region=make('section','home-history',rootFor('home')),days=make('div','home-history-days continuity-days',region);
  for(const recorded of [false,true])for(const selected of ['false','true'])for(const states of [[],['hover']]){
    const day=make('button',`continuity-day${recorded?' recorded':''}`,days,{'aria-pressed':selected},states);
    for(const tag of ['span','strong'])textCheck(make(tag,'',day),'home history date or marker');
    if(selected==='true')check(value(day,'border-color'),background(day),'graphics','home selected date border');
  }
});

test('wake and running chart regions retain source-resolved text and graphic contrast',()=>{
  for(const [page,container,region] of [
    ['wake','wake-workspace','wake-chart-panel sky-panel'],
    ['wake','card trend-panel wake-trend','chart-space'],
    ['running','run-workspace','run-chart-panel forest-panel'],
    ['running','card trend-panel running-trend','chart-space'],
  ]){
    const parent=make('section',container,rootFor(page)),surface=make('section',region,parent);
    const chart=make('div','chart-wrap',surface),svg=make('svg','',chart);
    check(value(make('text','',svg),'fill'),background(surface),'text',`${page} ${region} chart label`);
    const series=page==='wake'?[['path','chart-line','stroke'],['circle','chart-dot','fill'],['line','chart-target','stroke']]:[['rect','run-bar','fill'],['rect','run-bar-empty','fill']];
    for(const [tag,cls,property] of series)check(value(make(tag,cls,svg),property),background(surface),'graphics',`${region} ${cls}`);
    for(const [tag,cls] of [['p','chart-note'],['p','chart-data'],['div','empty']])textCheck(make(tag,cls,surface),`${region} ${cls}`);
    textCheck(make('p','',make('div','empty',surface)),`${region} empty explanation`);
    if(region.includes('panel')){
      const head=make('div','section-head',surface);
      textCheck(make('h2','',head),`${region} heading`);
      for(const states of [[],['hover']])textCheck(make('button','text-link',head,{},states),`${region} history link ${states}`);
    }
  }
  for(const [page,cls] of [['wake','wake-summary apricot-panel'],['running','run-summary sky-panel']]){
    const surface=make('section',cls,rootFor(page)),stat=make('div','stat',surface);
    for(const tag of ['span','strong','small'])textCheck(make(tag,'',stat),`${cls} ${tag}`);
    textCheck(make('p','hint',surface),`${cls} empty hint`);
  }
});

test('data charts preserve missing-day gaps, target dashes, and distinct calendar category shapes',()=>{
  const state=createInitialState(),date='2026-10-06';state.wake['2026-10-04']='06:30';state.wake[date]='07:00';state.settings.wakeTarget='06:00';
  const wake=wakeChart(state,7,date);assert.match(wake,/class="chart-target"/);assert.match(wake,/未記録の日は線をつないでいません/);
  const path=/d="([^"]+)" class="chart-line"/.exec(wake)[1];assert.equal((path.match(/M/g)||[]).length,2);assert.ok(!path.includes('L'));
  state.runs=[{id:'r',date,distanceKm:5,durationSec:1800,note:'',points:[]}];
  const run=runChart(state,7,date);assert.match(run,/class="run-bar"/);assert.match(run,/class="run-bar-empty"/);
  assert.match(original+'\n'+palette,/\.chart-target\s*\{[^}]*stroke-dasharray:\s*5 5/);
  assert.match(original,/\.calendar-markers \.diary-marker[^}]*border-radius:\s*1px/);
  assert.match(original,/\.calendar-markers \.record-marker[^}]*height:\s*3px/);
});

test('native progress pseudo-elements have explicit colors and garden artwork is not globally recolored',()=>{
  for(const selector of ['progress::-webkit-progress-value','progress::-moz-progress-bar'])assert.equal(declaration(make('progress','',rootFor('habits'),{},[],selector.split('::')[1]),'background'),'var(--accent)');
  assert.doesNotMatch(palette,/(?:^|\})\s*svg\s*\{[^}]*(?:fill|stroke):/);
});

test('record workspaces show supported data visuals without fake landscape decorations',()=>{
  const state=createInitialState(),date='2026-10-06';
  for(const render of [renderDashboard,renderWake,renderRunning])for(const populated of [false,true]){
    if(populated){state.wake[date]='06:30';state.runs=[{id:'r',date,distanceKm:5,durationSec:1800,points:[],note:''}];}
    const markup=render({state,date,today:date});
    assert.doesNotMatch(markup,/class="(?:home-sun|sun-illustration|trail-art)"/);
  }
  assert.ok(renderWake({state,date,today:date}).includes(wakeChart(state,7,date)));
  const before=structuredClone(state),daily={schema:1,store:'palette-store',generation:'palette-generation',date,status:'ready',hash:'prepared-hash',pending:false,summary:{distanceMeters:2345,durationSeconds:1234,averageSpeedKmh:6.8},segments:[{sourceKey:'accepted-file',points:[[35,139],[35.001,139.001]],colors:['#49a677']}],quality:[],notice:null};
  const running=renderRunning({state,date,today:date,dailyView:{status:'ready',daily}});
  for(const label of ['DISTANCE','AVG SPEED','DURATION'])assert.ok(running.includes(label));
  assert.match(running,/2\.35<small>km/);assert.match(running,/6\.8<small>km\/h/);assert.match(running,/00:20:34/);assert.match(running,/data-route-map=/);
  assert.doesNotMatch(running,/run-bar|run-chart-panel|running-trend|run-add|run-edit|gpx-import/);
  assert.deepEqual(state,before,'prepared display does not rewrite preserved legacy records');
});

test('line-only chart and imported-route paths explicitly suppress SVG default polygon fills',()=>{
  for(const [page,container,cls] of [['wake','chart-wrap','chart-line'],['running','route-map','route-line']]){
    const parent=make('div',container,rootFor(page)),svg=make('svg','',parent),path=make('path',cls,svg);
    assert.equal(value(path,'fill'),'none',`${cls} must not acquire the SVG default black fill`);
  }
});

test('focused skip navigation uses an opaque readable surface rather than underlying page text',()=>{
  const link=make('a','skip-link',rootFor('home'),{},['focus']);
  assert.equal(background(link),value(link,'--surface'));
  textCheck(link,'focused skip navigation');
  assert.equal(value(link,'top'),'12px');
});

test('contrast summary reports source-level sampled minimums',t=>{
  t.diagnostic(`Sampled normal/disabled text minimum: ${minimums.text.toFixed(2)}:1 (required 4.5:1).`);
  t.diagnostic(`Sampled essential graphic/control minimum: ${minimums.graphics.toFixed(2)}:1 (required 3:1).`);
});
