import { weatherLabel } from './weather.js';

/** A condition's shape and colour stay consistent across all weather views. */
export function weatherKind(code) {
  if (weatherLabel(code) === '不明') return 'unknown';
  if (code <= 1) return 'sunny';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  return 'rain';
}

export function weatherDaylight(sample, weather) {
  if (typeof sample?.isDay === 'boolean') return sample.isDay;
  if (!sample?.time || !weather?.sunrise || !weather?.sunset) return null;
  // Older caches do not have hourly is_day. Only use solar times for the
  // date they actually describe; do not assume tomorrow's sunrise.
  if (sample?.time?.slice(0, 10) === weather?.sunrise?.slice(0, 10)
      && sample?.time?.slice(0, 10) === weather?.sunset?.slice(0, 10)) {
    return Date.parse(sample.time) >= Date.parse(weather.sunrise)
      && Date.parse(sample.time) < Date.parse(weather.sunset);
  }
  return null;
}

export function weatherTone(sample, weather) {
  const kind = weatherKind(sample?.code);
  return weatherDaylight(sample, weather) === false && ['sunny', 'partly'].includes(kind) ? 'moon' : kind;
}

let glyphId = 0;
/** Local SVG, without requests or animation. Unique paint IDs survive several
 * instances (and the open forecast dialog) on the same page. */
export function weatherGlyph(sample, weather) {
  const kind = weatherKind(sample?.code), night = weatherDaylight(sample, weather) === false;
  const id = `weather-paint-${++glyphId}`, tone = weatherTone(sample, weather);
  const sun = `<circle cx="32" cy="31" r="24" fill="url(#${id}-halo)"/><g stroke="#dfa144" stroke-width="2.3" stroke-linecap="round"><path d="M32 8v4m0 38v4M9 31h4m38 0h4M16 15l3 3m26 26 3 3M16 47l3-3m26-26 3-3"/></g><circle cx="32" cy="31" r="14" fill="url(#${id}-sun)" stroke="#de9b38" stroke-width=".8"/><path d="M23 27a10 10 0 0 1 13-5" fill="none" stroke="#fff8db" stroke-opacity=".8" stroke-width="2" stroke-linecap="round"/>`;
  const moon = `<circle cx="31" cy="30" r="24" fill="url(#${id}-halo)"/><path d="M39 14a18 18 0 1 0 10 27A18 18 0 0 1 39 14Z" fill="url(#${id}-moon)" stroke="#929fcb" stroke-width=".9"/><path d="m46 10 1.3 3.7L51 15l-3.7 1.3L46 20l-1.3-3.7L41 15l3.7-1.3Z" fill="#a2b2dc"/><circle cx="52" cy="29" r="1.5" fill="#a2b2dc"/>`;
  const cloud = `<path d="M18 43C8 43 7 29 17 27c-1-13 20-18 25-5 13-4 21 17 7 21Z" fill="url(#${id}-cloud)" stroke="var(--weather-cloud-edge)" stroke-width="1.2"/><path d="M20 26c1-7 12-10 17-3" fill="none" stroke="var(--weather-cloud-light)" stroke-width="2" stroke-linecap="round"/>`;
  const rain = `<g fill="url(#${id}-rain)"><path d="M23 47c0 0-6 6-6 9a3 3 0 0 0 6 0c0-3 0-9 0-9Z"/><path d="M35 47s-6 6-6 9a3 3 0 0 0 6 0c0-3 0-9 0-9Z"/><path d="M47 47s-6 6-6 9a3 3 0 0 0 6 0c0-3 0-9 0-9Z"/></g>`;
  let drawing = kind === 'sunny' ? (night ? moon : sun) : cloud;
  if (kind === 'partly') drawing = `<g transform="translate(4 -3) scale(.74)">${night ? moon : sun}</g>${cloud}`;
  if (kind === 'rain') drawing = cloud + rain;
  if (kind === 'storm') drawing = cloud + `<path d="m34 40-9 12h7l-3 10 15-16h-8l5-6Z" fill="#e3b65b" stroke="#ba8732" stroke-width=".7"/><path d="m17 49-3 6m35-6-3 6" stroke="#649bd1" stroke-width="2.5" stroke-linecap="round"/>`;
  if (kind === 'snow') drawing = cloud + `<g stroke="#71aabd" stroke-width="1.7" stroke-linecap="round"><path d="M20 47v11m-4-8 8 5m-8 0 8-5M43 47v11m-4-8 8 5m-8 0 8-5"/></g>`;
  if (kind === 'fog') drawing = `<g opacity=".8">${cloud}</g><path d="M12 48h38M18 54h25M24 60h28" fill="none" stroke="#8c9eaf" stroke-width="2.4" stroke-linecap="round"/>`;
  if (kind === 'unknown') drawing = `<path d="M18 40h28" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/>`;
  return `<svg class="weather-glyph" data-weather="${tone}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><defs><radialGradient id="${id}-halo"><stop stop-color="${night ? '#afbfec' : '#efb548'}" stop-opacity=".3"/><stop offset="1" stop-color="${night ? '#afbfec' : '#efb548'}" stop-opacity="0"/></radialGradient><radialGradient id="${id}-sun" cx="35%" cy="28%" r="78%"><stop stop-color="#fff4b8"/><stop offset=".55" stop-color="#f6ce69"/><stop offset="1" stop-color="#e9a244"/></radialGradient><linearGradient id="${id}-moon" x2="1" y2="1"><stop stop-color="#edf3ff"/><stop offset="1" stop-color="#a4b7de"/></linearGradient><linearGradient id="${id}-cloud" x2="0" y2="1"><stop stop-color="var(--weather-cloud-light)"/><stop offset="1" stop-color="var(--weather-cloud-base)"/></linearGradient><linearGradient id="${id}-rain" x2="0" y2="1"><stop stop-color="#8ec5ee"/><stop offset="1" stop-color="#397cbd"/></linearGradient></defs>${drawing}</svg>`;
}
