import { gradientChains, RUN_OPACITY } from './route-speed.js';

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
 * reusable buffer, regardless of the number of runs. Panning moves the cached
 * image; redraws are coalesced at the end of a move/zoom, never in a busy loop. */
export function mountSpeedLayer(map,L){
  const document=map.getContainer().ownerDocument,view=document.defaultView;
  const pane=map.createPane('runningSpeedPane');pane.style.zIndex='390';pane.style.pointerEvents='none';
  const canvas=document.createElement('canvas'),buffer=document.createElement('canvas');
  canvas.className='running-speed-canvas leaflet-zoom-animated';canvas.setAttribute('aria-hidden','true');
  Object.assign(canvas.style,{position:'absolute',pointerEvents:'none',transformOrigin:'0 0'});pane.append(canvas);
  const context=canvas.getContext('2d'),scratch=buffer.getContext('2d');
  if(!context||!scratch){pane.remove();throw new Error('経路の描画を初期化できませんでした。');}
  const cache=new WeakMap();let runs=[],frame=null,destroyed=false,topLeft=null;
  const schedule=()=>{if(!destroyed&&frame===null)frame=view.requestAnimationFrame(draw);};
  function draw(){
    frame=null;if(destroyed)return;
    const started=view.performance.now(),size=map.getSize(),ratio=Math.min(2,view.devicePixelRatio||1);
    // A small buffer around the viewport keeps the line visible during pans.
    const margin=64,width=size.x+margin*2,height=size.y+margin*2;
    const origin=L.point(-margin,-margin);
    const position=map.containerPointToLayerPoint(origin);topLeft=map.containerPointToLatLng(origin);
    L.DomUtil.setTransform(canvas,position,1);
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
    const stats={runs:runs.length,edges,drawn,milliseconds:view.performance.now()-started};
    canvas.dataset.runCount=String(runs.length);
    canvas.dispatchEvent(new view.CustomEvent('running-render',{bubbles:true,detail:stats}));
  }
  function animateZoom(event){
    if(!topLeft||canvas.hidden)return;
    const scale=map.getZoomScale(event.zoom);
    const paneOffset=L.DomUtil.getPosition(map.getPane('mapPane'))||L.point(0,0);
    const newOrigin=map.project(event.center,event.zoom).subtract(map.getSize().divideBy(2)).add(paneOffset);
    L.DomUtil.setTransform(canvas,map.project(topLeft,event.zoom).subtract(newOrigin),scale);
  }
  map.on('moveend zoomend resize viewreset',schedule);map.on('zoomanim',animateZoom);
  return {
    setRuns(next){
      if(next.length===runs.length&&next.every((run,i)=>run===runs[i]))return;
      runs=[...next];
      // Remove the previous date immediately; do not flash stale routes.
      canvas.hidden=true;schedule();
    },
    destroy(){
      destroyed=true;if(frame!==null)view.cancelAnimationFrame(frame);
      map.off('moveend zoomend resize viewreset',schedule);map.off('zoomanim',animateZoom);
      pane.remove();canvas.width=canvas.height=buffer.width=buffer.height=1;runs=[];
    },
  };
}
