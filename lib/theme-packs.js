// Palette roles are shared across pages. Packs are data: no page owns a theme switch.
export const THEME_MODES = Object.freeze(['auto', 'morning', 'day', 'night']);
export const THEME_NAMES = Object.freeze({ morning: '朝', day: '昼', night: '晩' });
export const DEFAULT_THEME_PACK = 'original';
const hours = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' });
export function themeAt(date = new Date()) {
  const hour = Number(hours.format(date));
  return hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 18 ? 'day' : 'night';
}

// These are the approved palettes, including the existing map treatments.
const originalTimes = {
  "morning": {
    "scheme": "light",
    "tokens": {
      "paper": "#FAF3E8",
      "bg": "#D9EBEC",
      "surface": "#FFF9F1",
      "panel": "#F7D1C7",
      "soft": "#F5E3D9",
      "ink": "#243D5A",
      "muted": "#4E5E70",
      "line": "#DCD5CF",
      "anchor": "#3A5C88",
      "primary": "#3A5C88",
      "on-primary": "#FAF3E8",
      "track": "#CB5640",
      "coral-ink": "#973B2C",
      "gold": "#F0C57F",
      "header": "#3A5C88",
      "header-ink": "#FAF3E8",
      "heat-0": "#E8DFD5",
      "heat-1": "#E4B1A2",
      "heat-2": "#D8836B",
      "heat-3": "#CB5640",
      "heat-4": "#9C3C2B",
      "map-bg": "#D9EBEC",
      "map-route": "#CB5640",
      "map-context": "#3A5C88",
      "map-halo": "#FFF9F1",
      "map-marker-ink": "#111111",
      "map-filter": "grayscale(.88) saturate(.25) contrast(.82) brightness(1.1)",
      "map-opacity": ".78",
      "shadow": "0 12px 42px #243D5A12",
      "blue": "var(--primary)",
      "blue-soft": "var(--soft)",
      "coral": "var(--track)"
    }
  },
  "day": {
    "scheme": "light",
    "tokens": {
      "paper": "#F7F0E8",
      "bg": "#F0E9F0",
      "surface": "#FFF9F4",
      "panel": "#F0D2D4",
      "soft": "#EDE1EB",
      "ink": "#303351",
      "muted": "#5A566D",
      "line": "#DCD2D9",
      "anchor": "#3F4173",
      "primary": "#3F4173",
      "on-primary": "#F7F0E8",
      "track": "#BA514B",
      "coral-ink": "#983E3B",
      "gold": "#ECBF53",
      "header": "#3F4173",
      "header-ink": "#F7F0E8",
      "heat-0": "#E7DBDE",
      "heat-1": "#DBA3A7",
      "heat-2": "#CC7B7D",
      "heat-3": "#BA514B",
      "heat-4": "#923D3F",
      "map-bg": "#F0D2D4",
      "map-route": "#BA514B",
      "map-context": "#3F4173",
      "map-halo": "#FFF9F4",
      "map-marker-ink": "#FFFFFF",
      "map-filter": "grayscale(.88) saturate(.25) contrast(.82) brightness(1.1)",
      "map-opacity": ".78",
      "shadow": "0 12px 42px #243D5A12",
      "blue": "var(--primary)",
      "blue-soft": "var(--soft)",
      "coral": "var(--track)"
    }
  },
  "night": {
    "scheme": "dark",
    "tokens": {
      "paper": "#16283F",
      "bg": "#101F33",
      "surface": "#203850",
      "panel": "#203850",
      "soft": "#2B425A",
      "ink": "#E9EEE7",
      "muted": "#B5C2CA",
      "line": "#354B62",
      "anchor": "#ECD2CE",
      "primary": "#EFC477",
      "on-primary": "#16283F",
      "track": "#D26F4A",
      "coral-ink": "#F2B6A1",
      "gold": "#EFC477",
      "header": "#16283F",
      "header-ink": "#E9EEE7",
      "heat-0": "#293F57",
      "heat-1": "#875B56",
      "heat-2": "#AB6652",
      "heat-3": "#D26F4A",
      "heat-4": "#F3A47E",
      "map-bg": "#16283F",
      "map-route": "#D26F4A",
      "map-context": "#A8BBC9",
      "map-halo": "#16283F",
      "map-marker-ink": "#111111",
      "map-filter": "invert(1) hue-rotate(180deg) grayscale(.85) brightness(.75) contrast(.9)",
      "map-opacity": ".7",
      "shadow": "0 12px 42px #060E1D40",
      "blue": "var(--primary)",
      "blue-soft": "var(--soft)",
      "coral": "var(--track)"
    }
  }
};

