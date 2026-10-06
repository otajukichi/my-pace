import {e, icon, sectionHead} from '../lib/ui.js';
import {todayKey} from '../lib/domain.js';
import {paginate,pager} from '../lib/workspace.js';
import {deriveGarden, GARDEN_PLANTS, GARDEN_THEMES} from '../lib/garden.js';

const palettes = {
  day: {sky:'#eef4f4', glow:'#fff0c6', hill:'#dae6d8', hillBack:'#e4ece1', ground:'#c5d9bb', soil:'#a99277', rim:'#d7bf9a', cloud:'#ffffff', leaf:'#6c9071'},
  dusk: {sky:'#f4e6de', glow:'#efb77f', hill:'#c7d0c2', hillBack:'#dedcce', ground:'#b5c4a8', soil:'#967d70', rim:'#ccb097', cloud:'#fff3e8', leaf:'#667e65'},
  night: {sky:'#28394e', glow:'#f6e7b3', hill:'#455b67', hillBack:'#3a505f', ground:'#526d6c', soil:'#4b5153', rim:'#81918a', cloud:'#536678', leaf:'#91b49a'},
};
const stages = ['seed','sprout','leaf','bud','bloom','garden'];

function blossom(type, x, y, scale = 1) {
  let flower;
  if (type === 'sunflower') {
    flower = Array.from({length:12}, (_,i) => `<ellipse cx="0" cy="-15" rx="5" ry="12" transform="rotate(${i * 30})" fill="${i % 2 ? '#e4b55b' : '#f1cd6a'}"/>`).join('') + '<circle r="10" fill="#80634e"/><circle r="5" fill="#a6865b"/>';
  } else if (type === 'hydrangea') {
    flower = [[0,-13],[-12,-8],[12,-8],[-16,5],[0,1],[16,5],[-9,15],[8,15]].map(([a,b],i) => `<g transform="translate(${a} ${b})" fill="${i % 2 ? '#aea4d1' : '#c3b8df'}"><circle cx="-4" cy="-3" r="5"/><circle cx="4" cy="-3" r="5"/><circle cx="-4" cy="4" r="5"/><circle cx="4" cy="4" r="5"/><circle r="2" fill="#f3e8c0"/></g>`).join('');
  } else {
    flower = Array.from({length:8}, (_,i) => `<ellipse cx="0" cy="-13" rx="7" ry="14" transform="rotate(${i * 45})" fill="${i % 2 ? '#d893a4' : '#e9b1ba'}"/>`).join('') + '<circle r="7" fill="#efcc78"/><circle r="3" fill="#d0a65c"/>';
  }
  return `<g transform="translate(${x} ${y}) scale(${scale})">${flower}</g>`;
}

/** Original SVG geometry; stage zero deliberately contains no earned growth. */
function plant(type, stage, x = 0, y = 0, scale = 1, leaf = '#6c9071') {
  if (stage === 0) return '';
  const height = [0,26,60,89,112,112][stage] || 112;
  let shape = `<path d="M0 0Q-5 ${-height * 0.5} 0 ${-height}" stroke="${leaf}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M-1 ${-height * 0.35}Q-31 ${-height * 0.7} -31 ${-height * 0.3}Q-10 ${-height * 0.18} -1 ${-height * 0.35}" fill="${leaf}"/><path d="M0 ${-height * 0.58}Q30 ${-height * 0.9} 29 ${-height * 0.48}Q12 ${-height * 0.36} 0 ${-height * 0.58}" fill="${leaf}"/>`;
  if (stage >= 3 && stage < 4) shape += `<ellipse cx="0" cy="${-height - 5}" rx="10" ry="15" fill="#bd8e9b"/><path d="M-9 ${-height - 2}L0 ${-height + 8}L9 ${-height - 2}" fill="${leaf}"/>`;
  if (stage >= 4) shape += blossom(type,0,-height,1);
  return `<g transform="translate(${x} ${y}) scale(${scale})">${shape}</g>`;
}

