import  {
  e, empty
}
from './ui.js';
import  {
  recentDates, timeToMinutes
}
from './domain.js';
/** SVG charts use explicit date slots. Missing values remain gaps, not zeroes. */
export function wakeChart(state, days, anchor)  {
  const dates = recentDates(days, anchor);
  const values = dates.map(date => state.wake[date] ? timeToMinutes(state.wake[date]) : null);
  const recorded = values.filter(value => value !== null);
  if (!recorded.length) return empty('最初の朝を、記録しよう。', '記録すると、ここに起きた時間の流れが見えてきます。', 'sun');
  const target = state.settings.wakeTarget ? timeToMinutes(state.settings.wakeTarget) : null;
  const all = target !== null ? [...recorded, target] : recorded;
  const low = Math.max(0, Math.floor((Math.min(...all) - 30) / 60) * 60);
  const high = Math.min(1440, Math.max(low + 120, Math.ceil((Math.max(...all) + 30) / 60) * 60));
  const x = i => 52 + i * 540 / (days - 1);
  const y = v => 28 + (v - low) / (high - low) * 155;
  const hour = v => `${String(Math.floor(v / 60)).padStart(2,'0')}:${String(Math.round(v % 60)).padStart(2,'0')}`;
  let connected = false;
  const path = values.map((value,i) =>  {
    if (value === null)  {
      connected = false;
      return '';
    }
    const segment = `${connected ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    connected = true;
    return segment;
  }
  ).join(' ');
  const ticks = [low, (low+high)/2, high].map(value => `<line x1="52" x2="603" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="0" y="${y(value)+4}">${hour(value)}</text>`).join('');
  const dots = values.map((value,i) => value === null ? '' : `<circle cx="${x(i)}" cy="${y(value)}" r="${days === 7 ? 5 : 3.5}" class="chart-dot"><title>${e(dates[i])} ${hour(value)}</title></circle>`).join('');
  return `<div class="chart-wrap"><svg class="wake-chart" viewBox="0 0 620 224" role="img" aria-label="過去${days}日の起床時刻。上ほど早い時間。"><title>起床時刻の推移</title>${ticks}${target !== null ? `<line x1="52" x2="603" y1="${y(target)}" y2="${y(target)}" class="chart-target"/>` : ''}<path d="${path}" class="chart-line"/>${dots}<text x="52" y="215">${e(dates[0].slice(5).replace('-','/'))}</text><text x="595" y="215" text-anchor="end">${e(anchor.slice(5).replace('-','/'))}</text></svg></div><p class="chart-note">上ほど早い時間。未記録の日は線をつないでいません。${target !== null ? ` 破線は現在の目安 ${e(state.settings.wakeTarget)}。` : ''}</p>`;
}
export function runChart(state, days, anchor)  {
  const dates = recentDates(days, anchor);
  const values = dates.map(date => state.runs.filter(run => run.date === date).reduce((sum,run)=>sum+run.distanceKm,0));
  if (!values.some(Boolean)) return empty('走った分だけ、少しずつ。', 'ランニングの記録を追加すると、距離のグラフが育ちます。', 'run');
  const max = Math.max(...values, 1), barWidth = days === 7 ? 34 : 10;
  return `<div class="chart-wrap"><svg class="run-chart" viewBox="0 0 620 200" role="img" aria-label="過去${days}日の日別走行距離"><title>日別走行距離</title><line x1="30" y1="165" x2="605" y2="165" class="chart-grid"/>${values.map((value,i)=>`<rect x="${38+i*550/days}" y="${165-value/max*135}" width="${barWidth}" height="${value ? value/max*135 : 2}" rx="${Math.min(5,barWidth/2)}" class="${value ? 'run-bar' : 'run-bar-empty'}"><title>${e(dates[i])}: ${value.toFixed(2)} km</title></rect>`).join('')}<text x="35" y="192">${e(dates[0].slice(5).replace('-','/'))}</text><text x="598" y="192" text-anchor="end">${e(anchor.slice(5).replace('-','/'))}</text><text x="598" y="16" text-anchor="end">最大 ${max.toFixed(1)} km</text></svg></div>`;
}
