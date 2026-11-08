import test from 'node:test';
import assert from 'node:assert/strict';
import { getWeather, weatherIcon, weatherLabel, upcomingHours } from '../lib/weather.js';
import { weatherDaylight, weatherTone } from '../lib/weather-view.js';

test('forecast slots omit past hours and keep two-hour spacing across midnight', () => {
  const hours = ['22:00', '23:00', '00:00', '01:00', '02:00', '03:00', '04:00'].map((hour, i) => ({
    time: `2026-11-${i < 2 ? '07' : '08'}T${hour}+09:00`, rainProbability: i ? 20 : null,
  }));
  assert.deepEqual(upcomingHours({ hours }, { now: Date.parse('2026-11-07T22:30+09:00'), limit: 3 }),
    [hours[1], hours[3], hours[5]]);
  assert.deepEqual(upcomingHours({ hours }, { now: Date.parse(hours[0].time), limit: 1 }), [hours[0]]);
  assert.deepEqual(upcomingHours({ hours }, { now: Date.parse('2026-11-09T00:00+09:00') }), []);
  assert.deepEqual(upcomingHours(null), []);
});

const NOW = Date.parse('2026-11-07T03:00:00Z');
const COORDINATES = { latitude: 35.678912, longitude: 139.765432 };
function memoryStorage() {
  const entries = new Map();
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
function fixture() {
  return {
    utc_offset_seconds: 32400,
    current: { time: '2026-11-07T12:00', temperature_2m: 17, apparent_temperature: 16.1,
      weather_code: 1, wind_speed_10m: 2.5, is_day: 1 },
    hourly: { time: ['2026-11-07T12:00', '2026-11-07T13:00'],
      temperature_2m: [17, 18], precipitation_probability: [5, 20],
      weather_code: [1, 3], wind_speed_10m: [2.5, 3.2] },
    daily: { time: ['2026-11-07', '2026-11-08'],
      sunrise: ['2026-11-07T06:10', '2026-11-08T06:11'],
      sunset: ['2026-11-07T16:40', '2026-11-08T16:39'] },
  };
}
const response = (body = fixture()) => ({ ok: true, json: async () => body });
const options = (extra = {}) => ({ ...COORDINATES, storage: null, now: () => NOW, ...extra });

test('rounds coordinates before request and cache; returns documented units and offset times', async () => {
  const storage = memoryStorage();
  let requested;
  const result = await getWeather(options({ storage, fetcher: async (url, config) => {
    requested = url;
    const params = new URL(url).searchParams;
    assert.equal(params.get('latitude'), '35.7');
    assert.equal(params.get('longitude'), '139.8');
    assert.equal(params.get('wind_speed_unit'), 'ms');
    assert.equal(params.get('daily'), 'sunrise,sunset');
    assert.equal(params.get('forecast_hours'), '24');
    assert.equal(config.credentials, 'omit');
    assert.equal(config.referrerPolicy, 'no-referrer');
    return response();
  } }));
  assert.equal(result.source, 'Open-Meteo');
  assert.deepEqual(result.coordinates, { latitude: 35.7, longitude: 139.8 });
  assert.equal(result.current.time, '2026-11-07T12:00+09:00');
  assert.equal(result.sunrise, '2026-11-07T06:10+09:00');
  assert.equal(result.current.wind, 2.5);
  assert.equal(result.current.isDay, true);
  assert.equal(result.hours[1].rainProbability, 20);
  assert.equal(result.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual([...storage.entries.keys()], ['mypace.weather.v1.35.7.139.8']);
  for (const exact of ['35.678912', '139.765432']) {
    assert.ok(!requested.includes(exact));
    assert.ok(!JSON.stringify([...storage.entries]).includes(exact));
  }
});

test('cache is reused within the same rounded area for less than 20 minutes', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const fetcher = async () => { requests++; return response(); };
  await getWeather(options({ storage, fetcher }));
  await getWeather(options({ latitude: 35.71, longitude: 139.81, storage, fetcher, now: () => NOW + 1199999 }));
  assert.equal(requests, 1);
  await getWeather(options({ storage, fetcher, now: () => NOW + 1200000 }));
  assert.equal(requests, 2);
  await getWeather(options({ latitude: 36.1, storage, fetcher, now: () => NOW + 1200001 }));
  assert.equal(requests, 3);
});

test('hourly daylight survives the API and cache, including the following night', async () => {
  const body=fixture(),storage=memoryStorage();
  body.hourly.is_day=[1,0];
  let requests=0;
  const fetcher=async url=>{requests++;assert(new URL(url).searchParams.get('hourly').split(',').includes('is_day'));return response(body);};
  const fresh=await getWeather(options({storage,fetcher}));
  assert.deepEqual(fresh.hours.map(h=>h.isDay),[true,false]);
  const cached=await getWeather(options({storage,fetcher}));
  assert.deepEqual(cached.hours.map(h=>h.isDay),[true,false]);assert.equal(requests,1);
  assert.equal(weatherTone({...cached.hours[1],code:0},cached),'moon');
});

test('older forecasts use their own date’s sunrise, and missing weather is not rendered as sunshine', () => {
  const weather={sunrise:'2026-11-07T06:10+09:00',sunset:'2026-11-07T16:40+09:00'};
  assert.equal(weatherDaylight({time:'2026-11-07T06:09+09:00'},weather),false);
  assert.equal(weatherDaylight({time:'2026-11-07T06:10+09:00'},weather),true);
  assert.equal(weatherDaylight({time:'2026-11-07T16:40+09:00'},weather),false);
  assert.equal(weatherDaylight({time:'2026-11-08T12:00+09:00'},weather),null);
  assert.equal(weatherDaylight(undefined),null);
  assert.equal(weatherTone(undefined,weather),'unknown');
  assert.equal(weatherTone({code:63,isDay:false},weather),'rain');
});

test('malformed, future-dated, and mismatched caches do not become weather data', async () => {
  for (const corrupt of ['{', JSON.stringify({ source: 'Open-Meteo' }), 'null']) {
    const storage = memoryStorage();
    storage.setItem('mypace.weather.v1.35.7.139.8', corrupt);
    let requests = 0;
    const result = await getWeather(options({ storage, fetcher: async () => { requests++; return response(); } }));
    assert.equal(requests, 1);
    assert.equal(result.current.temperature, 17);
  }
  const storage = memoryStorage();
  await getWeather(options({ storage, fetcher: async () => response() }));
  let requests = 0;
  await getWeather(options({ storage, now: () => NOW - 1, fetcher: async () => { requests++; return response(); } }));
  assert.equal(requests, 1);
  const key = 'mypace.weather.v1.35.7.139.8';
  const poisoned = JSON.parse(storage.getItem(key));
  poisoned.coordinates.latitude = 0;
  storage.setItem(key, JSON.stringify(poisoned));
  await getWeather(options({ storage, fetcher: async () => { requests++; return response(); } }));
  assert.equal(requests, 2);
});

test('storage read/write failures and a blocked default storage getter are optional', async () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal((await getWeather(options({ storage, fetcher: async () => response() }))).source, 'Open-Meteo');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    assert.equal((await getWeather(options({ storage: undefined, fetcher: async () => response() }))).source, 'Open-Meteo');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('invalid coordinates are rejected before network and never reflected in errors', async () => {
  let requested = false;
  for (const coordinate of [{ latitude: 91 }, { longitude: Infinity }, { latitude: '35.678912' }, { latitude: null }]) {
    await assert.rejects(getWeather(options({ ...coordinate, fetcher: () => { requested = true; } })), error => {
      assert.equal(error.code, 'WEATHER_INVALID_LOCATION');
      assert.ok(!error.message.includes('35.678912'));
      return true;
    });
  }
  assert.equal(requested, false);
});

test('8-second deadline covers fetch even when it ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const pending = getWeather(options({ fetcher: (_url, config) => {
    requestSignal = config.signal;
    return new Promise(() => {});
  } }));
  const rejected = assert.rejects(pending, { code: 'WEATHER_TIMEOUT' });
  t.mock.timers.tick(7999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('8-second deadline also covers a stalled JSON body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let read = false;
  const pending = getWeather(options({ fetcher: async () => ({ ok: true,
    json: () => { read = true; return new Promise(() => {}); } }) }));
  const rejected = assert.rejects(pending, { code: 'WEATHER_TIMEOUT' });
  await Promise.resolve();
  assert.equal(read, true);
  t.mock.timers.tick(8000);
  await rejected;
});

