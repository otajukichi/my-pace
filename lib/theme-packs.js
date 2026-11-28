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

// ILLIT's SE.A.L performance: four gingham colors, silver ties and charcoal
// tailoring, with pink light on a plum-black stage. See docs/DESIGN-DECISIONS.md.
// Running balances silver/charcoal surfaces with pink stage light. The blue
// check in one outfit is not a basis for making the whole running page blue.
// Reference: mnetplus.world/media/en/videos/6b0032ae5afa177d75764265
function sealPalette(values) {
  const result = palette(values);
  Object.assign(result.tokens, {
    header: values.dark ? '#17121F' : '#302B3C', 'header-ink': '#FFF7FC',
    primary: values.anchor, 'on-primary': values.dark ? '#211A2B' : '#FFFBFE',
    'seal-pink': values.dark ? '#F69AC8' : '#DC72AB',
    'seal-blue': values.dark ? '#9BBFFF' : '#739DE4',
    'seal-lemon': values.dark ? '#EEE6A4' : '#E7D88B',
    'seal-lilac': values.dark ? '#C7AFF1' : '#AE91D6',
    'seal-silver': values.dark ? '#C8C7D8' : '#C0C1CF',
    'seal-check': values.anchor,
    'art-ink': values.dark ? '#93809F' : values.anchor,
    'art-book-em': values.dark ? values.paper : values.gold,
    shadow: values.dark ? '0 14px 44px #130D234D' : '0 12px 38px #51445E14',
  });
  return result;
}
const sealHome = {
  morning: sealPalette({ paper:'#FCF5F7', bg:'#F4E6EF', surface:'#FFFBFE', panel:'#F5DCE9', soft:'#F4ECF2', ink:'#3B3045', muted:'#705D73', line:'#E4D5E2', anchor:'#884767', track:'#C94E91', coral:'#A03672', gold:'#E7D88B', heat:['#EEE3EC','#E8B6D1','#DC88B5','#C94E91','#923363'], english:'#8964B4', habits:'#947729' }),
  day: sealPalette({ paper:'#F8EFF4', bg:'#F0DBE9', surface:'#FFF9FD', panel:'#F2CEE2', soft:'#EDE3F0', ink:'#352B40', muted:'#6B566E', line:'#DECBDD', anchor:'#80415F', track:'#C13D87', coral:'#9E306C', gold:'#E8D77D', heat:['#E9DCE6','#E5ABCA','#D771A8','#BF4084','#8B2D61'], english:'#8056B0', habits:'#8C7022' }),
  night: sealPalette({ dark:true, paper:'#211A2B', bg:'#1B1424', surface:'#302537', panel:'#3D2A40', soft:'#3A3045', ink:'#F9F0F8', muted:'#C7B7CC', line:'#56405A', anchor:'#F1A1CA', track:'#ED83BB', coral:'#F4B1D6', gold:'#EDE1A0', heat:['#3B3044','#734362','#A25883','#D477A9','#F1ADD1'], english:'#B8A0E8', habits:'#E3CF86' }),
};
const sealRunning = {
  morning: sealPalette({ paper:'#F7F5F6', bg:'#ECE7EC', surface:'#FFFCFE', panel:'#F0DDE6', soft:'#EEE8EE', ink:'#37303B', muted:'#605564', line:'#DCD3DC', anchor:'#775468', track:'#C5538D', coral:'#923F69', gold:'#DCCC93', heat:['#E7E1E7','#DCC6D2','#C29AAF','#A66E8D','#7E456A'], english:'#937B9F', habits:'#907745' }),
  day: sealPalette({ paper:'#F2EEF2', bg:'#E7DEE8', surface:'#FCF9FC', panel:'#EBC7DC', soft:'#E8DFE8', ink:'#312B36', muted:'#584B5F', line:'#D4C7D5', anchor:'#75455F', track:'#C23D85', coral:'#8B285A', gold:'#DCCE96', heat:['#E2DAE2','#DBB2C9','#C784A8','#AD5487','#7E365E'], english:'#8B719A', habits:'#8B7340' }),
  night: sealPalette({ dark:true, paper:'#211E26', bg:'#17151D', surface:'#302A35', panel:'#452B3E', soft:'#3B3240', ink:'#F6F0F8', muted:'#C6B8CD', line:'#514353', anchor:'#F0A5CC', track:'#EC83BB', coral:'#F4BDD9', gold:'#DFD5AC', heat:['#35303C','#6A425B','#9B5D80','#C67AA4','#EEAACF'], english:'#C1AED0', habits:'#D3C395' }),
};
for (const theme of Object.values(sealRunning)) {
  const dark = theme.scheme === 'dark';
  Object.assign(theme.tokens, {
    header: dark ? '#15121A' : '#29252F',
    'seal-silver': dark ? '#D3CAD6' : '#C0BCC7',
    'seal-check': theme.tokens.track,
    'map-fog': dark ? '#18131E' : '#6D586D',
    'map-fog-opacity': dark ? '.32' : '.23',
    shadow: dark ? '0 14px 40px #120B1A48' : '0 12px 34px #49344913',
  });
}
const sealEnglish = {
  morning: sealPalette({ paper:'#F7F3FC', bg:'#EDE5F6', surface:'#FEFBFF', panel:'#E9DDF6', soft:'#F2E8F3', ink:'#3D324E', muted:'#6B5E7D', line:'#DFD4EB', anchor:'#6C4C94', track:'#CC589C', coral:'#A13C78', gold:'#E5D994', heat:['#EAE1F1','#D4BDE9','#B99CD5','#906DB7','#69488C'], english:'#9067BA', habits:'#91742A' }),
  day: sealPalette({ paper:'#F1ECF8', bg:'#E3D8F0', surface:'#FCF8FF', panel:'#DECCF0', soft:'#EDE1F0', ink:'#352A47', muted:'#625372', line:'#D3C4E3', anchor:'#63418A', track:'#C34491', coral:'#9B306C', gold:'#E4D384', heat:['#E3D8EE','#C6ABDF','#A685CA','#8258AC','#5E387F'], english:'#8051B0', habits:'#876B24' }),
  night: sealPalette({ dark:true, paper:'#211B31', bg:'#171323', surface:'#30273F', panel:'#3B2E4C', soft:'#3C304D', ink:'#F5EEFC', muted:'#C4B5D5', line:'#514064', anchor:'#D2B3F5', track:'#EF8DC7', coral:'#F4B0DD', gold:'#EBDEA0', heat:['#3B304C','#614778','#8660A6','#B084D1','#DBB5F8'], english:'#CCADF1', habits:'#E2CF8A' }),
};
sealEnglish.morning.tokens['art-book-em'] = '#EFE3B0';

