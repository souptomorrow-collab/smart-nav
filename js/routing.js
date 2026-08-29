// ============ 路線規劃（Mapbox Directions API）與路線繪製 ============
import { getToken, config } from './config.js';
import { s2tw } from './utils.js';

/**
 * 向 Mapbox Directions API 要求路線。
 * waypoints: [[lng,lat], ...]（2 個以上）
 * profile: 'driving-traffic' | 'walking' | 'cycling'
 * options.bearing: 出發方位角（重新規劃時避免掉頭）
 * 回傳 API 的 routes 陣列（GeoJSON geometry、steps、annotations）
 */
export async function fetchRoutes(waypoints, profile, { bearing = null } = {}) {
  const coordsStr = waypoints.map((w) => `${w[0].toFixed(6)},${w[1].toFixed(6)}`).join(';');
  const isDriving = profile.startsWith('driving');
  const params = new URLSearchParams({
    access_token: getToken(),
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
    banner_instructions: 'true',
    voice_instructions: 'true',
    voice_units: 'metric',
    // Directions API 不支援 zh-Hant（會退回簡體），所以明確要 zh-Hans
    // 再由 s2tw() 轉成繁體
    language: 'zh-Hans',
  });
  // 替代路線只支援兩個點（無中途停靠）的情況
  if (waypoints.length === 2) params.set('alternatives', 'true');
  if (isDriving) {
    params.set('annotations', profile === 'driving-traffic' ? 'congestion,maxspeed' : 'maxspeed');
  }
  if (bearing !== null) {
    // 每個座標一組 bearing，僅指定第一個（目前行進方向 ±45 度）
    params.set('bearings', `${Math.round(bearing)},45${';'.repeat(waypoints.length - 1)}`);
  }
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordsStr}?${params}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') {
    const messages = {
      NoRoute: '找不到可行路線，請確認起訖點位置。',
      NoSegment: '起點或終點附近沒有道路。',
      InvalidInput: '路線參數不正確。',
    };
    throw new Error(messages[data.code] || data.message || `路線規劃失敗（${data.code}）`);
  }
  for (const route of data.routes) localizeRoute(route);
  return data.routes;
}

/** 把 API 回傳的簡體指示文字（畫面與語音）轉成繁體 */
function localizeRoute(route) {
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      if (step.maneuver && step.maneuver.instruction) {
        step.maneuver.instruction = s2tw(step.maneuver.instruction);
      }
      for (const vi of step.voiceInstructions || []) {
        vi.announcement = s2tw(vi.announcement);
      }
      if (step.name) step.name = s2tw(step.name);
    }
  }
}

// ============ 路線圖層繪製 ============

const CONGESTION_COLORS = {
  unknown: '#1a73e8',
  low: '#1a73e8',
  moderate: '#ff9800',
  heavy: '#e53935',
  severe: '#9c27b0',
};

/** 把選中的路線切成依壅塞程度著色的線段集合 */
function routeToCongestionFeatures(route) {
  const coords = route.geometry.coordinates;
  // 串接所有 leg 的壅塞資料（每段 leg 的 annotation 對應其幾何線段）
  let congestion = [];
  for (const leg of route.legs || []) {
    if (leg.annotation && leg.annotation.congestion) {
      congestion = congestion.concat(leg.annotation.congestion);
    }
  }
  if (!congestion.length) {
    return [{
      type: 'Feature',
      properties: { congestion: 'low' },
      geometry: { type: 'LineString', coordinates: coords },
    }];
  }
  // 合併連續同級別的線段，減少 feature 數量
  const features = [];
  let cur = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const level = congestion[i] || 'unknown';
    if (cur && cur.properties.congestion === level) {
      cur.geometry.coordinates.push(coords[i + 1]);
    } else {
      cur = {
        type: 'Feature',
        properties: { congestion: level },
        geometry: { type: 'LineString', coordinates: [coords[i], coords[i + 1]] },
      };
      features.push(cur);
    }
  }
  return features;
}

/** 首次建立路線相關的 source / layer（在 style 載入後呼叫） */
export function ensureRouteLayers(map) {
  if (map.getSource('route-alts')) return;

  map.addSource('route-alts', { type: 'geojson', data: emptyFC() });
  map.addSource('route-main', { type: 'geojson', data: emptyFC() });

  const slot = { slot: 'middle' }; // Standard 樣式的圖層插槽；傳統樣式會自動忽略

  map.addLayer({
    id: 'route-alts-casing', type: 'line', source: 'route-alts', ...slot,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#7d8a99', 'line-width': 8, 'line-opacity': 0.6 },
  });
  map.addLayer({
    id: 'route-alts-line', type: 'line', source: 'route-alts', ...slot,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#bcc7d4', 'line-width': 5 },
  });
  map.addLayer({
    id: 'route-main-casing', type: 'line', source: 'route-main', ...slot,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0b4aa2', 'line-width': 10 },
  });
  map.addLayer({
    id: 'route-main-line', type: 'line', source: 'route-main', ...slot,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': 6,
      'line-color': [
        'match', ['get', 'congestion'],
        'moderate', CONGESTION_COLORS.moderate,
        'heavy', CONGESTION_COLORS.heavy,
        'severe', CONGESTION_COLORS.severe,
        CONGESTION_COLORS.low,
      ],
    },
  });
  // 轉彎點白色圓點
  map.addSource('route-turns', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'route-turns-dots', type: 'circle', source: 'route-turns', ...slot,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 5.5],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0b4aa2',
      'circle-stroke-width': 1.5,
    },
  });
}

/**
 * 繪製路線。routes 為 API 回傳的路線陣列，selectedIndex 為目前選擇的路線。
 */
export function drawRoutes(map, routes, selectedIndex = 0) {
  ensureRouteLayers(map);
  const alts = routes
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => i !== selectedIndex)
    .map(({ r, i }) => ({
      type: 'Feature',
      properties: { idx: i },
      geometry: r.geometry,
    }));
  map.getSource('route-alts').setData({ type: 'FeatureCollection', features: alts });
  map.getSource('route-main').setData({
    type: 'FeatureCollection',
    features: routeToCongestionFeatures(routes[selectedIndex]),
  });
  // 選定路線的轉彎點（起點與終點除外）
  const turns = [];
  for (const leg of routes[selectedIndex].legs || []) {
    for (const step of leg.steps || []) {
      const t = step.maneuver && step.maneuver.type;
      if (t && t !== 'depart' && t !== 'arrive' && step.maneuver.location) {
        turns.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: step.maneuver.location },
        });
      }
    }
  }
  map.getSource('route-turns').setData({ type: 'FeatureCollection', features: turns });
}

export function clearRoutes(map) {
  if (!map.getSource('route-alts')) return;
  map.getSource('route-alts').setData(emptyFC());
  map.getSource('route-main').setData(emptyFC());
  if (map.getSource('route-turns')) map.getSource('route-turns').setData(emptyFC());
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

/** 讓地圖視野涵蓋整條路線 */
export function fitToRoute(map, route, padding = {}) {
  const coords = route.geometry.coordinates;
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new mapboxgl.LngLatBounds(coords[0], coords[0])
  );
  map.fitBounds(bounds, {
    padding: { top: 90, bottom: 60, left: 60, right: 60, ...padding },
    pitch: 0,
    bearing: 0,
    duration: 800,
  });
}