Object.assign(originalTimes.morning.tokens, {
  'activity-english': '#548e9c', 'activity-habits': '#b98a37',
  'map-fog': '#506b83', 'map-fog-opacity': '.28', 'map-reveal': '#D4E0E8', 'map-reveal-opacity': '0',
});
Object.assign(originalTimes.day.tokens, {
  'activity-english': '#6d88a5', 'activity-habits': '#b38a3a',
  'map-fog': '#655f7e', 'map-fog-opacity': '.27', 'map-reveal': '#D4E0E8', 'map-reveal-opacity': '0',
});
Object.assign(originalTimes.night.tokens, {
  'activity-english': '#89bec8', 'activity-habits': '#e7bd77',
  'map-fog': '#0b182a', 'map-fog-opacity': '.32', 'map-reveal': '#D4E0E8', 'map-reveal-opacity': '.42',
  'map-explored-filter': 'invert(1) hue-rotate(180deg) grayscale(.85) brightness(1.25) contrast(.58)',
  'map-explored-opacity': '.9',
  'art-ink': '#AEC0D3', 'art-wall': '#304A62', 'art-bg': '#233D52', 'art-paper': '#CCD7D6',
  'art-clay': '#BB826E', 'art-leaf': '#7F9D9D', 'art-sky': '#49657C', 'art-shadow': '#12253B', 'art-book-em': '#80522E',
});

