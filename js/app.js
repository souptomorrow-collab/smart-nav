// ============ 主程式：整合地圖、搜尋、路線、導航與 UI ============
import { getToken, promptForToken, clearToken, config } from './config.js';
import {
  $, toast, debounce, escapeHtml,
  fmtDistance, fmtDuration, fmtETA, fmtCoords,
} from './utils.js';
import { createMap, toggleStyle, toggleNight, toggleTraffic, toggle3D, mapState } from './map.js';
import { geocode, reverseGeocode, attachAutocomplete, setProximity } from './search.js';
import { fetchRoutes, drawRoutes, clearRoutes, fitToRoute, ensureRouteLayers } from './routing.js';
import { Navigator, maneuverIconSVG, laneIconSVG, loadSpeedCameras } from './navigation.js';
import { speak, setMuted, isMuted } from './voice.js';
import * as places from './places.js';

let map, geolocate;
let userLocation = null;       // [lng, lat]
let pendingRoute = false;      // 等待定位後再規劃
let currentPlace = null;
let destMarker = null;
let stopMarkers = [];
let navigating = false;
let navigator_ = null;

// 路線規劃狀態
const routeState = {
  stops: [{ myLocation: true }, null],   // { myLocation } | { name, lngLat } | null
  profile: 'driving-traffic',
  routes: null,
  selectedIndex: 0,
  waypoints: null,                        // 解析後的 [lng,lat] 陣列
};

// ============ 初始化 ============
async function init() {
  let token = getToken();
  if (!token) token = await promptForToken();

  ({ map, geolocate } = createMap(token));

  // 金鑰無效時重新要求
  let tokenErrorShown = false;
  map.on('error', (e) => {
    const status = e.error && (e.error.status || e.error.statusCode);
    if ((status === 401 || status === 403) && !tokenErrorShown) {
      tokenErrorShown = true;
      clearToken();
      promptForToken('這組金鑰無法使用（未授權）。請確認複製完整、以 pk. 開頭的 Public Token。')
        .then(() => location.reload());
    }
  });

  map.on('load', () => {
    geolocate.trigger(); // 嘗試定位到使用者位置
  });

  geolocate.on('geolocate', (pos) => {
    userLocation = [pos.coords.longitude, pos.coords.latitude];
    setProximity(userLocation);
    if (pendingRoute) {
      pendingRoute = false;
      tryRoute();
    }
  });

  // 樣式切換後補回路線圖層
  map.on('style.load', () => {
    if (routeState.routes) {
      drawRoutes(map, routeState.routes, routeState.selectedIndex);
    }
  });

  // 點選替代路線切換
  map.on('click', 'route-alts-line', (e) => {
    const f = e.features && e.features[0];
    if (f && routeState.routes) selectRoute(f.properties.idx);
  });
  map.on('mouseenter', 'route-alts-line', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'route-alts-line', () => { map.getCanvas().style.cursor = ''; });

  setupSearch();
  setupPlaceCard();
  setupRoutePanel();
  setupDrawer();
  setupContextMenu();
  setupMapTools();
  setupNavHUD();
  registerSW();
  loadSpeedCameras(); // 預載全台測速照相資料
}

// ============ 搜尋 ============
function setupSearch() {
  const input = $('search-input');
  attachAutocomplete(input, $('search-results'), (place) => {
    showPlace(place, { flyTo: true });
  });
  input.addEventListener('input', () => {
    $('search-clear').hidden = input.value.length === 0;
  });
  $('search-clear').addEventListener('click', () => {
    input.value = '';
    $('search-clear').hidden = true;
    closePlaceCard();
  });
  $('route-btn').addEventListener('click', () => {
    openRoutePanel();
  });
}

// ============ 地點卡 ============
function showPlace(place, { flyTo = false } = {}) {
  currentPlace = place;
  places.addHistory(place);
  hidePanels();
  $('place-name').textContent = place.name;
  $('place-address').textContent = place.address || '';
  $('place-coords').textContent = fmtCoords(place.lngLat);
  updateFavButton();
  $('place-card').hidden = false;

  if (destMarker) destMarker.remove();
  destMarker = new mapboxgl.Marker({ color: '#d93025' })
    .setLngLat(place.lngLat)
    .addTo(map);

  if (flyTo) map.flyTo({ center: place.lngLat, zoom: Math.max(map.getZoom(), 15.5), duration: 1200 });
}