test('caller cancellation aborts the request and hides arbitrary abort reasons', async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = getWeather(options({ signal: controller.signal, fetcher: (_url, config) => {
    requestSignal = config.signal;
    return new Promise(() => {});
  } }));
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'WEATHER_CANCELLED');
    assert.ok(!error.message.includes(String(COORDINATES.latitude)));
    return true;
  });
  controller.abort('sensitive location ' + COORDINATES.latitude);
  await rejected;
  assert.equal(requestSignal.aborted, true);
  let called = false;
  await assert.rejects(getWeather(options({ signal: controller.signal, fetcher: () => { called = true; } })),
    { code: 'WEATHER_CANCELLED' });
  assert.equal(called, false);
});

test('malformed responses never persist; optional probability and polar sunrise remain null', async () => {
  const mutations = [
    body => { body.current.temperature_2m = '17'; },
    body => { body.current.time = '2026-02-30T12:00'; },
    body => { body.current.weather_code = 1000; },
    body => { body.current.is_day = 2; },
    body => { body.hourly.is_day = [1,2]; },
    body => { body.hourly.is_day = [1]; },
    body => { body.hourly.temperature_2m.pop(); },
    body => { body.hourly.time.reverse(); },
    body => { body.hourly.precipitation_probability[0] = 101; },
    body => { body.daily.sunrise = []; },
    body => { body.utc_offset_seconds = '32400'; },
  ];
  for (const mutate of mutations) {
    const storage = memoryStorage();
    const body = fixture(); mutate(body);
    await assert.rejects(getWeather(options({ storage, fetcher: async () => response(body) })),
      { code: 'WEATHER_INVALID_RESPONSE' });
    assert.equal(storage.entries.size, 0);
  }
  const body = fixture();
  body.hourly.precipitation_probability[0] = null;
  body.daily.sunrise[0] = null;
  body.daily.sunset[0] = null;
  const result = await getWeather(options({ fetcher: async () => response(body) }));
  assert.equal(result.hours[0].rainProbability, null);
  assert.equal(result.sunrise, null);
  assert.equal(result.sunset, null);
});

test('network, HTTP and JSON errors do not leak location or response bodies', async () => {
  const sensitive = 'latitude=' + COORDINATES.latitude;
  const fetchers = [
    async () => { throw new Error(sensitive); },
    async () => ({ ok: false, json: async () => { throw new Error('must not read body'); } }),
    async () => ({ ok: true, json: async () => { throw new Error(sensitive); } }),
  ];
  for (const fetcher of fetchers) {
    await assert.rejects(getWeather(options({ fetcher })), error => {
      assert.ok(!error.message.includes(sensitive));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('WMO labels/icons include current documented thunderstorm code 97', () => {
  assert.equal(weatherLabel(0), '快晴');
  assert.equal(weatherIcon(1), 'sun');
  assert.equal(weatherIcon(3), 'cloud');
  assert.equal(weatherIcon(45), 'cloud');
  assert.equal(weatherIcon(66), 'rain');
  assert.equal(weatherIcon(86), 'snow');
  assert.equal(weatherIcon(97), 'storm');
  assert.equal(weatherLabel(97), '激しい雷雨');
  assert.equal(weatherLabel(null), '不明');
  assert.equal(weatherIcon('0'), 'cloud');
});
