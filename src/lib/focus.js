/** Preserve the user's place through a render, without interpolating user data in selectors. */
const identity = ['id','href','data-action','data-id','data-date','data-tab','data-page','data-days','data-theme','data-plant'];
export function captureFocus(root, active) {
  if (!active || !root.contains?.(active)) return null;
  const attributes = identity.map(name=>[name,active.getAttribute?.(name)]).filter(([,value])=>value!==null&&value!==undefined);
  return attributes.length ? {tag:active.tagName,attributes} : null;
}
export function restoreFocus(root, snapshot) {
  if (!snapshot || !root.querySelectorAll) return false;
  const target = [...root.querySelectorAll('button,a,input,select,textarea,[tabindex]')].find(element=>element.tagName===snapshot.tag&&!element.disabled&&snapshot.attributes.every(([name,value])=>element.getAttribute(name)===value));
  if (!target) return false;
  target.focus({preventScroll:true});
  return true;
}