function updateFavButton() {
  const fav = currentPlace && places.isFavorite(currentPlace.lngLat);
  $('place-fav').textContent = fav ? '★ 已收藏' : '☆ 收藏';
}

function closePlaceCard() {
  $('place-card').hidden = true;
  if (destMarker) { destMarker.remove(); destMarker = null; }
  currentPlace = null;
}

function setupPlaceCard() {
  $('place-close').addEventListener('click', closePlaceCard);
  $('place-fav').addEventListener('click', () => {
    if (!currentPlace) return;
    const added = places.toggleFavorite(currentPlace);
    toast(added ? '已加入收藏' : '已移除收藏');
    updateFavButton();
  });
  $('place-navigate').addEventListener('click', () => {
    if (!currentPlace) return;
    openRoutePanel({ dest: currentPlace });
  });
  $('place-origin').addEventListener('click', () => {
    if (!currentPlace) return;
    openRoutePanel({ origin: currentPlace });
  });
}

// ============ 路線規劃面板 ============
function openRoutePanel({ origin, dest } = {}) {
  hidePanels();
  $('place-card').hidden = true;
  if (origin) routeState.stops[0] = { name: origin.name, lngLat: origin.lngLat };
  if (dest) routeState.stops[routeState.stops.length - 1] = { name: dest.name, lngLat: dest.lngLat };
  $('route-panel').hidden = false;
  renderStops();
  tryRoute();
}

function closeRoutePanel({ keepRoute = false } = {}) {
  $('route-panel').hidden = true;
  if (!keepRoute) clearRouteState();
}

/** 清除路線的所有痕跡：路線圖層、轉彎點、起訖標記、照相圖示與結果卡片 */
function clearRouteState() {
  routeState.routes = null;
  routeState.waypoints = null;
  clearRoutes(map);
  clearRouteCameras();
  stopMarkers.forEach((m) => m.remove());
  stopMarkers = [];
  $('route-alternatives').innerHTML = '';
  $('route-actions').hidden = true;
}

function stopLabel(i, n) {
  if (i === 0) return '🟢';
  if (i === n - 1) return '🔴';
  return '🟡';
}

function renderStops() {
  const list = $('stops-list');
  list.innerHTML = '';
  const n = routeState.stops.length;
  routeState.stops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'stop-row';
    row.innerHTML = `
      <span class="stop-dot">${stopLabel(i, n)}</span>
      <input class="stop-input" placeholder="${i === 0 ? '起點（預設：我的位置）' : i === n - 1 ? '終點' : '停靠點'}" autocomplete="off">
      ${n > 2 ? '<button class="stop-remove" title="移除">✕</button>' : ''}
      <div class="stop-dropdown dropdown" hidden></div>`;
    const input = row.querySelector('.stop-input');
    const dropdown = row.querySelector('.stop-dropdown');
    input.value = stop ? (stop.myLocation ? '我的位置' : stop.name) : '';
    attachStopInput(input, dropdown, i);
    const removeBtn = row.querySelector('.stop-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        routeState.stops.splice(i, 1);
        renderStops();
        tryRoute();
      });
    }
    list.appendChild(row);
  });
}

/** 停靠點輸入框：自動完成 + 「我的位置」選項 */
function attachStopInput(input, dropdown, index) {
  let items = [];

  const render = () => {
    const myLoc = { name: '我的位置', address: '使用目前 GPS 位置', myLocation: true };
    const all = input.value.trim() === '' ? [myLoc] : [myLoc, ...items];
    dropdown.innerHTML = all.map((p, i) =>
      `<button class="dropdown-item" data-i="${i}">
        <div class="di-name">${p.myLocation ? '📍 ' : ''}${escapeHtml(p.name)}</div>
        <div class="di-context">${escapeHtml(p.address || '')}</div>
      </button>`).join('');
    dropdown._all = all;
    dropdown.hidden = false;
  };

  const doSearch = debounce(async (q) => {
    try {
      items = await geocode(q);
      render();
    } catch { /* 忽略 */ }
  }, 300);

  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q) doSearch(q);
    else { items = []; render(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 200));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && dropdown._all && dropdown._all.length) {
      e.preventDefault();
      pick(input.value.trim() === '' ? 0 : 1); // 有輸入文字時選第一個搜尋結果
    }
  });
  dropdown.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.dropdown-item');
    if (btn) { e.preventDefault(); pick(Number(btn.dataset.i)); }
  });

  const pick = (i) => {
    const p = dropdown._all && dropdown._all[i];
    if (!p) return;
    routeState.stops[index] = p.myLocation
      ? { myLocation: true }
      : { name: p.name, lngLat: p.lngLat };
    dropdown.hidden = true;
    input.value = p.myLocation ? '我的位置' : p.name;
    input.blur();
    tryRoute();
  };
}

