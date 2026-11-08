// Open-Meteo Forecast API: https://open-meteo.com/en/docs
// Importing this module never requests location or starts a network request.
// Returned temperatures are °C, wind is m/s, rainProbability is percent.
// Times include the forecast location's UTC offset; fetchedAt is UTC ISO 8601.
const CACHE_PREFIX = 'mypace.weather.v1.';
const CACHE_TTL = 20 * 60 * 1000;
const TIMEOUT = 8000;
const LABELS = new Map([
  [0, '快晴'], [1, '晴れ'], [2, '晴れ時々くもり'], [3, 'くもり'],
  [45, '霧'], [48, '着氷性の霧'], [51, '弱い霧雨'], [53, '霧雨'], [55, '強い霧雨'],
  [56, '凍る霧雨'], [57, '凍る霧雨'], [61, '小雨'], [63, '雨'], [65, '強い雨'],
  [66, '凍る雨'], [67, '凍る雨'], [71, '小雪'], [73, '雪'], [75, '大雪'], [77, '細かな雪'],
  [80, 'にわか雨'], [81, 'にわか雨'], [82, '激しい雨'], [85, 'にわか雪'], [86, '強い雪'],
  [95, '雷雨'], [96, '雷雨・ひょう'], [97, '激しい雷雨'], [99, '雷雨・ひょう'],
]);
const MESSAGES = {
  WEATHER_INVALID_LOCATION: '天気を調べる場所を選んでください。',
  WEATHER_INVALID_RESPONSE: '天気の情報を読み取れませんでした。',
  WEATHER_TIMEOUT: '天気の取得に時間がかかっています。もう一度お試しください。',
  WEATHER_CANCELLED: '天気の取得を中止しました。',
  WEATHER_UNAVAILABLE: '天気を取得できませんでした。時間をおいてお試しください。',
};

function fail(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

export function weatherLabel(code) {
  return LABELS.get(code) ?? '不明';
}

export function weatherIcon(code) {
  if (!LABELS.has(code)) return 'cloud';
  if (code <= 1) return 'sun';
  if (code >= 95) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if (code >= 51) return 'rain';
  return 'cloud';
}

/** Future forecast slots only; the current conditions have their own panel. */
export function upcomingHours(weather, { now = Date.now(), limit = 6 } = {}) {
  return (weather?.hours || []).filter(hour => Date.parse(hour.time) >= now)
    .filter((_, index) => index % 2 === 0).slice(0, limit);
}

function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw fail('WEATHER_INVALID_RESPONSE');
  }
  return value;
}

function code(value) {
  if (!LABELS.has(value)) throw fail('WEATHER_INVALID_RESPONSE');
  return value;
}

function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw fail('WEATHER_INVALID_RESPONSE');
  // Date.parse normalizes some impossible calendar dates; reject those too.
  const local = value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, '');
  if (!new Date(Date.parse(local + 'Z')).toISOString().startsWith(local)) {
    throw fail('WEATHER_INVALID_RESPONSE');
  }
  return value;
}

function localTime(value, offset) {
  if (value === null) return null; // Polar day/night can have no sunrise/sunset.
  if (typeof value !== 'string') throw fail('WEATHER_INVALID_RESPONSE');
  const minutes = Math.abs(offset) / 60;
  const zone = (offset < 0 ? '-' : '+')
    + String(Math.floor(minutes / 60)).padStart(2, '0') + ':'
    + String(minutes % 60).padStart(2, '0');
  return isoTime(value + zone);
}

function validateWeather(value, coordinates) {
  if (!value || value.source !== 'Open-Meteo'
      || value.coordinates?.latitude !== coordinates.latitude
      || value.coordinates?.longitude !== coordinates.longitude
      || !Array.isArray(value.hours) || !value.hours.length || value.hours.length > 48
      || typeof value.current?.isDay !== 'boolean') throw fail('WEATHER_INVALID_RESPONSE');
  if (value.hours.some(hour => hour?.isDay !== undefined && typeof hour.isDay !== 'boolean')) throw fail('WEATHER_INVALID_RESPONSE');
  const current = value.current;
  const result = {
    source: 'Open-Meteo',
    fetchedAt: isoTime(value.fetchedAt),
    coordinates: { ...coordinates },
    current: {
      time: isoTime(current.time),
      temperature: number(current.temperature, -120, 80),
      apparentTemperature: number(current.apparentTemperature, -150, 100),
      code: code(current.code), wind: number(current.wind, 0, 150), isDay: current.isDay,
    },
    hours: value.hours.map(hour => ({
      time: isoTime(hour?.time), temperature: number(hour?.temperature, -120, 80),
      rainProbability: hour?.rainProbability === null ? null : number(hour?.rainProbability, 0, 100),
      code: code(hour?.code), wind: number(hour?.wind, 0, 150),
      ...(hour.isDay === undefined ? {} : { isDay: hour.isDay }),
    })),
    sunrise: value.sunrise === null ? null : isoTime(value.sunrise),
    sunset: value.sunset === null ? null : isoTime(value.sunset),
  };
  if (result.hours.some((hour, index) => index > 0
      && Date.parse(hour.time) <= Date.parse(result.hours[index - 1].time))) {
    throw fail('WEATHER_INVALID_RESPONSE');
  }
  return result;
}

