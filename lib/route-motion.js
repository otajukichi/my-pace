// The semantic selection, rather than a new route object or a map redraw,
// decides whether an entrance should run. The owner may retain state on remount.
export function routeMotionPlan(state, {
  motionKey, animate = false, overview = false, runCount = 0, edges = 0,
  pixels = 0, reduced = false, hidden = false,
} = {}) {
  if (typeof motionKey !== 'string' || !motionKey) return null;
  if (state.key === motionKey) return null;
  const initial = !state.started;
  state.key = motionKey;
  state.started = true;
  // A loaded empty date still consumes its selection. Pending loads use null.
  if (!animate || reduced || hidden || !runCount || !edges) return null;
  // Large/monthly views retain the completed rendering and only change opacity.
  // This bounds animation work independently of the size of a person's history.
  const fade = overview || runCount > 4 || edges > 6000 || pixels > 8_000_000;
  return { kind: fade ? 'fade' : 'trace', duration: fade ? 440 : initial ? 1450 : 850 };
}

/** Project each recorded chain independently; never join gaps or separate runs. */
export function revealEdges(models, project, ratio = 1) {
  const edges = [];
  let total = 0;
  for (const model of models) for (const chain of model.chains) {
    let previous = null;
    for (const point of chain.points) {
      const projected = project(point);
      const current = { x: projected.x * ratio, y: projected.y * ratio };
      if (previous) {
        const length = Math.hypot(current.x - previous.x, current.y - previous.y);
        if (Number.isFinite(length) && length > 0) {
          edges.push({ a: previous, b: current, length, from: total });
          total += length;
        }
      }
      previous = current;
    }
  }
  return { edges, total };
}