function resolveStops() {
  const resolved = [];
  for (const stop of routeState.stops) {
    if (!stop) return null;
    if (stop.myLocation) {
      if (!userLocation) return 'need-location';
      resolved.push(userLocation);
    } else {
      resolved.push(stop.lngLat);
    }
  }
  return resolved.length >= 2 ? resolved : null;
}

async function tryRoute() {
  const errEl = $('route-error');
  errEl.hidden = true;
  const resolved = resolveStops();
  if (resolved === 'need-location') {
    pendingRoute = true;
    toast('正在取得你的位置…');
    geolocate.trigger();
    return;
  }
  if (!resolved) return; // 尚未填完起訖點

  $('route-loading').hidden = false;
  $('route-alternatives').innerHTML = '';
  $('route-actions').hidden = true;
  try {
    const routes = await fetchRoutes(resolved, routeState.profile);
    routeState.routes = routes;
    routeState.selectedIndex = 0;
    routeState.waypoints = resolved;
    drawRoutes(map, routes, 0);
    drawStopMarkers(resolved);
    fitToRoute(map, routes[0]);
    renderRouteCards();
    $('route-actions').hidden = false;
  } catch (e) {
    routeState.routes = null;
    clearRoutes(map);
    errEl.textContent = e.message;
    errEl.hidden = false;
  } finally {
    $('route-loading').hidden = true;
  }
}

function drawStopMarkers(waypoints) {
  stopMarkers.forEach((m) => m.remove());
  stopMarkers = waypoints.map((w, i) => {
    const isFirst = i === 0, isLast = i === waypoints.length - 1;
    const color = isFirst ? '#188038' : isLast ? '#d93025' : '#f9ab00';
    return new mapboxgl.Marker({ color, scale: isFirst || isLast ? 1 : 0.8 })
      .setLngLat(w)
      .addTo(map);
  });
}

function renderRouteCards() {
  const wrap = $('route-alternatives');
  const routes = routeState.routes;
  wrap.innerHTML = routes.map((r, i) => {
    const via = r.legs && r.legs[0] && r.legs[0].summary ? `經 ${escapeHtml(r.legs[0].summary)}` : '';
    // 與平常路況相比的延誤（driving-traffic 才有 duration_typical）
    let delayTxt = '';
    if (r.duration_typical) {
      const delayMin = Math.round((r.duration - r.duration_typical) / 60);
      if (delayMin >= 3) delayTxt = ` · <span class="rc-delay">車多 +${delayMin} 分</span>`;
      else if (delayMin <= -3) delayTxt = ' · <span class="rc-smooth">路況順暢</span>';
    }
    return `<button class="route-card${i === routeState.selectedIndex ? ' selected' : ''}" data-i="${i}">
      <div class="rc-main">
        <span class="rc-duration">${fmtDuration(r.duration)}</span>
        <span class="rc-distance">${fmtDistance(r.distance)}</span>
      </div>
      <div class="rc-via">${i === 0 ? '建議路線' : '替代路線'}${via ? ' · ' + via : ''} · 抵達 ${fmtETA(r.duration)}${delayTxt}</div>
    </button>`;
  }).join('') + renderStepsList(routes[routeState.selectedIndex]);

  wrap.querySelectorAll('.route-card').forEach((card) => {
    card.addEventListener('click', () => selectRoute(Number(card.dataset.i)));
  });
}

const STEP_LANE_PALETTE = { on: '#1a73e8', mid: '#8ab4f8', off: '#c9ced6' };