function normalize(body, coordinates, fetchedAt) {
  if (!body || body.error || !body.current || !body.hourly || !body.daily) {
    throw fail('WEATHER_INVALID_RESPONSE');
  }
  const offset = number(body.utc_offset_seconds, -50400, 50400);
  if (!Number.isInteger(offset) || offset % 60) throw fail('WEATHER_INVALID_RESPONSE');
  const hourly = body.hourly;
  const arrays = ['time', 'temperature_2m', 'precipitation_probability', 'weather_code', 'wind_speed_10m'];
  const count = hourly.time?.length;
  if (!Number.isInteger(count) || count < 1 || count > 48
      || arrays.some(key => !Array.isArray(hourly[key]) || hourly[key].length !== count)
      || ![0, 1].includes(body.current.is_day)) throw fail('WEATHER_INVALID_RESPONSE');
  if (hourly.is_day !== undefined && (!Array.isArray(hourly.is_day) || hourly.is_day.length !== count
      || hourly.is_day.some(value => ![0, 1].includes(value)))) throw fail('WEATHER_INVALID_RESPONSE');
  const daily = body.daily;
  if (!Array.isArray(daily.time) || !daily.time.length || daily.time.length > 16
      || !Array.isArray(daily.sunrise) || !Array.isArray(daily.sunset)
      || daily.sunrise.length !== daily.time.length || daily.sunset.length !== daily.time.length) {
    throw fail('WEATHER_INVALID_RESPONSE');
  }
  const currentTime = localTime(body.current.time, offset);
  if (!currentTime) throw fail('WEATHER_INVALID_RESPONSE');
  const dayIndex = daily.time.indexOf(currentTime.slice(0, 10));
  if (dayIndex < 0) throw fail('WEATHER_INVALID_RESPONSE');
  return validateWeather({
    source: 'Open-Meteo', fetchedAt, coordinates,
    current: {
      time: currentTime, temperature: body.current.temperature_2m,
      apparentTemperature: body.current.apparent_temperature,
      code: body.current.weather_code, wind: body.current.wind_speed_10m,
      isDay: body.current.is_day === 1,
    },
    hours: hourly.time.map((time, index) => ({
      time: localTime(time, offset), temperature: hourly.temperature_2m[index],
      rainProbability: hourly.precipitation_probability[index],
      code: hourly.weather_code[index], wind: hourly.wind_speed_10m[index],
      ...(hourly.is_day === undefined ? {} : { isDay: hourly.is_day[index] === 1 }),
    })),
    sunrise: localTime(daily.sunrise[dayIndex], offset),
    sunset: localTime(daily.sunset[dayIndex], offset),
  }, coordinates);
}

function localStorageOrNull(storage) {
  // Accessing the property itself may throw when browser storage is blocked.
  try { return storage === undefined ? globalThis.localStorage : storage; }
  catch { return null; }
}

function readCache(storage, key, coordinates, timestamp) {
  try {
    const result = validateWeather(JSON.parse(storage?.getItem(key) ?? 'null'), coordinates);
    const age = timestamp - Date.parse(result.fetchedAt);
    return age >= 0 && age < CACHE_TTL ? result : null;
  } catch { return null; }
}

/** Coordinates are rounded before either transmission or persistence. */
export async function getWeather({
  latitude, longitude, fetcher = globalThis.fetch, storage, now = () => Date.now(), signal,
} = {}) {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw fail('WEATHER_INVALID_LOCATION');
  }
  const coordinates = {
    latitude: Number(latitude.toFixed(1)), longitude: Number(longitude.toFixed(1)),
  };
  if (signal?.aborted) throw fail('WEATHER_CANCELLED');
  if (signal && (typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) throw fail('WEATHER_UNAVAILABLE');
  let timestamp;
  try { timestamp = now(); } catch { throw fail('WEATHER_UNAVAILABLE'); }
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8640000000000000) {
    throw fail('WEATHER_UNAVAILABLE');
  }
  const cache = localStorageOrNull(storage);
  const key = CACHE_PREFIX + coordinates.latitude.toFixed(1) + '.' + coordinates.longitude.toFixed(1);
  const cached = readCache(cache, key, coordinates, timestamp);
  if (cached) return cached;
  if (typeof fetcher !== 'function') throw fail('WEATHER_UNAVAILABLE');
  const query = new URLSearchParams({
    latitude: coordinates.latitude.toFixed(1), longitude: coordinates.longitude.toFixed(1),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,is_day',
    daily: 'sunrise,sunset', temperature_unit: 'celsius', wind_speed_unit: 'ms',
    timezone: 'auto', forecast_days: '2', forecast_hours: '24',
  });
  const controller = new AbortController();
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(fail('WEATHER_TIMEOUT'));
      controller.abort();
    }, TIMEOUT);
    onAbort = () => {
      reject(fail('WEATHER_CANCELLED'));
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const request = (async () => {
      const response = await fetcher('https://api.open-meteo.com/v1/forecast?' + query, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response?.ok || typeof response.json !== 'function') throw fail('WEATHER_UNAVAILABLE');
      let body;
      try { body = await response.json(); }
      catch { throw fail('WEATHER_INVALID_RESPONSE'); }
      return normalize(body, coordinates, new Date(timestamp).toISOString());
    })();
    const result = await Promise.race([request, interrupted]);
    try { cache?.setItem(key, JSON.stringify(result)); } catch { /* Cache is optional. */ }
    return result;
  } catch (error) {
    // Never propagate provider bodies, request URLs, abort reasons, or fetch errors.
    throw fail(Object.hasOwn(MESSAGES, error?.code) ? error.code : 'WEATHER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
