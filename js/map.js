// ============ 地圖初始化與樣式 / 圖層控制 ============
import { config } from './config.js';
import { toast } from './utils.js';

export const mapState = {
  styleId: 'standard',      // 'standard' | 'satellite'
  night: false,
  traffic: false,
  is3D: true,
};

const STYLES = {
  standard: 'mapbox://styles/mapbox/standard',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

export function createMap(token) {
  mapboxgl.accessToken = token;
  const map = new mapboxgl.Map({
    container: 'map',
    style: STYLES.standard,
    center: config.defaultCenter,
    zoom: config.defaultZoom,
    pitch: 45,
    attributionControl: true,
    language: config.language,
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geolocate, 'top-right');

  map.on('style.load', () => {
    applyStyleConfig(map);
    if (mapState.traffic) addTrafficLayer(map);
  });

  return { map, geolocate };
}

function applyStyleConfig(map) {
  if (mapState.styleId !== 'standard') return;
  try {
    map.setConfigProperty('basemap', 'lightPreset', mapState.night ? 'night' : 'day');
    map.setConfigProperty('basemap', 'show3dObjects', mapState.is3D);
  } catch { /* 樣式不支援時忽略 */ }
}

// ---- 樣式切換 ----
export function toggleStyle(map) {
  mapState.styleId = mapState.styleId === 'standard' ? 'satellite' : 'standard';
  map.setStyle(STYLES[mapState.styleId]);
  toast(mapState.styleId === 'standard' ? '標準地圖' : '衛星影像');
}

export function toggleNight(map) {
  if (mapState.styleId !== 'standard') {
    toast('衛星影像不支援夜間模式');
    return;
  }
  mapState.night = !mapState.night;
  applyStyleConfig(map);
  toast(mapState.night ? '夜間模式' : '日間模式');
  return mapState.night;
}

export function toggle3D(map) {
  mapState.is3D = !mapState.is3D;
  map.easeTo({ pitch: mapState.is3D ? 55 : 0, duration: 600 });
  applyStyleConfig(map);
  toast(mapState.is3D ? '3D 檢視' : '2D 檢視');
  return mapState.is3D;
}

// ---- 即時路況圖層 ----
function addTrafficLayer(map) {
  if (map.getSource('traffic-src')) return;
  map.addSource('traffic-src', {
    type: 'vector',
    url: 'mapbox://mapbox.mapbox-traffic-v1',
  });
  map.addLayer({
    id: 'traffic-layer',
    type: 'line',
    source: 'traffic-src',
    'source-layer': 'traffic',
    slot: 'middle',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        8, 1, 12, 2.2, 16, 4.5,
      ],
      'line-color': [
        'match', ['get', 'congestion'],
        'low', '#43a047',
        'moderate', '#fb8c00',
        'heavy', '#e53935',
        'severe', '#7b1fa2',
        'rgba(0,0,0,0)',
      ],
    },
  });
}

function removeTrafficLayer(map) {
  if (map.getLayer('traffic-layer')) map.removeLayer('traffic-layer');
  if (map.getSource('traffic-src')) map.removeSource('traffic-src');
}

export function toggleTraffic(map) {
  mapState.traffic = !mapState.traffic;
  if (mapState.traffic) addTrafficLayer(map);
  else removeTrafficLayer(map);
  toast(mapState.traffic ? '已開啟即時路況' : '已關閉即時路況');
  return mapState.traffic;
}