function renderStepsList(route) {
  const steps = [];
  for (const leg of route.legs) for (const s of leg.steps) steps.push(s);
  const items = steps.map((s, i) => {
    // 這一步的轉彎車道資訊掛在「上一步」的 banner sub 區塊
    let laneHtml = '';
    if (i > 0) {
      const banner = (steps[i - 1].bannerInstructions || []).find(
        (b) => b.sub && b.sub.components && b.sub.components.some((c) => c.type === 'lane')
      );
      if (banner) {
        const cells = banner.sub.components
          .filter((c) => c.type === 'lane')
          .map((c) => {
            const dirs = c.directions && c.directions.length ? c.directions : ['straight'];
            return dirs
              .map((d) => laneIconSVG(d, c.active ? 'on' : 'off', STEP_LANE_PALETTE))
              .join('');
          })
          .join('<span class="step-lane-sep"></span>');
        laneHtml = `<div class="step-lanes">${cells}</div>`;
      }
    }
    return `
    <div class="drawer-item">
      <span style="width:22px;height:22px;flex-shrink:0">${maneuverIconSVG(s.maneuver.type, s.maneuver.modifier, '#5f6368')}</span>
      <div class="drawer-item-main">
        <div class="di-name">${escapeHtml(s.maneuver.instruction)}</div>
        ${s.distance > 0 ? `<div class="di-context">${fmtDistance(s.distance)}</div>` : ''}
        ${laneHtml}
      </div>
    </div>`;
  }).join('');
  return `<details><summary class="text-btn" style="cursor:pointer;padding:6px 0">📋 檢視路線步驟（${steps.length} 步）</summary>${items}</details>`;
}

function selectRoute(i) {
  routeState.selectedIndex = i;
  drawRoutes(map, routeState.routes, i);
  renderRouteCards();
}

function setupRoutePanel() {
  $('route-close').addEventListener('click', () => {
    closeRoutePanel();
  });
  document.querySelectorAll('.profile-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.profile-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      routeState.profile = tab.dataset.profile;
      tryRoute();
    });
  });
  $('add-stop').addEventListener('click', () => {
    if (routeState.stops.length >= 12) { toast('停靠點數量已達上限'); return; }
    routeState.stops.splice(routeState.stops.length - 1, 0, null);
    renderStops();
  });
  $('swap-stops').addEventListener('click', () => {
    routeState.stops.reverse();
    renderStops();
    tryRoute();
  });
  $('start-nav').addEventListener('click', () => startNavigation(false));
  $('start-sim').addEventListener('click', () => startNavigation(true));
}

// ============ 導航 ============
function startNavigation(simulate) {
  if (!routeState.routes) return;
  const route = routeState.routes[routeState.selectedIndex];

  hidePanels();
  closeRoutePanel({ keepRoute: true });
  document.body.classList.add('navigating');
  $('topbar').hidden = true;
  $('map-tools').hidden = true;
  $('nav-hud').hidden = false;
  $('nav-mute').textContent = isMuted() ? '🔇' : '🔊';
  navigating = true;

  navigator_ = new Navigator(map, {
    onUpdate: updateNavHUD,
    onArrive: () => {
      toast('🏁 您已抵達目的地！');
      setTimeout(() => exitNavigation(true), 2500);
    },
    onReroute: (newRoute) => {
      routeState.routes = [newRoute];
      routeState.selectedIndex = 0;
      drawRoutes(map, [newRoute], 0);
      showRouteCameras();
      toast('已重新規劃路線');
    },
    onError: (msg) => toast(msg, 4000),
    onFollowChange: (f) => { $('recenter-btn').hidden = f; },
  });

  // 只顯示選定的路線
  drawRoutes(map, [route], 0);
  navigator_.start(route, {
    profile: routeState.profile,
    waypoints: routeState.waypoints,
    simulate,
  }).then(() => showRouteCameras());

  map.on('dragstart', onNavDrag);
}

// ---- 路線上的測速照相 / 科技執法圖示 ----
function makeAlertIcon(name, bgColor, emoji) {
  if (map.hasImage(name)) return;
  const c = document.createElement('canvas');
  c.width = c.height = 44;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(22, 22, 20, 0, Math.PI * 2);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 22, 23);
  map.addImage(name, ctx.getImageData(0, 0, 44, 44));
}