// Atelier: warm paper at home, mineral greens outdoors, ink/violet for language.
// Each period changes the whole palette, not just the accent. Dark palettes keep
// text and controls bright while the surrounding surfaces recede.
function palette({ paper, bg, surface, panel, soft, ink, muted, line, anchor, track, coral, gold, heat, english, habits, dark = false }) {
  return { scheme: dark ? 'dark' : 'light', tokens: {
    paper, bg, surface, panel, soft, ink, muted, line, anchor, primary: dark ? gold : anchor,
    'on-primary': dark ? paper : surface, track, 'coral-ink': coral, gold,
    header: dark ? paper : anchor, 'header-ink': dark ? ink : surface,
    'heat-0': heat[0], 'heat-1': heat[1], 'heat-2': heat[2], 'heat-3': heat[3], 'heat-4': heat[4],
    'activity-english': english, 'activity-habits': habits,
    'map-bg': bg, 'map-route': track, 'map-context': dark ? muted : anchor,
    'map-halo': surface, 'map-marker-ink': dark ? paper : surface,
    'map-filter': dark ? 'invert(1) hue-rotate(180deg) grayscale(.85) brightness(.75) contrast(.9)' : 'grayscale(.88) saturate(.25) contrast(.82) brightness(1.1)',
    'map-opacity': dark ? '.7' : '.78', 'map-fog': dark ? paper : anchor, 'map-fog-opacity': dark ? '.32' : '.25',
    'map-reveal': dark ? muted : surface, 'map-reveal-opacity': dark ? '.42' : '0',
    'map-explored-filter': dark ? 'invert(1) hue-rotate(180deg) grayscale(.85) brightness(1.25) contrast(.58)' : 'grayscale(.88) saturate(.25) contrast(.82) brightness(1.1)',
    'map-explored-opacity': dark ? '.9' : '.78',
    shadow: dark ? '0 12px 42px #060E1D40' : '0 12px 42px #243D5A12',
    blue: 'var(--primary)', 'blue-soft': 'var(--soft)', coral: 'var(--track)',
    'art-ink': dark ? ink : anchor, 'art-wall': soft, 'art-bg': bg,
    'art-paper': dark ? ink : surface, 'art-clay': track, 'art-leaf': english,
    'art-sky': panel, 'art-shadow': dark ? paper : line, 'art-book-em': dark ? paper : coral,
  } };
}
const atelierHome = {
  morning: palette({ paper:'#F8F1E6', bg:'#EEE6D4', surface:'#FFFBF4', panel:'#EAD3BC', soft:'#F0E4D6', ink:'#41372F', muted:'#6D5D50', line:'#DCCDBE', anchor:'#665747', track:'#B85D45', coral:'#93432E', gold:'#D4AC65', heat:['#E9DFD2','#E3BDA1','#D2936F','#B85D45','#8D4934'], english:'#877394', habits:'#A37B31' }),
  day: palette({ paper:'#F3EDE3', bg:'#E5DCD0', surface:'#FFFAF2', panel:'#E4C4AC', soft:'#EDE0D2', ink:'#3C322B', muted:'#68574C', line:'#D6C7B8', anchor:'#6C4D3F', track:'#B4513E', coral:'#963D2D', gold:'#D7AA5E', heat:['#E6DCD0','#DFAF91','#CD8667','#B4513E','#873C31'], english:'#82718C', habits:'#997027' }),
  night: palette({ dark:true, paper:'#252327', bg:'#1D1D22', surface:'#343037', panel:'#42333A', soft:'#443B43', ink:'#F4EAE0', muted:'#C6B7B3', line:'#51454E', anchor:'#E8C8B1', track:'#E08C6F', coral:'#F3B29B', gold:'#E5BE82', heat:['#3D343C','#81544E','#AD6C57','#D68B69','#F4B494'], english:'#BDABCD', habits:'#DABB83' }),
};
const atelierRunning = {
  morning: palette({ paper:'#EFF3E9', bg:'#DFEAE0', surface:'#FAFCF4', panel:'#D8E4CE', soft:'#E2EADC', ink:'#29473C', muted:'#52685A', line:'#C9D7C6', anchor:'#3C6354', track:'#BB6748', coral:'#974D32', gold:'#DBC37A', heat:['#DDE5D5','#B6CCAB','#86A887','#547D62','#355C48'], english:'#578795', habits:'#9F802E' }),
  day: palette({ paper:'#EDF0E4', bg:'#D5E3DA', surface:'#F8FAEF', panel:'#CEDCBF', soft:'#DDE6D4', ink:'#28473B', muted:'#526651', line:'#C3D0BE', anchor:'#365B48', track:'#B35D3D', coral:'#924629', gold:'#CCB465', heat:['#D8E0CF','#B5C59E','#86A475','#54774B','#365833'], english:'#507C88', habits:'#94772B' }),
  night: palette({ dark:true, paper:'#172C29', bg:'#10221F', surface:'#234039', panel:'#2D493D', soft:'#314D44', ink:'#EAF0DF', muted:'#B3C8BA', line:'#3D5B4E', anchor:'#CCDEC1', track:'#E39868', coral:'#F1BD98', gold:'#DFCA8C', heat:['#29453B','#48634B','#688756','#92AC70','#CDDE98'], english:'#8AB6B5', habits:'#D7C78D' }),
};
const atelierEnglish = {
  morning: palette({ paper:'#F3EFF8', bg:'#E5DFF0', surface:'#FCF9FF', panel:'#DFD4EC', soft:'#EAE1F0', ink:'#443956', muted:'#695D7D', line:'#D6CCDF', anchor:'#6B5686', track:'#B66F66', coral:'#934C46', gold:'#D6B77D', heat:['#E7DDED','#C8B6DB','#A28ABC','#7A6297','#584370'], english:'#8E6AAB', habits:'#A47F3D' }),
  day: palette({ paper:'#EEEAF5', bg:'#DDD8EB', surface:'#FAF7FF', panel:'#D7CAE6', soft:'#E3D9ED', ink:'#3C3152', muted:'#655776', line:'#CCC2DA', anchor:'#5B477C', track:'#AC625D', coral:'#93463F', gold:'#CEAE70', heat:['#DDD5E8','#BAA8D2','#9A80B7','#75598F','#513969'], english:'#7F619E', habits:'#9C7735' }),
  night: palette({ dark:true, paper:'#252238', bg:'#1C1B2C', surface:'#343149', panel:'#42394E', soft:'#484059', ink:'#EFE8F6', muted:'#C1B5D2', line:'#514663', anchor:'#D8C4E5', track:'#D89194', coral:'#F0BCC1', gold:'#DFBF8A', heat:['#3D354D','#665076','#88709C','#B299C6','#D6BEE4'], english:'#C1A2DA', habits:'#DBC08B' }),
};
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const THEME_PACKS = deepFreeze([
  { id:'original', name:'オリジナル', description:'柔らかな朝、落ち着いた昼、深い紺の夜。今までの配色。', timeAware:true, pageAware:false, base:originalTimes.morning, times:originalTimes },
  { id:'atelier', name:'アトリエ', description:'ホームは暖かな紙、ランニングは緑、英会話はすみれ。時間とともに深まる配色。', timeAware:true, pageAware:true,
    base:atelierHome.morning, times:atelierHome,
    pages:{home:{times:atelierHome},records:{times:atelierRunning},english:{times:atelierEnglish}} },
]);

/** Resolution order: base → time → page base → page time. New pages use the common palette. */
export function resolveThemePack(definition, { mode='auto', page='home', date=new Date() } = {}) {
  mode = THEME_MODES.includes(mode) ? mode : 'auto';
  page = typeof page === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(page) ? page : 'home';
  const active = definition.timeAware ? (mode === 'auto' ? themeAt(date) : mode) : (definition.defaultTime || 'day');
  const pageDefinition = definition.pageAware && Object.hasOwn(definition.pages || {}, page) ? definition.pages[page] : null;
  const layers = [originalTimes.morning, definition.base, definition.timeAware && definition.times?.[active], pageDefinition?.base, definition.timeAware && pageDefinition?.times?.[active]].filter(Boolean);
  let scheme='light'; const tokens={};
  for (const layer of layers) { if (layer.scheme) scheme=layer.scheme; Object.assign(tokens, layer.tokens); }
  return { pack:definition.id, mode, page, active, scheme, tokens, variant:`${definition.id}:${pageDefinition ? page : 'common'}:${active}` };
}
export function resolveTheme({ pack=DEFAULT_THEME_PACK, ...options } = {}) {
  return resolveThemePack(THEME_PACKS.find(item => item.id === pack) || THEME_PACKS[0], options);
}