export function gardenScene(garden) {
  const palette = palettes[garden.theme] || palettes.day;
  const stage = Math.max(0, stages.indexOf(garden.stage));
  const type = GARDEN_PLANTS.some(item => item.id === garden.currentPlant) ? garden.currentPlant : 'cosmos';
  const label = `${garden.totalDays}日分の記録から育った庭。${garden.stageLabel}。${GARDEN_PLANTS.find(item => item.id === type).label}。`;
  const stars = [[65,45],[172,29],[325,55],[508,36],[661,82],[570,104]].map(([x,y]) => `<circle cx="${x}" cy="${y}" r="2" fill="#f1e9c9" opacity=".75"/>`).join('');
  return `<svg class="garden-scene" viewBox="0 0 720 340" role="img" aria-label="${e(label)}" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="340" rx="20" fill="${palette.sky}"/>${garden.theme === 'night' ? `${stars}<circle cx="575" cy="77" r="31" fill="${palette.glow}"/><circle cx="589" cy="65" r="29" fill="${palette.sky}"/>` : `<circle cx="570" cy="75" r="45" fill="${palette.glow}" opacity=".4"/><circle cx="570" cy="75" r="29" fill="${palette.glow}"/>`}<g fill="${palette.cloud}" opacity=".72"><path d="M80 88a18 18 0 0 1 32-10 24 24 0 0 1 45 9 16 16 0 0 1 18 15H75a12 12 0 0 1 5-14Z"/><path d="M322 50a13 13 0 0 1 23-7 17 17 0 0 1 32 6 12 12 0 0 1 13 11h-72a9 9 0 0 1 4-10Z"/></g><path d="M0 190Q145 116 300 195Q505 130 720 185V340H0Z" fill="${palette.hillBack}"/><path d="M0 224Q150 159 332 221Q570 149 720 235V340H0Z" fill="${palette.hill}"/><path d="M0 275Q190 225 380 258Q550 232 720 273V340H0Z" fill="${palette.ground}"/><g stroke="${palette.leaf}" stroke-width="2" opacity=".4" fill="none"><path d="m79 271 2-12 7 12m543-1 5-13 2 14m-476 31 3-13 4 13m409 3 5-12 3 12"/></g><ellipse cx="357" cy="287" rx="157" ry="27" fill="${palette.leaf}" opacity=".12"/><ellipse cx="355" cy="274" rx="146" ry="28" fill="${palette.rim}"/><ellipse cx="355" cy="268" rx="135" ry="24" fill="${palette.soil}"/><g fill="${palette.rim}" opacity=".7"><circle cx="252" cy="267" r="2"/><circle cx="313" cy="278" r="2"/><circle cx="420" cy="273" r="2"/><circle cx="458" cy="260" r="2"/></g>${stage === 5 ? `${plant(type,4,278,269,.72,palette.leaf)}${plant(type,4,414,268,.85,palette.leaf)}${plant(type,4,323,282,.95,palette.leaf)}${plant(type,4,382,279,.72,palette.leaf)}` : ''}${plant(type,stage,356,266,1.08,palette.leaf)}${stage === 0 ? `<path d="M340 267h31" stroke="${palette.rim}" stroke-width="3" stroke-linecap="round" opacity=".6"/>` : ''}<g transform="translate(481 269) rotate(8)"><path d="M0 0v-37" stroke="#9a8973" stroke-width="4"/><rect x="-17" y="-54" width="36" height="23" rx="5" fill="#f1e4c8"/><path d="m-6-43 5 5 9-10" stroke="#9baf88" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

export function renderGarden({state, today = todayKey(), tab = 'garden',page=0,pageSize=3} = {}) {
  const garden = deriveGarden(state,today);
  const activePlant = GARDEN_PLANTS.find(item => item.id === garden.currentPlant) || GARDEN_PLANTS[0];
  if (tab === 'guide') {
    const rules=[['記録した日に、少し育つ','起床・ランニング・実行した習慣のどれかを記録すると、1日分の成長に。習慣はチェック済み、または0より大きい値が対象です。'],['何回押しても、1日1回','同じ日の記録を増やしても二重には育ちません。未来の日付・予定・日記だけでは育ちません。休んでも枯れません。'],['7日でひまわり、21日であじさい','記録が増えると花を選べます。削除や取り消しは成長にも反映。再び条件を満たすと、選んでいた花に戻ります。']];
    const rows=paginate(rules,page,pageSize<=3?1:3);
    return `<section class="card garden-guide">${sectionHead('休む日にも、やさしい庭。','成長は、実際の記録から数えています。')}${rows.items.map(([title,body],index)=>`<div class="garden-guide-row"><span>${String(rows.page*rows.size+index+1).padStart(2,'0')}</span><div><h3>${title}</h3><p>${body}</p></div></div>`).join('')}<p class="hint">1・3・7・14・30日で姿が変わります。30日以降も記録した日数は増え続けます。</p>${rows.pages>1?pager(rows,'育つしくみ'):''}</section>`;
  }
  if (tab === 'collection') {
    return `<div class="view-stack garden-view"><section class="card garden-collection-card">${sectionHead('庭のしたく', '育てる花と、好きな時間を選びましょう。')}<div class="plant-choices" role="group" aria-label="育てる植物">${GARDEN_PLANTS.map(item => {
      const unlocked = garden.unlockedPlants.includes(item.id), selected = item.id === garden.currentPlant;
      return `<button class="plant-choice ${selected ? 'is-selected' : ''} ${unlocked ? '' : 'is-locked'}" type="button" data-action="garden-plant" data-plant="${item.id}" aria-pressed="${selected}" ${unlocked ? '' : 'disabled'} aria-label="${e(item.label)}、${unlocked ? selected ? '選択中' : '選べます' : `${item.unlockAt}日分の記録で解放`} "><span class="plant-preview"><svg viewBox="-55 -150 110 160" aria-hidden="true">${plant(item.id,4,0,0,.88)}</svg></span><strong>${e(item.label)}</strong><span>${unlocked ? selected ? '育てています' : 'この花を選ぶ' : `${icon('lock',12)} ${item.unlockAt}日で解放`}</span></button>`;
    }).join('')}</div><div class="garden-theme-header"><h3>庭の時間</h3><span class="muted">いつでも、気分に合わせて。</span></div><div class="theme-choices" role="group" aria-label="庭の時間帯">${GARDEN_THEMES.map(item => `<button class="theme-choice theme-${item.id} ${garden.theme === item.id ? 'is-selected' : ''}" type="button" data-action="garden-theme" data-theme="${item.id}" aria-pressed="${garden.theme === item.id}"><span class="theme-swatch" aria-hidden="true"><i></i></span><span>${e(item.label)}</span>${garden.theme === item.id ? icon('check',16) : ''}</button>`).join('')}</div><p class="garden-help">記録した日は ${garden.totalDays}日。花を変えても、成長は引き継がれます。</p></section></div>`;
  }
  const nextText = garden.nextAt === null ? '庭いっぱいに、花が咲きました。' : garden.totalDays === 0 ? 'はじめの記録で、小さな芽が出ます。' : `次の成長まで、あと${garden.daysToNext}日。`;
  const status = garden.todayEarned ? '今日の記録も、庭に届いています。' : '今日はまだ、成長の記録がありません。';
  return `<div class="view-stack garden-view"><div class="garden-workspace"><section class="card garden-scene-card">${sectionHead('わたしの小さな庭', garden.totalDays === 0 ? '最初の一日を、ここで待っています。' : '積み重ねた日が、少しずつ花になる。', `<button class="text-link" type="button" data-action="view-tab" data-tab="collection">庭のしたく ${icon('arrow',16)}</button>`)}${gardenScene(garden)}<div class="garden-scene-caption"><span>${icon('leaf',17)} ${e(activePlant.label)}</span><span class="status-pill">${e(garden.stageLabel)}</span></div></section><section class="card garden-progress-card"><span class="eyebrow">LITTLE DAYS, LITTLE GROWTH</span><h2>続けた分だけ、育つ。</h2><div class="garden-total"><strong>${garden.totalDays.toLocaleString('ja-JP')}</strong><span>日分の記録</span></div><p class="garden-next">${nextText}</p><progress class="garden-progress-track" max="100" value="${Math.round(garden.progress * 100)}" aria-label="次の成長まで" aria-valuetext="${e(nextText)}"></progress><p class="garden-status ${garden.todayEarned ? 'is-earned' : ''}">${icon(garden.todayEarned ? 'check' : 'sun',17)} ${status}</p><div class="garden-rules"><h3>庭が育つしくみ</h3><p>起床・ラン・実行した習慣の記録がある日に、1日1回育ちます。予定や日記だけでは育ちません。</p><p>習慣はチェック済み、または0より大きい値が対象。未来の日付は数えず、記録の削除・取り消しも反映します。</p></div></section></div></div>`;
}
