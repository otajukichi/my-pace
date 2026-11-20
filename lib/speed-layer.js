import { gradientChains, RUN_OPACITY } from './route-speed.js';
import { routeMotionPlan, revealEdges } from './route-motion.js';

/** Draw one opaque run into a reusable buffer, then composite it once. This
 * keeps joins from forming dark beads while separate runs still accumulate. */
export function paintGradientRun(context, model, project, width, height, weight=4.4) {
  context.lineWidth=weight;context.lineCap='round';context.lineJoin='round';
  let drawn=0;
  for(const chain of model.chains){
    const points=chain.points.map(project);
    for(let i=0;i<points.length-1;i++){
      const a=points[i],b=points[i+1];
      if(Math.max(a.x,b.x)<-weight||Math.max(a.y,b.y)<-weight||Math.min(a.x,b.x)>width+weight||Math.min(a.y,b.y)>height+weight)continue;
      if(a.x===b.x&&a.y===b.y)continue;
      const stops=chain.gradients[i];
      if(stops.every(([,color])=>color===stops[0][1]))context.strokeStyle=stops[0][1];
      else{
        const gradient=context.createLinearGradient(a.x,a.y,b.x,b.y);
        for(const [offset,color] of stops)gradient.addColorStop(offset,color);
        context.strokeStyle=gradient;
      }
      context.beginPath();context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);context.stroke();drawn++;
    }
  }
  return drawn;
}

/** Leaflet 1.9 public coordinate/event APIs only. One visible canvas and one
 * reusable buffer, plus a short-lived reveal mask during a bounded entrance.
 * Panning moves the cached image; redraws are coalesced at move/zoom end. */