// Tokyo Dome 2019: home borrows Silent Majority's blue tailoring and, at night,
// Fukyouwaon's cold screen geometry. Running keeps Glass wo Ware's crimson/black.
// English also draws on Ambivalent's official MV: white architecture, glass and
// reflected colour. These pale surfaces are an interpretation, not a stage replica.
// Sources: keyakizaka46.com/s/k46o/diary/detail/31071 (costume close-ups),
// keyakizaka46.com/s/k46o/contents/c_4x91rrW3g (official concert digest),
// youtube.com/watch?v=aeM6VF2XOn0 (Ambivalent MV).
function domePalette(values) {
  const result = palette(values);
  Object.assign(result.tokens, {
    header: values.dark ? '#0E151D' : '#1C242A', 'header-ink': '#F6F3E9',
    primary: values.anchor, 'on-primary': values.dark ? '#151C24' : '#FCFAF4',
    'dome-red': values.dark ? '#D6414E' : '#B92D40',
    'dome-metal': values.dark ? '#B9C3CA' : '#727C83',
    'dome-cold': values.dark ? '#68B6CD' : '#4A8293',
    'dome-screen': values.dark ? '#F3F4EB' : '#D8E2E3',
    'dome-band': '#10171E', 'dome-ember': '#E5AA71',
    'art-ink': values.dark ? '#7A8F9B' : values.anchor,
    'art-book-em': values.dark ? values.paper : '#E5DAC0',
    shadow: values.dark ? '0 14px 40px #03080F50' : '0 12px 32px #1D2B3615',
  });
  return result;
}
const domeHome = {
  morning: domePalette({ dark:true, paper:'#1B2B38', bg:'#12212D', surface:'#293F4E', panel:'#2A4B59', soft:'#354956', ink:'#F4F2E7', muted:'#C1CFD1', line:'#4A6068', anchor:'#E3C992', track:'#E57F79', coral:'#F1B0A1', gold:'#DCC38D', heat:['#2C414C','#3C6470','#4E8A97','#7DB8BD','#B8DBD7'], english:'#94C6D5', habits:'#DCC38D' }),
  day: domePalette({ dark:true, paper:'#142635', bg:'#0C1A27', surface:'#203B4B', panel:'#244B5C', soft:'#2D4554', ink:'#F3F2E8', muted:'#BBCCCF', line:'#3E5B68', anchor:'#E0C387', track:'#E67871', coral:'#F4ABA0', gold:'#D7B875', heat:['#263D4B','#315E72','#44879A','#6EB4C3','#A7DBDC'], english:'#8FC8DA', habits:'#DEC18A' }),
  night: domePalette({ dark:true, paper:'#0C1A29', bg:'#08111D', surface:'#182E40', panel:'#1B3A50', soft:'#243D52', ink:'#EEF3F3', muted:'#B0C6D3', line:'#314D63', anchor:'#BCDADD', track:'#EB747B', coral:'#F5A3AC', gold:'#D2BC8D', heat:['#1F3548','#2E526B','#387B9D','#63ACC8','#B2DBE4'], english:'#85C4D8', habits:'#D2BC8D' }),
};
const domeRunning = {
  morning: domePalette({ dark:true, paper:'#2A2025', bg:'#1D1820', surface:'#392A30', panel:'#642830', soft:'#463038', ink:'#FBF1EA', muted:'#D5C2C5', line:'#65454D', anchor:'#F1DED5', track:'#EA7372', coral:'#FFB9AE', gold:'#D8B68B', heat:['#433039','#78343D','#AE414D','#DE6269','#F6ACA0'], english:'#A8BCC9', habits:'#D5BB91' }),
  day: domePalette({ dark:true, paper:'#221A20', bg:'#16131A', surface:'#32232B', panel:'#60232E', soft:'#3F2934', ink:'#FAEEE8', muted:'#D0BEC3', line:'#5A3C49', anchor:'#EEDBD3', track:'#EF626C', coral:'#FFADB0', gold:'#D2B284', heat:['#382733','#6A2D3B','#A33748','#DB5362','#F89B9C'], english:'#9EBBC9', habits:'#D4BA90' }),
  night: domePalette({ dark:true, paper:'#140F18', bg:'#0D0B13', surface:'#251A25', panel:'#491C2B', soft:'#352132', ink:'#F8EEF0', muted:'#CBBBC9', line:'#4A2E42', anchor:'#EDCED0', track:'#F16B7D', coral:'#FFADBF', gold:'#D2B38E', heat:['#302031','#5B263B','#92364D','#CB4F67','#F399AA'], english:'#A2BED2', habits:'#D3BA94' }),
};
// White stays dominant throughout the day. Colour lives in reflected light,
// translucent planes and the illustrations; night becomes cooler, not black.
const domeEnglish = {
  morning: domePalette({ paper:'#F7F9F8', bg:'#E5EEF1', surface:'#FEFFFF', panel:'#E8E9F0', soft:'#EAF0EF', ink:'#2B3A46', muted:'#526471', line:'#CFDCE0', anchor:'#42586B', track:'#B57686', coral:'#8C4158', gold:'#C4B390', heat:['#E6ECEE','#CEDDE3','#AEC7D4','#7F9EB2','#4E6C85'], english:'#7799A1', habits:'#9B8155' }),
  day: domePalette({ paper:'#F5F7F8', bg:'#E4ECF2', surface:'#FDFEFE', panel:'#EEE6EE', soft:'#E8EFF1', ink:'#293644', muted:'#526170', line:'#D2DBE1', anchor:'#43576F', track:'#B17289', coral:'#88415E', gold:'#C9B994', heat:['#E5EAF0','#D3DCE7','#B4C4D9','#879DBA','#536B8C'], english:'#7F96B1', habits:'#9B8059' }),
  night: domePalette({ paper:'#EEF1F5', bg:'#D8E2EB', surface:'#F6F8FC', panel:'#E4DEEA', soft:'#E1E8ED', ink:'#2E384B', muted:'#4F6072', line:'#C4CFDB', anchor:'#46556E', track:'#AA7188', coral:'#823F5E', gold:'#B9AD98', heat:['#DCE3EC','#C5D1E1','#A8BBD2','#8095B2','#526987'], english:'#7A90AD', habits:'#947C60' }),
};
for (const [time, theme] of Object.entries(domeEnglish)) {
  Object.assign(theme.tokens, {
    'art-ink': '#596D7C', 'art-clay': time === 'night' ? '#BBA3BA' : '#CAA8B8',
    'art-leaf': time === 'morning' ? '#A3BFB6' : '#A6BABF',
    'art-sky': time === 'night' ? '#A6BDD4' : '#B7CEDC',
    'art-paper': theme.tokens.surface, 'art-wall': theme.tokens.soft,
    'art-bg': theme.tokens.bg, 'art-shadow': '#BBCAD4', 'art-book-em': '#F2D6E2',
    shadow: '0 12px 32px #51698212',
  });
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const THEME_PACKS = deepFreeze([
  { id:'original', name:'オリジナル', description:'柔らかな朝、落ち着いた昼、深い紺の夜。今までの配色。', timeAware:true, pageAware:false, base:originalTimes.morning, times:originalTimes },
  { id:'atelier', name:'アトリエ', description:'ホームは暖かな紙、ランニングは緑、英会話はすみれ。時間とともに深まる配色。', timeAware:true, pageAware:true,
    base:atelierHome.morning, times:atelierHome,
    pages:{home:{times:atelierHome},records:{times:atelierRunning},english:{times:atelierEnglish}} },
  { id:'illit-seal', name:'ILLIT · SE.A.L.', description:'チェックの軽やかさ、シルバーの艶、ピンクの舞台光。ILLITのステージから。', timeAware:true, pageAware:true,
    base:sealHome.morning, times:sealHome,
    pages:{home:{times:sealHome},records:{times:sealRunning},english:{times:sealEnglish}} },
  { id:'keyaki-dome', name:'欅坂46 · 東京ドーム', description:'深紅の緊張感、紺と金銀の輪郭、白に溶ける淡い光。4曲それぞれの世界から。', timeAware:true, pageAware:true,
    base:domeHome.morning, times:domeHome,
    pages:{home:{times:domeHome},records:{times:domeRunning},english:{times:domeEnglish}} },
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