function showRouteCameras() {
  clearRouteCameras();
  const cams = (navigator_ && navigator_.routeCameras) || [];
  if (!cams.length) return;
  try {
    makeAlertIcon('cam-icon', '#c62828', '📷');
    makeAlertIcon('enf-icon', '#1565c0', '📸');
    map.addSource('nav-cameras', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: cams.map((c) => ({
          type: 'Feature',
          properties: { kind: c.kind },
          geometry: { type: 'Point', coordinates: c.lngLat },
        })),
      },
    });
    map.addLayer({
      id: 'nav-cameras-layer',
      type: 'symbol',
      source: 'nav-cameras',
      layout: {
        'icon-image': ['match', ['get', 'kind'], 'tech', 'enf-icon', 'cam-icon'],
        'icon-size': 0.9,
        'icon-allow-overlap': true,
      },
    });
  } catch { /* 樣式尚未就緒時忽略 */ }
}

function clearRouteCameras() {
  if (map.getLayer('nav-cameras-layer')) map.removeLayer('nav-cameras-layer');
  if (map.getSource('nav-cameras')) map.removeSource('nav-cameras');
}

function onNavDrag() {
  if (navigator_ && navigator_.active) navigator_.setFollowing(false);
}

let lastLanesKey = '';
let lastJunctionKey = null;

