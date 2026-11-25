import { SPHERE_POINTS, SPHERE_EDGES, IDENTITY_QUATERNION, rotatePoint, focusQuaternion, slerpQuaternions, greatCirclePoints, slerpPoint, arcballPoint, dragQuaternion, projectPoint } from './english-sphere-math.js';
import { worldArt } from './english-art.js';
import { esc, icon } from './ui.js';

const arcs=SPHERE_EDGES.map(([a,b])=>({a,b,points:greatCirclePoints(SPHERE_POINTS[a],SPHERE_POINTS[b],36)}));
const graticule=[...[-.55,0,.55].map(y=>Array.from({length:65},(_,i)=>{const t=i/64*Math.PI*2,r=Math.sqrt(1-y*y);return [r*Math.cos(t),y,r*Math.sin(t)];})),...[0,Math.PI/3,Math.PI*2/3].map(a=>Array.from({length:65},(_,i)=>{const t=i/64*Math.PI*2;return [Math.sin(t)*Math.cos(a),Math.cos(t),Math.sin(t)*Math.sin(a)];}))];
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const ease=t=>1-Math.pow(1-t,4);

/** A finite-animation, dependency-free spherical atlas. No learning state writes. */
export function mountEnglishSphere(host,{areas,selected=0,visits={},history=false,onSelect=()=>{}}){
  const abort=new AbortController(),signal=abort.signal,reduce=matchMedia('(prefers-reduced-motion: reduce)');
  let orientation=history?[...IDENTITY_QUATERNION]:focusQuaternion(selected),flight=null,frame=0,disposed=false;
  let width=0,height=0,radius=1,cx=0,cy=0,nodeSize=100,camera=4.5,hover=null,drag=null,suppressClickUntil=0;
  let colors={},projected=[],arrival=null;
  host.classList.add('en-sphere');host.dataset.history=String(history);
  host.innerHTML=`<div class="en-sphere-wash" aria-hidden="true"></div><canvas class="en-sphere-canvas" aria-hidden="true"></canvas><div class="en-sphere-hit" aria-hidden="true"></div><div class="en-sphere-nodes">${areas.map((area,index)=>`<button class="en-world ${index===selected&&!history?'is-selected':''} ${visits[area.id]?.sessions?'is-visited':''}" data-sphere-area="${index}" aria-label="${esc(area.label)}${visits[area.id]?.sessions?`、${visits[area.id].sessions}回の会話`:''}を選ぶ" aria-pressed="${index===selected&&!history}"><span class="en-world-scene">${worldArt(area.id)}<span class="en-world-beacon" aria-hidden="true"></span></span><span class="en-world-label"><i>${String(index+1).padStart(2,'0')}</i>${esc(area.short)}</span></button>`).join('')}</div><div class="en-sphere-caption" aria-live="polite"><span class="en-sphere-kicker">${history?'YOUR FOOTPRINTS':`AREA ${String(selected+1).padStart(2,'0')} / 08`}</span><strong>${history?'Your world.':esc(areas[selected].english)}</strong><span class="en-sphere-subtitle">${history?'話した場所に、灯りが残る。':esc(areas[selected].label)}</span></div><div class="en-sphere-tools"><span>ドラッグで見渡す</span><button data-sphere-reset aria-label="${history?'全体を見渡す向きに戻す':'選んだエリアを手前に戻す'}" title="${history?'全体を見渡す':'選んだエリアへ'}">${icon('compass')}</button></div>`;
  const canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d'),hit=host.querySelector('.en-sphere-hit');
  const nodes=[...host.querySelectorAll('.en-world')];
  host.tabIndex=0;host.setAttribute('role','group');host.setAttribute('aria-label','球状の会話エリア。ドラッグで上下左右に回転。矢印キーで場所を選択。');

  function readColors(){const css=getComputedStyle(host);for(const key of ['paper','bg','surface','line','anchor','track','gold','ink'])colors[key]=css.getPropertyValue(`--${key}`).trim();}
  function measure(){
    const box=host.getBoundingClientRect();width=box.width;height=box.height;if(!width||!height)return;
    const mobile=innerWidth<=760;
    const compact=mobile&&height<250;
    const availableHeight=height-(mobile&&!compact?65:12);
    radius=Math.max(compact?22:40,Math.min(width*(mobile?.325:.31),availableHeight*.30,260));
    cx=width*(mobile?.5:width>600?.58:.52);cy=availableHeight*.49;
    nodeSize=clamp(radius*.69,compact?28:58,151);
    const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx?.setTransform(dpr,0,0,dpr,0,0);
    host.style.setProperty('--world-size',`${nodeSize}px`);
    Object.assign(hit.style,{left:`${cx-radius*1.12}px`,top:`${cy-radius*1.12}px`,width:`${radius*2.24}px`,height:`${radius*2.24}px`});
    readColors();requestDraw();
  }
  function projection(point){return projectPoint(rotatePoint(point,orientation),{radius,camera,centerX:cx,centerY:cy});}
  function line(points,color,alpha,weight=1){
    if(!ctx)return;
    const values=points.map(projection);
    // The far hemisphere remains visible, but never competes with the front.
    for(const front of [false,true]){
      ctx.beginPath();let drawing=false;
      for(let i=1;i<values.length;i++){
        const a=values[i-1],b=values[i],visible=(a.z+b.z>=0)===front;
        if(!visible){drawing=false;continue;}
        if(!drawing)ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);drawing=true;
      }
      ctx.strokeStyle=color;ctx.lineWidth=weight;ctx.globalAlpha=alpha*(front?1:.3);ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  function dot(point,color,size,alpha=1){if(!ctx)return;ctx.beginPath();ctx.arc(point.x,point.y,size,0,Math.PI*2);ctx.fillStyle=color;ctx.globalAlpha=alpha;ctx.fill();ctx.globalAlpha=1;}
  function paint(now=performance.now()){
    if(disposed||!width)return;
    const travelling=!!flight;
    if(flight){
      const t=clamp((now-flight.at)/flight.duration,0,1);
      orientation=slerpQuaternions(flight.from,flight.to,ease(t));
      camera=4.5+Math.sin(Math.PI*t)*1.25;
      if(t===1){const destination=flight.destination;flight=null;camera=4.5;arrival=reduce.matches?null:{at:now,index:destination};host.classList.remove('is-travelling');}
    }
    if(arrival&&now-arrival.at>=440)arrival=null;
    projected=SPHERE_POINTS.map(projection);
    if(ctx){
      ctx.clearRect(0,0,width,height);
      // Ground the translucent volume with a soft cast shadow, not a flat disc.
      ctx.save();ctx.translate(cx,cy+radius*1.22);ctx.scale(1,.18);
      const shadow=ctx.createRadialGradient(0,0,0,0,0,radius*1.1);
      shadow.addColorStop(0,colors.anchor);shadow.addColorStop(1,colors.paper);
      ctx.fillStyle=shadow;ctx.globalAlpha=.085;ctx.beginPath();ctx.arc(0,0,radius*1.1,0,Math.PI*2);ctx.fill();ctx.restore();
      // A softly lit shell, not an opaque globe: the far rooms can still be seen.
      const shell=ctx.createRadialGradient(cx-radius*.38,cy-radius*.5,radius*.04,cx,cy,radius*1.04);
      shell.addColorStop(0,colors.surface);shell.addColorStop(.66,colors.bg);shell.addColorStop(1,colors.line);
      ctx.globalAlpha=.75;ctx.fillStyle=shell;ctx.beginPath();ctx.arc(cx,cy,radius*1.04,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
      ctx.strokeStyle=colors.anchor;ctx.globalAlpha=.22;ctx.lineWidth=.8;ctx.stroke();ctx.globalAlpha=1;
      ctx.beginPath();ctx.arc(cx,cy,radius*1.035,Math.PI*.08,Math.PI*.81);ctx.strokeStyle=colors.anchor;ctx.globalAlpha=.16;ctx.lineWidth=2;ctx.stroke();ctx.globalAlpha=1;
      graticule.forEach(points=>line(points,colors.anchor,.12,.65));
      for(const arc of arcs){
        const linked=arc.a===selected||arc.b===selected;
        const lit=history?visits[areas[arc.a].id]?.sessions&&visits[areas[arc.b].id]?.sessions:linked;
        const target=hover!==null&&linked&&(arc.a===hover||arc.b===hover);
        line(arc.points,target?colors.track:colors.anchor,target?.72:lit?.39:.065,target?1.6:lit?1.05:.6);
      }
      // Discrete surveying marks give the sphere scale without a scrolling map.
      for(let i=0;i<64;i++){
        const a=i/64*Math.PI*2,large=i%8===0,r=radius*1.115;
        ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);ctx.lineTo(cx+Math.cos(a)*(r+(large?6:2)),cy+Math.sin(a)*(r+(large?6:2)));ctx.strokeStyle=colors.anchor;ctx.globalAlpha=large?.23:.12;ctx.lineWidth=.7;ctx.stroke();
      }
      ctx.globalAlpha=1;
      if(flight&&flight.source!==flight.destination){
        const t=clamp((now-flight.at)/flight.duration,0,1),p=projection(slerpPoint(SPHERE_POINTS[flight.source],SPHERE_POINTS[flight.destination],ease(t)));
        line(greatCirclePoints(SPHERE_POINTS[flight.source],SPHERE_POINTS[flight.destination],24),colors.track,.6,1.5);
        ctx.shadowBlur=12;ctx.shadowColor=colors.gold;dot(p,colors.gold,3.3);ctx.shadowBlur=0;
      }
      if(arrival){
        const t=clamp((now-arrival.at)/440,0,1),p=projected[arrival.index];
        ctx.beginPath();ctx.ellipse(p.x,p.y+nodeSize*.45,nodeSize*(.26+t*.45),nodeSize*(.07+t*.12),0,0,Math.PI*2);ctx.strokeStyle=colors.track;ctx.lineWidth=1;ctx.globalAlpha=(1-t)*.4;ctx.stroke();ctx.globalAlpha=1;
        if(t===1)arrival=null;
      }
    }
    nodes.forEach((node,i)=>{
      const p=projected[i],front=clamp((p.z+1)/2,0,1),scale=p.scale*(i===selected&&!history?1.12:1);
      node.style.transform=`translate3d(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px,0) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      node.style.zIndex=String(Math.round((p.z+1)*30)+2);
      node.style.setProperty('--depth',String(front));
      node.dataset.rear=String(p.z<-.3);
    });
    host.dataset.moving=String(!!flight||!!drag);
    if((travelling||arrival)&&!reduce.matches&&!document.hidden)requestDraw();
  }
  function requestDraw(){if(!disposed&&!frame)frame=requestAnimationFrame(now=>{frame=0;paint(now);});}
  function moveTo(index,{instant=false}={}){
    if(!SPHERE_POINTS[index]||disposed)return;
    const previous=selected;selected=index;hover=null;stopDrag();
    const target=focusQuaternion(index,orientation);
    nodes.forEach((node,i)=>{node.classList.toggle('is-selected',i===index&&!history);node.setAttribute('aria-pressed',String(i===index&&!history));});
    if(!history){host.querySelector('.en-sphere-kicker').textContent=`AREA ${String(index+1).padStart(2,'0')} / 08`;host.querySelector('.en-sphere-caption strong').textContent=areas[index].english;host.querySelector('.en-sphere-subtitle').textContent=areas[index].label;}
    if(reduce.matches||instant){orientation=target;flight=null;arrival=null;camera=4.5;host.classList.remove('is-travelling');}
    else{flight={from:[...orientation],to:target,source:previous,destination:index,at:performance.now(),duration:1150};arrival=null;host.classList.add('is-travelling');}
    requestDraw();
  }
  function pointerPoint(event){const box=host.getBoundingClientRect();return arcballPoint((event.clientX-box.left-cx)/radius,(cy-event.clientY+box.top)/radius);}
  function stopDrag(){
    const active=drag;drag=null;host.classList.remove('is-dragging');
    if(active&&host.hasPointerCapture(active.id))host.releasePointerCapture(active.id);
  }
  host.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false||(!event.target.closest('.en-world')&&!event.target.closest('.en-sphere-hit')))return;
    if(drag)return;
    flight=null;arrival=null;camera=4.5;
    drag={id:event.pointerId,start:pointerPoint(event),orientation:[...orientation],x:event.clientX,y:event.clientY,moved:false};
    host.classList.remove('is-travelling');
  },{signal});
  host.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<7&&!drag.moved)return;
    drag.moved=true;host.setPointerCapture(event.pointerId);host.classList.add('is-dragging');
    orientation=dragQuaternion(drag.start,pointerPoint(event),drag.orientation);requestDraw();
  },{signal});
  function release(event){
    if(!drag||drag.id!==event.pointerId)return;
    if(drag.moved)suppressClickUntil=performance.now()+400;
    stopDrag();requestDraw();
  }
  host.addEventListener('pointerup',release,{signal});host.addEventListener('pointercancel',release,{signal});
  host.addEventListener('lostpointercapture',event=>{if(drag?.id===event.pointerId){stopDrag();requestDraw();}},{signal});
  host.addEventListener('click',event=>{
    if(performance.now()<suppressClickUntil){event.preventDefault();return;}
    const node=event.target.closest('[data-sphere-area]');
    if(node){onSelect(Number(node.dataset.sphereArea));return;}
    if(event.target.closest('[data-sphere-reset]')){
      if(history){orientation=[...IDENTITY_QUATERNION];flight=null;requestDraw();}else moveTo(selected);
    }
  },{signal});
  host.addEventListener('pointerover',event=>{const node=event.target.closest('[data-sphere-area]');const next=node?Number(node.dataset.sphereArea):null;if(next!==hover){hover=next;requestDraw();}},{signal});
  host.addEventListener('pointerleave',()=>{hover=null;if(drag&&!drag.moved)drag=null;requestDraw();},{signal});
  host.addEventListener('focusin',event=>{const node=event.target.closest('[data-sphere-area]');hover=node?Number(node.dataset.sphereArea):null;requestDraw();},{signal});
  host.addEventListener('focusout',event=>{if(!host.contains(event.relatedTarget)){hover=null;requestDraw();}},{signal});
  host.addEventListener('keydown',event=>{
    const directions={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]},direction=directions[event.key];
    if(!direction)return;
    event.preventDefault();const origin=projected[selected];if(!origin)return;
    const candidates=projected.map((p,index)=>{const dx=p.x-origin.x,dy=p.y-origin.y,distance=Math.hypot(dx,dy)||1,alignment=(dx*direction[0]+dy*direction[1])/distance;return {index,alignment,score:alignment*3+p.z*.2-distance/Math.max(width,height)};}).filter(p=>p.index!==selected&&p.alignment>.12).sort((a,b)=>b.score-a.score);
    if(candidates[0]){onSelect(candidates[0].index);host.focus({preventScroll:true});}
  },{signal});
  function settle(){if(flight)orientation=flight.to;flight=null;arrival=null;camera=4.5;host.classList.remove('is-travelling');stopDrag();}
  reduce.addEventListener('change',()=>{if(reduce.matches)settle();requestDraw();},{signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){settle();cancelAnimationFrame(frame);frame=0;}else requestDraw();},{signal});
  const observer=new ResizeObserver(measure);observer.observe(host);
  const themeObserver=new MutationObserver(()=>{readColors();requestDraw();});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-theme-pack','data-theme-variant','data-theme-scheme']});
  measure();
  if(!reduce.matches&&!history){orientation=[...IDENTITY_QUATERNION];moveTo(selected);}
  return {focus:moveTo,hover(index){hover=index;requestDraw();},destroy(){disposed=true;stopDrag();abort.abort();observer.disconnect();themeObserver.disconnect();cancelAnimationFrame(frame);},getOrientation:()=>[...orientation]};
}
