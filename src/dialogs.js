import  {
  e,icon,dayLabel
}
from './lib/ui.js';
export function dialogShell(title, content, footer = '', subtitle = '')  {
  return `<div class="dialog-top"><div><h2 id="dialog-title">${e(title)}</h2>${subtitle?`<p>${e(subtitle)}</p>`:''}</div><button class="icon-button" type="button" data-action="dialog-close" aria-label="閉じる">${icon('close')}</button></div>${content}<p id="form-error" class="form-error" role="alert" hidden></p>${footer}`;
}
const actions = (label='保存する', extra='')=>`<div class="dialog-actions">${extra}<button class="btn secondary" type="button" data-action="dialog-close">キャンセル</button><button class="btn primary" type="submit">${label}</button></div>`;
export function wakeDialog(date,time)  {
  return dialogShell('起きた時間',`<form data-form="wake"><label class="field">起床時刻<input name="time" id="wake-time" type="time" value="${e(time||'')}" required autofocus></label>${actions('記録する',time?'<button type="button" class="text-link danger" data-action="wake-delete">記録を削除</button>':'')}</form>`,'',dayLabel(date));
}
export function targetDialog(target)  {
  return dialogShell('朝の目安',`<form data-form="target"><p class="dialog-description">気が向いたら、目安の時間を。空欄で保存すると解除できます。</p><label class="field">起床の目安（任意）<input name="target" type="time" value="${e(target||'')}" autofocus></label>${actions()}</form>`);
}
export function habitDialog(habit)  {
  const h=habit|| {
    name:'',type:'check',unit:'回',target:1
  }
  ;
  return dialogShell(habit?'習慣を編集':'新しい習慣',`<form data-form="habit"><input name="id" type="hidden" value="${e(h.id||'')}"><label class="field">続けたいこと<input name="name" value="${e(h.name)}" maxlength="80" placeholder="例：本を読む" required autofocus></label><label class="field">記録方法<select name="type" ${habit?'disabled':''}><option value="check" ${h.type==='check'?'selected':''}>チェック · できたらタップ</option><option value="number" ${h.type==='number'?'selected':''}>数値 · 杯、回、ページなど</option><option value="time" ${h.type==='time'?'selected':''}>時間 · 分で記録</option></select></label>${habit?'<p class="hint">記録を守るため、作成後は記録の種類を変えられません。</p>':''}<div id="habit-details" ${h.type==='check'?'hidden':''}><div class="form-grid"><label class="field">1日の目安<input name="target" type="number" value="${e(h.target||1)}" min="0.001" max="1000000" step="any" inputmode="decimal"></label><label class="field" id="habit-unit-field" ${h.type==='time'?'hidden':''}>単位<input name="unit" value="${e(h.unit||'回')}" maxlength="20" placeholder="ページ"></label></div><p id="time-unit-hint" class="hint" ${h.type==='time'?'':'hidden'}>時間は「分」で記録します。</p></div>${actions(habit?'保存する':'習慣を追加')}</form>`);
}
export function habitLogDialog(habit,value,date)  {
  const unit=habit.type==='time'?'分':habit.unit;
  return dialogShell(habit.name,`<form data-form="habit-log"><input type="hidden" name="id" value="${e(habit.id)}"><label class="field">今日の記録（${e(unit)}）<input name="value" type="number" min="0" max="1000000" step="any" inputmode="decimal" value="${value!==undefined?e(value):''}" placeholder="${e(habit.target)}" required autofocus></label><p class="hint">目安 ${e(habit.target)} ${e(unit)}。0 も記録できます。</p>${actions('記録する',value!==undefined?'<button type="button" class="text-link danger" data-action="habit-log-delete">記録を削除</button>':'')}</form>`,'',dayLabel(date));
}
export function confirmDialog(title,description,label,action)  {
  return dialogShell(title,`<p class="dialog-description">${e(description)}</p><div class="dialog-actions"><button class="btn secondary" data-action="dialog-close">キャンセル</button><button class="btn primary" data-action="${action}">${e(label)}</button></div>`);
}