/** 把折線轉成帶圓角轉折的 SVG path */
function roundedPath(pts, r = 16) {
  if (pts.length < 3) {
    return 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const d1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r1 = Math.min(r, d1 / 2), r2 = Math.min(r, d2 / 2);
    const a = [p1[0] - ((p1[0] - p0[0]) / d1) * r1, p1[1] - ((p1[1] - p0[1]) / d1) * r1];
    const b = [p1[0] + ((p2[0] - p1[0]) / d2) * r2, p1[1] + ((p2[1] - p1[1]) / d2) * r2];
    d += ` L${a[0].toFixed(1)},${a[1].toFixed(1)} Q${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
  return d;
}

/** 路口放大圖：灰色路面構成完整路口、洋紅色路徑箭頭（Garmin 式） */
function renderJunctionSVG(jv) {
  const routeD = roundedPath(jv.route);
  const roadsD = jv.roads
    .map((r) => 'M' + r.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L'))
    .join(' ');
  const allRoadsD = `${routeD} ${roadsD}`;
  const [x1, y1] = jv.route[jv.route.length - 2];
  const [x2, y2] = jv.route[jv.route.length - 1];
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90;
  return `<svg viewBox="0 0 300 300">
    <rect width="300" height="300" fill="#eef2f5"/>
    <path d="${allRoadsD}" stroke="#b9c1c9" stroke-width="30" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${allRoadsD}" stroke="#e4e8eb" stroke-width="24" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" stroke="#d81b8c" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <g transform="translate(${x2.toFixed(1)},${y2.toFixed(1)}) rotate(${ang.toFixed(1)})">
      <path d="M0,-16 L11,8 L0,2 L-11,8 Z" fill="#d81b8c"/>
    </g>
  </svg>`;
}

function updateNavHUD(s) {
  $('nav-distance').textContent = fmtDistance(s.distToManeuver);
  $('nav-instruction').textContent = s.instruction;
  $('nav-icon').innerHTML = s.iconSVG;
  // 車道指引列（每條車道顯示其全部方向箭頭，可走方向亮白）
  if (s.lanes && s.lanes.length) {
    const key = s.lanes
      .map((l) => `${l.directions.join('+')}|${l.activeDirection || ''}|${l.active ? 1 : 0}`)
      .join(',');
    if (key !== lastLanesKey) {
      lastLanesKey = key;
      $('nav-lanes').innerHTML = s.lanes
        .map((l) => {
          const arrows = l.directions
            .map((d) => {
              const emph = !l.active ? 'off'
                : (!l.activeDirection || d === l.activeDirection) ? 'on' : 'mid';
              return laneIconSVG(d, emph);
            })
            .join('');
          return `<span class="lane${l.active ? ' active' : ''}">${arrows}</span>`;
        })
        .join('');
    }
    $('nav-lanes').hidden = false;
  } else {
    $('nav-lanes').hidden = true;
    lastLanesKey = '';
  }
  // 測速照相 / 科技執法警示
  if (s.camera) {
    if (s.camera.kind === 'tech') {
      const short = (s.camera.desc || '').slice(0, 14);
      $('nav-camera-text').textContent =
        `📸 科技執法 ${fmtDistance(s.camera.dist)}${short ? ` · ${short}` : ''}`;
      $('nav-camera').classList.remove('overspeed');
    } else {
      $('nav-camera-text').textContent =
        `📷 測速照相 ${fmtDistance(s.camera.dist)}${s.camera.limit ? ` · 速限 ${s.camera.limit}` : ''}`;
      $('nav-camera').classList.toggle('overspeed', !!(s.camera.limit && s.speedKmh > s.camera.limit));
    }
    $('nav-camera').hidden = false;
  } else {
    $('nav-camera').hidden = true;
  }
  // 路口放大圖
  if (s.junction) {
    if (s.junction.key !== lastJunctionKey) {
      lastJunctionKey = s.junction.key;
      $('junction-svg').innerHTML = renderJunctionSVG(s.junction);
    }
    $('junction-dist').textContent = fmtDistance(s.distToManeuver);
    $('nav-junction').hidden = false;
  } else {
    $('nav-junction').hidden = true;
    lastJunctionKey = null;
  }
  // 前方壅塞警示
  if (s.congestion) {
    $('nav-traffic-text').textContent =
      `🚗 ${s.congestion.severe ? '嚴重壅塞' : '車多壅塞'} ${s.congestion.dist < 100 ? '進入路段' : fmtDistance(s.congestion.dist)} · 長約 ${fmtDistance(s.congestion.len)}`;
    $('nav-traffic').classList.toggle('severe', !!s.congestion.severe);
    $('nav-traffic').hidden = false;
  } else {
    $('nav-traffic').hidden = true;
  }
  if (s.nextInstruction) {
    $('nav-next-text').textContent = s.nextInstruction;
    $('nav-next').hidden = false;
  } else {
    $('nav-next').hidden = true;
  }
  $('eta-time').textContent = fmtETA(s.remainingDur);
  $('eta-detail').textContent = `${fmtDuration(s.remainingDur)} · ${fmtDistance(s.remainingDist)}`;
  $('speed-value').textContent = s.speedKmh;
  if (s.speedLimit) {
    $('speed-limit-value').textContent = s.speedLimit;
    $('speed-limit').hidden = false;
  } else {
    $('speed-limit').hidden = true;
  }
}

function exitNavigation(clearAll = false) {
  if (navigator_) { navigator_.stop(); navigator_ = null; }
  navigating = false;
  document.body.classList.remove('navigating');
  clearRouteCameras();
  map.off('dragstart', onNavDrag);
  $('nav-hud').hidden = true;
  $('topbar').hidden = false;
  $('map-tools').hidden = false;
  $('recenter-btn').hidden = true;
  map.easeTo({
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
    pitch: mapState.is3D ? 45 : 0,
    duration: 800,
  });
  if (clearAll) {
    clearRouteState();
  } else if (routeState.routes) {
    drawRoutes(map, routeState.routes, routeState.selectedIndex);
    $('route-panel').hidden = false;
    renderStops();
  }
}

function setupNavHUD() {
  $('nav-exit').addEventListener('click', () => exitNavigation(false));
  $('nav-overview').addEventListener('click', () => { if (navigator_) navigator_.overview(); });
  $('recenter-btn').addEventListener('click', () => { if (navigator_) navigator_.setFollowing(true); });
  $('nav-mute').addEventListener('click', () => {
    const m = !isMuted();
    setMuted(m);
    $('nav-mute').textContent = m ? '🔇' : '🔊';
    toast(m ? '已靜音' : '已開啟語音');
  });
}

// ============ 收藏 / 歷史抽屜 ============
let drawerTab = 'favorites';

function setupDrawer() {
  $('menu-btn').addEventListener('click', () => {
    hidePanels();
    $('drawer').hidden = false;
    renderDrawer();
  });
  $('drawer-close').addEventListener('click', () => { $('drawer').hidden = true; });
  document.querySelectorAll('.drawer-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.drawer-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      drawerTab = tab.dataset.tab;
      renderDrawer();
    });
  });
}

function renderDrawer() {
  const list = $('drawer-list');
  const data = drawerTab === 'favorites' ? places.getFavorites() : places.getHistory();
  if (!data.length) {
    list.innerHTML = `<div class="drawer-empty">${drawerTab === 'favorites' ? '還沒有收藏的地點' : '沒有歷史紀錄'}</div>`;
    return;
  }
  list.innerHTML = data.map((p, i) => `
    <div class="drawer-item">
      <span>${drawerTab === 'favorites' ? '⭐' : '🕘'}</span>
      <button class="drawer-item-main" data-i="${i}">
        <div class="di-name">${escapeHtml(p.name)}</div>
        <div class="di-context">${escapeHtml(p.address || '')}</div>
      </button>
      <button class="icon-btn di-nav" data-i="${i}" title="導航">🧭</button>
      ${drawerTab === 'favorites' ? `<button class="icon-btn di-del" data-i="${i}" title="刪除">✕</button>` : ''}
    </div>`).join('') +
    (drawerTab === 'history'
      ? '<button class="text-btn" id="clear-history" style="margin-top:8px">清除全部歷史</button>'
      : '');

  list.querySelectorAll('.drawer-item-main').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = data[Number(btn.dataset.i)];
      $('drawer').hidden = true;
      showPlace(p, { flyTo: true });
    });
  });
  list.querySelectorAll('.di-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = data[Number(btn.dataset.i)];
      $('drawer').hidden = true;
      openRoutePanel({ dest: p });
    });
  });
  list.querySelectorAll('.di-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      places.removeFavorite(Number(btn.dataset.i));
      renderDrawer();
    });
  });
  const clearBtn = list.querySelector('#clear-history');
  if (clearBtn) clearBtn.addEventListener('click', () => { places.clearHistory(); renderDrawer(); });
}

// ============ 右鍵 / 長按選單 ============
let ctxLngLat = null;

function setupContextMenu() {
  const menu = $('ctx-menu');

  const show = (point, lngLat) => {
    ctxLngLat = [lngLat.lng, lngLat.lat];
    $('ctx-coords').textContent = fmtCoords(ctxLngLat);
    menu.style.left = `${Math.min(point.x, window.innerWidth - 200)}px`;
    menu.style.top = `${Math.min(point.y, window.innerHeight - 220)}px`;
    menu.hidden = false;
  };
  const hide = () => { menu.hidden = true; };

  map.on('contextmenu', (e) => {
    if (navigating) return;
    show(e.point, e.lngLat);
  });

  // 手機長按
  let pressTimer = null;
  map.on('touchstart', (e) => {
    if (navigating || e.points.length !== 1) return;
    const { point, lngLat } = e;
    pressTimer = setTimeout(() => show(point, lngLat), 600);
  });
  map.on('touchmove', () => clearTimeout(pressTimer));
  map.on('touchend', () => clearTimeout(pressTimer));

  map.on('click', hide);
  map.on('movestart', hide);

  $('ctx-navigate').addEventListener('click', async () => {
    hide();
    const p = await safeReverse(ctxLngLat);
    openRoutePanel({ dest: p });
  });
  $('ctx-origin').addEventListener('click', async () => {
    hide();
    const p = await safeReverse(ctxLngLat);
    openRoutePanel({ origin: p });
  });
  $('ctx-fav').addEventListener('click', async () => {
    hide();
    const p = await safeReverse(ctxLngLat);
    places.toggleFavorite(p);
    toast('已加入收藏');
  });
  $('ctx-whats-here').addEventListener('click', async () => {
    hide();
    const p = await safeReverse(ctxLngLat);
    showPlace(p);
  });
}

async function safeReverse(lngLat) {
  try {
    return await reverseGeocode(lngLat);
  } catch {
    return { name: fmtCoords(lngLat), address: '', lngLat };
  }
}

// ============ 地圖工具 ============
function setupMapTools() {
  $('tool-style').addEventListener('click', () => toggleStyle(map));
  $('tool-night').addEventListener('click', () => {
    const night = toggleNight(map);
    $('tool-night').classList.toggle('active', !!night);
  });
  $('tool-traffic').addEventListener('click', () => {
    const on = toggleTraffic(map);
    $('tool-traffic').classList.toggle('active', on);
  });
  $('tool-3d').addEventListener('click', () => {
    const on = toggle3D(map);
    $('tool-3d').classList.toggle('active', on);
  });
}

// ============ 其他 ============
function hidePanels() {
  $('drawer').hidden = true;
  $('place-card').hidden = true;
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 離線快取失敗不影響使用 */ });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('drawer').hidden = true;
    $('ctx-menu').hidden = true;
  }
});

init();