export function mountSpeedLayer(map,L,{motionState={}}={}){
  const document=map.getContainer().ownerDocument,view=document.defaultView;
  const pane=map.createPane('runningSpeedPane');pane.style.zIndex='390';pane.style.pointerEvents='none';
  const canvas=document.createElement('canvas'),buffer=document.createElement('canvas');
  canvas.className='running-speed-canvas leaflet-zoom-animated';canvas.setAttribute('aria-hidden','true');
  Object.assign(canvas.style,{position:'absolute',pointerEvents:'none',transformOrigin:'0 0'});pane.append(canvas);
  const context=canvas.getContext('2d'),scratch=buffer.getContext('2d');
  if(!context||!scratch){pane.remove();throw new Error('経路の描画を初期化できませんでした。');}
  const cache=new WeakMap();let runs=[],frame=null,destroyed=false,topLeft=null;
  let motionOptions={},endMotion=null,pendingMotion=null,lastPaint=null,transformDirty=false;
  const reduced=view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const schedule=()=>{if(!destroyed&&frame===null)frame=view.requestAnimationFrame(draw);};
  const cancelPending=()=>{
    if(pendingMotion!==null){view.clearTimeout(pendingMotion);pendingMotion=null;canvas.style.removeProperty('opacity');}
  };
  const stopMotion=(restore=true)=>{cancelPending();endMotion?.(restore,'cancel');};
  const announce=(phase,plan)=>canvas.dispatchEvent(new view.CustomEvent('running-motion',{
    bubbles:true,detail:{phase,kind:plan.kind,duration:plan.duration},
  }));
  function startMotion(plan,models,project,ratio){
    if(!plan)return;
    let tickFrame=null,done=false,mask=null,brush=null,geometry=null,index=0;
    if(plan.kind==='trace'){
      geometry=revealEdges(models,project,ratio);
      if(!geometry.total)return;
      mask=document.createElement('canvas');mask.width=canvas.width;mask.height=canvas.height;
      brush=mask.getContext('2d');
      if(!brush){mask.width=mask.height=1;return;}
      brush.lineWidth=12*ratio;brush.lineCap='round';brush.lineJoin='round';brush.strokeStyle='#fff';
      // Reuse the per-run buffer for the finished image. Every animation frame
      // composites that image, preserving all original gradients and overlaps.
      scratch.setTransform(1,0,0,1,0,0);scratch.clearRect(0,0,buffer.width,buffer.height);
      scratch.drawImage(canvas,0,0);
      context.clearRect(0,0,canvas.width,canvas.height);
    }else canvas.style.opacity='.15';
    const started=view.performance.now();
    const accent=view.getComputedStyle(map.getContainer()).getPropertyValue('--track').trim()||'#d86442';
    const finish=(restore=true,phase='finish')=>{
      if(done)return;done=true;
      if(tickFrame!==null)view.cancelAnimationFrame(tickFrame);
      canvas.style.removeProperty('opacity');
      if(restore&&plan.kind==='trace'){
        context.setTransform(1,0,0,1,0,0);context.globalAlpha=1;context.globalCompositeOperation='source-over';
        context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(buffer,0,0);
      }
      if(mask)mask.width=mask.height=1;
      delete canvas.dataset.motion;endMotion=null;announce(phase,plan);
    };
    endMotion=finish;canvas.dataset.motion=plan.kind;announce('start',plan);
    function paintEdge(a,b){brush.beginPath();brush.moveTo(a.x,a.y);brush.lineTo(b.x,b.y);brush.stroke();}
    function tick(now){
      if(done||destroyed)return;
      const time=Math.min(1,Math.max(0,(now-started)/plan.duration));
      if(time>=1){finish();return;}
      const progress=1-(1-time)**2;
      if(plan.kind==='fade')canvas.style.opacity=String(.15+.85*progress);
      else{
        const target=geometry.total*progress;
        while(index<geometry.edges.length&&geometry.edges[index].from+geometry.edges[index].length<=target){
          const edge=geometry.edges[index++];paintEdge(edge.a,edge.b);
        }
        let head=null;
        if(index<geometry.edges.length){
          const edge=geometry.edges[index],part=Math.max(0,(target-edge.from)/edge.length);
          head={x:edge.a.x+(edge.b.x-edge.a.x)*part,y:edge.a.y+(edge.b.y-edge.a.y)*part};
          paintEdge(edge.a,head);
        }
        context.save();context.setTransform(1,0,0,1,0,0);context.globalAlpha=1;
        context.globalCompositeOperation='source-over';context.clearRect(0,0,canvas.width,canvas.height);
        context.drawImage(buffer,0,0);context.globalCompositeOperation='destination-in';context.drawImage(mask,0,0);
        context.globalCompositeOperation='source-over';
        if(head){context.beginPath();context.arc(head.x,head.y,3*ratio,0,Math.PI*2);context.fillStyle=accent;context.shadowColor=accent;context.shadowBlur=8*ratio;context.fill();}
        context.restore();
      }
      tickFrame=view.requestAnimationFrame(tick);
    }
    tickFrame=view.requestAnimationFrame(tick);
  }
  function draw(){
    frame=null;if(destroyed)return;
    const started=view.performance.now(),size=map.getSize(),ratio=Math.min(2,view.devicePixelRatio||1);
    const center=map.getCenter(),stamp=[size.x,size.y,ratio,map.getZoom(),center.lat,center.lng].join('|');
    // Leaflet can emit a delayed moveend for a viewport we already painted.
    // Such a no-op must not interrupt an otherwise valid running entrance.
    if(!transformDirty&&lastPaint?.stamp===stamp&&lastPaint.runs===runs&&lastPaint.motionKey===motionOptions.motionKey
      &&lastPaint.animate===motionOptions.animate&&lastPaint.overview===motionOptions.overview)return;
    // A real redraw owns a fresh image. Never restore an old selection over it.
    stopMotion(false);
    // A small buffer around the viewport keeps the line visible during pans.
    const margin=64,width=size.x+margin*2,height=size.y+margin*2;
    const origin=L.point(-margin,-margin);
    const position=map.containerPointToLayerPoint(origin);topLeft=map.containerPointToLatLng(origin);
    L.DomUtil.setTransform(canvas,position,1);
    transformDirty=false;
    canvas.style.width=width+'px';canvas.style.height=height+'px';
    for(const target of [canvas,buffer]){
      if(target.width!==Math.ceil(width*ratio))target.width=Math.ceil(width*ratio);
      if(target.height!==Math.ceil(height*ratio))target.height=Math.ceil(height*ratio);
    }
    context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);
    let edges=0,drawn=0;
    for(const run of runs){
      let model=cache.get(run);if(!model){model=gradientChains(run);cache.set(run,model);}
      edges+=model.known+model.unknown;
      scratch.setTransform(1,0,0,1,0,0);scratch.clearRect(0,0,buffer.width,buffer.height);
      scratch.setTransform(ratio,0,0,ratio,0,0);
      drawn+=paintGradientRun(scratch,model,p=>map.latLngToLayerPoint(p).subtract(position),width,height);
      context.globalAlpha=RUN_OPACITY;context.drawImage(buffer,0,0);
    }
    context.globalAlpha=1;canvas.hidden=!runs.length;
    lastPaint={stamp,runs,...motionOptions};
    const request={...motionOptions,runCount:runs.length,edges,pixels:canvas.width*canvas.height,
      reduced:!!reduced?.matches,hidden:document.visibilityState==='hidden'};
    const plan=routeMotionPlan({...motionState},request);
    if(plan){
      // Font/layout settling can fit the map several times just after data
      // arrives. Reserve the key until 120 ms of stable geometry; never spend
      // an entrance on the first temporary viewport. Input cancels immediately.
      canvas.style.opacity='.15';
      pendingMotion=view.setTimeout(()=>{
        pendingMotion=null;canvas.style.removeProperty('opacity');
        if(destroyed)return;
        const settled=routeMotionPlan(motionState,{...request,reduced:!!reduced?.matches,
          hidden:document.visibilityState==='hidden'});
        startMotion(settled,runs.map(run=>cache.get(run)),p=>map.latLngToLayerPoint(p).subtract(position),ratio);
      },120);
    }else routeMotionPlan(motionState,request);
    const stats={runs:runs.length,edges,drawn,milliseconds:view.performance.now()-started};
    canvas.dataset.runCount=String(runs.length);
    canvas.dispatchEvent(new view.CustomEvent('running-render',{bubbles:true,detail:stats}));
  }
  function input(){
    stopMotion();
    // If an input arrives between a ready selection and its scheduled draw,
    // finish that selection rather than starting an entrance after the input.
    routeMotionPlan(motionState,{...motionOptions,animate:false});
  }
  function visibility(){if(document.visibilityState==='hidden')input();}
  function animateZoom(event){
    if(!topLeft||canvas.hidden)return;
    transformDirty=true;
    const scale=map.getZoomScale(event.zoom);
    const paneOffset=L.DomUtil.getPosition(map.getPane('mapPane'))||L.point(0,0);
    const newOrigin=map.project(event.center,event.zoom).subtract(map.getSize().divideBy(2)).add(paneOffset);
    L.DomUtil.setTransform(canvas,map.project(topLeft,event.zoom).subtract(newOrigin),scale);
  }
  // Programmatic fit happens between setRuns and draw: it may stop an active
  // animation, but must not consume the newly queued selection before its draw.
  const stopForMove=()=>endMotion?.(true,'cancel');
  map.on('movestart zoomstart',stopForMove);
  map.on('moveend zoomend resize viewreset',schedule);map.on('zoomanim',animateZoom);
  for(const event of ['pointerdown','wheel','keydown'])document.addEventListener(event,input,{capture:true,passive:true});
  document.addEventListener('visibilitychange',visibility);
  reduced?.addEventListener?.('change',input);
  return {
    setRuns(next,options={}){
      const previous=motionOptions;motionOptions=options;
      const same=next.length===runs.length&&next.every((run,i)=>run===runs[i]);
      const changed=options.motionKey!==previous.motionKey||options.animate!==previous.animate||options.overview!==previous.overview;
      if(!options.animate||!options.motionKey)stopMotion();
      if(same&&!changed)return;
      stopMotion(false);
      runs=[...next];
      // Remove the previous date immediately; do not flash stale routes.
      canvas.hidden=true;schedule();
    },
    destroy(){
      stopMotion(false);
      destroyed=true;if(frame!==null)view.cancelAnimationFrame(frame);
      map.off('movestart zoomstart',stopForMove);
      map.off('moveend zoomend resize viewreset',schedule);map.off('zoomanim',animateZoom);
      for(const event of ['pointerdown','wheel','keydown'])document.removeEventListener(event,input,true);
      document.removeEventListener('visibilitychange',visibility);reduced?.removeEventListener?.('change',input);
      pane.remove();canvas.width=canvas.height=buffer.width=buffer.height=1;runs=[];
    },
  };
}
