// ============ 逐步導航引擎 ============
// GPS 追蹤、路線吸附、轉彎提示、語音播報、偏航重規劃、模擬導航
import {
  distance, bearing, snapToLine, cumulativeDistances, interpolate, fmtDistance,
} from './utils.js';
import { speak } from './voice.js';
import { fetchRoutes } from './routing.js';
import { config } from './config.js';

// ---- 轉彎圖示 ----
const MOD_ANGLES = {
  straight: 0, 'slight right': 35, right: 90, 'sharp right': 135,
  uturn: 180, 'sharp left': -135, left: -90, 'slight left': -35,
};

export function maneuverIconSVG(type, modifier, color = '#fff') {
  if (type === 'arrive') {
    return `<svg viewBox="0 0 48 48"><path fill="${color}" d="M24 4c-7.7 0-14 6.3-14 14 0 10.5 14 26 14 26s14-15.5 14-26c0-7.7-6.3-14-14-14zm0 19a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>`;
  }
  if (type && (type.includes('roundabout') || type.includes('rotary'))) {
    return `<svg viewBox="0 0 48 48"><g fill="none" stroke="${color}" stroke-width="5"><circle cx="24" cy="27" r="11"/></g><path fill="${color}" d="M24 2l8 11h-16z"/><rect fill="${color}" x="21" y="10" width="6" height="8"/></svg>`;
  }
  if (modifier === 'uturn') {
    return `<svg viewBox="0 0 48 48"><path fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" d="M17 42V20a9 9 0 0 1 18 0v8"/><path fill="${color}" d="M35 40l-8-11h16z"/></svg>`;
  }
  const angle = MOD_ANGLES[modifier] ?? 0;
  return `<svg viewBox="0 0 48 48"><g transform="rotate(${angle} 24 24)"><path fill="${color}" d="M24 5l11 15h-8v23h-6V20h-8z"/></g></svg>`;
}

/**
 * 單一車道箭頭圖示。
 * emphasis：'on' 亮白（可走方向）/ 'mid' 半亮（可走車道的其他方向）/ 'off' 變暗（不可走）
 */
export function laneIconSVG(direction, emphasis) {
  const color = emphasis === 'on' ? '#ffffff'
    : emphasis === 'mid' ? 'rgba(255,255,255,.5)'
    : 'rgba(255,255,255,.26)';
  const angle = MOD_ANGLES[direction] ?? 0;
  if (direction === 'uturn') {
    return `<svg viewBox="0 0 48 48"><path fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" d="M18 42V21a8 8 0 0 1 16 0v6"/><path fill="${color}" d="M34 38l-7-10h14z"/></svg>`;
  }
  return `<svg viewBox="0 0 48 48"><g transform="rotate(${angle} 24 24)"><path fill="${color}" d="M24 6l10 14h-7v22h-6V20h-7z"/></g></svg>`;
}

/**
 * 依可走車道位置合成詳細中文語音提示；不需提示時回傳 null
 * lanes: [{ active, activeDirection, directions }]，由左至右
 * modifier: 下一個轉彎方向（配合提示「準備左轉」等）
 */
function laneHint(lanes, modifier) {
  const n = lanes.length;
  const act = lanes.map((l, i) => (l.active ? i : -1)).filter((i) => i >= 0);
  if (!act.length || act.length === n) return null; // 全部可走就不用提醒
  const k = act.length;
  const L = act[0];
  const R = act[act.length - 1];
  const contiguous = R - L + 1 === k;
  let pos;
  if (contiguous && L === 0) {
    pos = k === 1 ? '請走最左側車道' : `請走左側 ${k} 條車道`;
  } else if (contiguous && R === n - 1) {
    pos = k === 1 ? '請走最右側車道' : `請走右側 ${k} 條車道`;
  } else if ((L + R) / 2 < (n - 1) / 2) {
    pos = `請走左邊第 ${act.map((i) => i + 1).join('、')} 車道`;
  } else {
    pos = `請走右邊第 ${act.map((i) => n - i).reverse().join('、')} 車道`;
  }
  const dirTxt = {
    left: '準備左轉', right: '準備右轉',
    'sharp left': '準備左轉', 'sharp right': '準備右轉',
    'slight left': '準備靠左', 'slight right': '準備靠右',
    uturn: '準備迴轉',
  }[modifier] || '';
  return `前方共 ${n} 線道，${pos}${dirTxt ? '，' + dirTxt : ''}`;
}

// ---- 測速照相 / 科技執法資料 ----
let CAMERAS = null;
let ENFORCE = null;

/** 載入內建的全台固定式測速照相與科技執法資料（政府開放資料） */
export async function loadSpeedCameras() {
  if (!CAMERAS) {
    try {
      CAMERAS = await (await fetch('data/speed-cameras.json')).json();
    } catch { CAMERAS = []; }
  }
  if (!ENFORCE) {
    try {
      ENFORCE = await (await fetch('data/enforcement.json')).json();
    } catch { ENFORCE = []; }
  }
}

function bearingToChar(brg) {
  if (brg >= 315 || brg < 45) return '北';
  if (brg < 135) return '東';
  if (brg < 225) return '南';
  return '西';
}

// ---- 自車圖標 ----
function createPuckElement() {
  const el = document.createElement('div');
  el.className = 'puck';
  el.innerHTML = `<svg viewBox="0 0 44 44">
    <circle cx="22" cy="22" r="20" fill="#1a73e8" opacity="0.25"/>
    <circle cx="22" cy="22" r="15" fill="#1a73e8" stroke="#fff" stroke-width="3"/>
    <path d="M22 12l7 15-7-4-7 4z" fill="#fff"/>
  </svg>`;
  return el;
}

export class Navigator {
  /**
   * callbacks: { onUpdate(state), onArrive(), onReroute(route), onError(msg), onFollowChange(bool) }
   */
  constructor(map, callbacks) {
    this.map = map;
    this.cb = callbacks;
    this.active = false;
    this.following = true;
    this.watchId = null;
    this.simTimer = null;
    this.puck = null;
    this.rerouting = false;
    this.offRouteCounter = 0;
    this.lastCamera = 0;
  }

  /** 開始導航。waypoints 為完整的 [起點, ...停靠點, 終點] */
  async start(route, { profile, waypoints, simulate = false }) {
    await loadSpeedCameras();
    this.stopTracking();
    this.active = true;
    this.simulate = simulate;
    this.profile = profile;
    this.waypoints = waypoints.slice();
    this.following = true;
    this.setRoute(route);

    if (!this.puck) {
      this.puck = new mapboxgl.Marker({
        element: createPuckElement(),
        rotationAlignment: 'map',
        pitchAlignment: 'map',
      }).setLngLat(this.navCoords[0]).addTo(this.map);
    }

    speak('開始導航。' + (this.flatSteps[0]?.step.maneuver.instruction || ''));

    if (simulate) this.startSimulation();
    else this.startGPS();
  }

  /** 設定 / 更新路線並重建導航幾何 */
  setRoute(route) {
    this.route = route;
    this.flatSteps = [];
    this.navCoords = [];
    route.legs.forEach((leg, legIndex) => {
      leg.steps.forEach((step) => {
        const coords = step.geometry.coordinates;
        const startIdx = Math.max(0, this.navCoords.length - 1);
        if (this.navCoords.length === 0) this.navCoords.push(...coords);
        else this.navCoords.push(...coords.slice(1));
        this.flatSteps.push({ step, legIndex, startIdx });
      });
    });
    this.cumDist = cumulativeDistances(this.navCoords);
    this.total = this.cumDist[this.cumDist.length - 1];
    this.flatSteps.forEach((fs, i) => {
      fs.startDist = this.cumDist[fs.startIdx];
    });
    for (let i = 0; i < this.flatSteps.length; i++) {
      this.flatSteps[i].endDist =
        i + 1 < this.flatSteps.length ? this.flatSteps[i + 1].startDist : this.total;
    }
    // 速限資料（依整體幾何線段索引）
    this.maxspeeds = [];
    for (const leg of route.legs) {
      if (leg.annotation && leg.annotation.maxspeed) {
        this.maxspeeds = this.maxspeeds.concat(leg.annotation.maxspeed);
      }
    }
    this.spoken = new Set();
    this.laneSpoken = new Set();
    this.currentStepIndex = 0;
    this.offRouteCounter = 0;
    this.simAlong = 0;
    this.computeRouteCameras();
    this.computeCongestionZones(route);
  }

  /** 找出路線沿途的測速照相桿與科技執法點（照相桿含拍攝方向比對，反向不列入） */
  computeRouteCameras() {
    this.routeCameras = [];
    this.camSpoken = new Set();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.navCoords) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
    const pad = 0.001; // 約 100 公尺
    const inBox = (lng, lat) =>
      lng >= minX - pad && lng <= maxX + pad && lat >= minY - pad && lat <= maxY + pad;

    for (const cam of CAMERAS || []) {
      const [lng, lat, limit, direct] = cam;
      if (!inBox(lng, lat)) continue;
      const snap = snapToLine([lng, lat], this.navCoords, this.cumDist);
      if (snap.dist > 50) continue;
      const dirChar = bearingToChar(this.bearingAt(snap.along));
      const dirChars = ['東', '西', '南', '北'].filter((ch) => direct.includes(ch));
      if (dirChars.length && !dirChars.includes(dirChar)) continue;
      this.routeCameras.push({ kind: 'speed', along: snap.along, lngLat: [lng, lat], limit });
    }
    for (const e of ENFORCE || []) {
      const [lng, lat, desc] = e;
      if (!inBox(lng, lat)) continue;
      const snap = snapToLine([lng, lat], this.navCoords, this.cumDist);
      if (snap.dist > 55) continue;
      this.routeCameras.push({ kind: 'tech', along: snap.along, lngLat: [lng, lat], desc });
    }
    this.routeCameras.sort((a, b) => a.along - b.along);
    // 同路口兩支相同取締項目的科技執法只保留一筆
    this.routeCameras = this.routeCameras.filter((c, i, arr) => {
      if (i === 0) return true;
      const p = arr[i - 1];
      return !(c.kind === 'tech' && p.kind === 'tech' && c.along - p.along < 35 && c.desc === p.desc);
    });
  }

  /** 從壅塞標註找出路線上的壅塞區段（heavy / severe） */
  computeCongestionZones(route) {
    this.congestionZones = [];
    this.congSpoken = new Set();
    let cong = [];
    for (const leg of route.legs || []) {
      if (leg.annotation && leg.annotation.congestion) cong = cong.concat(leg.annotation.congestion);
    }
    const geo = route.geometry.coordinates;
    if (!cong.length || geo.length < 2) return;
    const cum = cumulativeDistances(geo);
    const raw = [];
    let z = null;
    for (let i = 0; i < geo.length - 1 && i < cong.length; i++) {
      const bad = cong[i] === 'heavy' || cong[i] === 'severe';
      if (bad) {
        if (!z) z = { start: cum[i], end: cum[i + 1], severe: cong[i] === 'severe' };
        else { z.end = cum[i + 1]; if (cong[i] === 'severe') z.severe = true; }
      } else if (z) {
        raw.push(z);
        z = null;
      }
    }
    if (z) raw.push(z);
    // 中間有短暫順暢（<150 公尺）的壅塞區合併，且只保留 250 公尺以上的區段
    for (const r of raw) {
      const last = this.congestionZones[this.congestionZones.length - 1];
      if (last && r.start - last.end < 150) {
        last.end = r.end;
        last.severe = last.severe || r.severe;
      } else {
        this.congestionZones.push(r);
      }
    }
    this.congestionZones = this.congestionZones.filter((m) => m.end - m.start >= 250);
  }

  // ---- GPS 追蹤 ----
  startGPS() {
    if (!('geolocation' in navigator)) {
      this.cb.onError('此裝置不支援定位功能');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { longitude, latitude, heading, speed } = pos.coords;
        this.onPosition([longitude, latitude], heading, speed || 0);
      },
      (err) => {
        const msgs = { 1: '定位權限被拒絕，請在瀏覽器設定中允許定位。', 2: '無法取得位置訊號。', 3: '定位逾時。' };
        this.cb.onError(msgs[err.code] || '定位失敗');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  // ---- 模擬導航 ----
  startSimulation() {
    const TICK = 500; // ms
    this.simAlong = 0;
    this.simTimer = setInterval(() => {
      // 優先以該路段的最高速限行駛；沒有速限資料時退回路段平均速度
      let v = null;
      if (this.maxspeeds && this.maxspeeds.length) {
        const idx = Math.min(this.lowerBound(this.cumDist, this.simAlong), this.maxspeeds.length - 1);
        const ms = this.maxspeeds[idx];
        if (ms && ms.speed) {
          const kmh = ms.unit === 'mph' ? ms.speed * 1.609 : ms.speed;
          v = kmh / 3.6;
        }
      }
      if (v === null) {
        const fs = this.flatSteps[this.currentStepIndex];
        v = fs && fs.step.duration > 0 ? fs.step.distance / fs.step.duration : 12;
      }
      v = Math.max(3, Math.min(v, 34)); // 上限約 120 km/h
      this.simAlong = Math.min(this.simAlong + v * (TICK / 1000), this.total);
      const pt = this.pointAt(this.simAlong);
      const brg = this.bearingAt(this.simAlong);
      this.onPosition(pt, brg, v);
    }, TICK);
  }

  /** 依累積距離取得路線上的座標 */
  pointAt(d) {
    const i = this.lowerBound(this.cumDist, d);
    if (i >= this.navCoords.length - 1) return this.navCoords[this.navCoords.length - 1];
    const segLen = this.cumDist[i + 1] - this.cumDist[i];
    const t = segLen > 0 ? (d - this.cumDist[i]) / segLen : 0;
    return interpolate(this.navCoords[i], this.navCoords[i + 1], t);
  }

  bearingAt(d) {
    const i = Math.min(this.lowerBound(this.cumDist, d), this.navCoords.length - 2);
    return bearing(this.navCoords[i], this.navCoords[i + 1]);
  }

  /** 找到最後一個 arr[i] <= v 的索引 */
  lowerBound(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ---- 位置更新（GPS 與模擬共用） ----
  onPosition(lngLat, rawHeading, speedMs) {
    if (!this.active || this.rerouting) return;

    const snap = snapToLine(lngLat, this.navCoords, this.cumDist);
    const along = snap.along;

    // 行進方向：GPS heading 有效時優先，否則取路線切線方向
    let brg;
    if (rawHeading !== null && !Number.isNaN(rawHeading) && speedMs > 1.5) brg = rawHeading;
    else brg = this.bearingAt(along + 5);

    // 偏航偵測（模擬時不會發生）
    if (!this.simulate && snap.dist > config.offRouteThreshold) {
      this.offRouteCounter++;
      if (this.offRouteCounter >= config.offRouteCount) {
        this.reroute(lngLat, brg);
        return;
      }
    } else {
      this.offRouteCounter = 0;
    }

    const displayPos = snap.dist < 30 ? snap.point : lngLat;
    if (this.puck) {
      this.puck.setLngLat(displayPos);
      this.puck.setRotation(brg);
    }

    // 目前路段
    let csi = this.currentStepIndex;
    while (csi < this.flatSteps.length - 1 && along >= this.flatSteps[csi].endDist) csi++;
    this.currentStepIndex = csi;
    const cur = this.flatSteps[csi];
    const next = this.flatSteps[csi + 1] || null;
    const distToManeuver = Math.max(0, cur.endDist - along);

    // 語音播報：使用 API 提供的播報點（距路段終點的距離）
    const vis = cur.step.voiceInstructions || [];
    for (let i = 0; i < vis.length; i++) {
      const key = `${csi}:${i}`;
      if (!this.spoken.has(key) && distToManeuver <= vis[i].distanceAlongGeometry + 5) {
        this.spoken.add(key);
        speak(vis[i].announcement);
        break;
      }
    }

    // 車道指引：從 banner 指示的 sub 區塊取出車道資訊（由左至右）
    let lanes = null;
    const banners = cur.step.bannerInstructions || [];
    let activeBanner = null;
    for (const b of banners) {
      if (distToManeuver <= b.distanceAlongGeometry + 1) {
        if (!activeBanner || b.distanceAlongGeometry < activeBanner.distanceAlongGeometry) activeBanner = b;
      }
    }
    if (activeBanner && activeBanner.sub && activeBanner.sub.components) {
      const laneComps = activeBanner.sub.components.filter((c) => c.type === 'lane');
      if (laneComps.length) {
        lanes = laneComps.map((c) => ({
          active: !!c.active,
          activeDirection: c.active_direction || null,
          directions: c.directions && c.directions.length ? c.directions : ['straight'],
        }));
      }
    }
    // 車道語音提示：每個路口只說一次
    if (lanes && !this.laneSpoken.has(csi) && distToManeuver > 40) {
      this.laneSpoken.add(csi);
      const nextMod = this.flatSteps[csi + 1]
        ? this.flatSteps[csi + 1].step.maneuver.modifier
        : cur.step.maneuver.modifier;
      const hint = laneHint(lanes, nextMod);
      if (hint) speak(hint, { interrupt: false });
    }

    // 剩餘距離 / 時間
    const remainingDist = Math.max(0, this.total - along);
    let remainingDur = 0;
    const stepLen = cur.endDist - cur.startDist;
    if (stepLen > 0) remainingDur += cur.step.duration * (distToManeuver / stepLen);
    for (let i = csi + 1; i < this.flatSteps.length; i++) remainingDur += this.flatSteps[i].step.duration;

    // 速限（依距離比例對應到路線幾何）
    let speedLimit = null;
    if (this.maxspeeds.length) {
      const idx = Math.min(this.lowerBound(this.cumDist, along), this.maxspeeds.length - 1);
      const ms = this.maxspeeds[idx];
      if (ms && ms.speed) {
        speedLimit = ms.unit === 'mph' ? Math.round(ms.speed * 1.609) : ms.speed;
      }
    }

    // 測速照相 / 科技執法提醒
    let camera = null;
    const speedKmh = Math.round(Math.max(0, speedMs) * 3.6);
    if (this.routeCameras && this.routeCameras.length) {
      for (let i = 0; i < this.routeCameras.length; i++) {
        const c = this.routeCameras[i];
        if (c.along > along - 20) {
          const d = Math.max(0, c.along - along);
          if (d <= 800) {
            camera = { kind: c.kind, dist: d, limit: c.limit, desc: c.desc };
            if (!this.camSpoken.has(i) && d <= 500) {
              this.camSpoken.add(i);
              const dTxt = d >= 100 ? ` ${Math.round(d / 50) * 50} 公尺` : '';
              if (c.kind === 'speed') {
                speak(`前方${dTxt}測速照相${c.limit ? `，速限 ${c.limit}` : ''}`, { interrupt: false });
              } else {
                const short = (c.desc || '').split(/[、，,（(]/).slice(0, 2).join('、');
                speak(`前方${dTxt}科技執法${short ? `，取締${short}` : ''}`, { interrupt: false });
              }
            }
            if (c.kind === 'speed' && c.limit && speedKmh > c.limit && d <= 600 && !this.camSpoken.has('os' + i)) {
              this.camSpoken.add('os' + i);
              speak(`注意，您已超速，速限 ${c.limit}`, { interrupt: false });
            }
          }
          break;
        }
      }
    }

    // 前方壅塞預警
    let congestion = null;
    if (this.congestionZones && this.congestionZones.length) {
      for (let i = 0; i < this.congestionZones.length; i++) {
        const zn = this.congestionZones[i];
        if (zn.end > along + 50) {
          const d = zn.start - along;
          if (d <= 1500) {
            congestion = {
              dist: Math.max(0, d),
              len: zn.end - Math.max(zn.start, along),
              severe: zn.severe,
            };
            if (!this.congSpoken.has(i) && d <= 1000) {
              this.congSpoken.add(i);
              const where = d > 100 ? `前方 ${fmtDistance(d)}` : '前方';
              speak(`${where}${zn.severe ? '嚴重壅塞' : '車多壅塞'}，路段長約 ${fmtDistance(zn.end - zn.start)}`, { interrupt: false });
            }
          }
          break;
        }
      }
    }

    // 相機跟隨
    if (this.following) {
      const now = Date.now();
      if (now - this.lastCamera > 700) {
        this.lastCamera = now;
        const zoom = speedMs > 22 ? 16.2 : speedMs > 12 ? 17.2 : 18;
        this.map.easeTo({
          center: displayPos,
          bearing: brg,
          pitch: 55,
          zoom,
          duration: 900,
          padding: { top: Math.round(window.innerHeight * 0.35), bottom: 0, left: 0, right: 0 },
          essential: true,
        });
      }
    }

    // 抵達判定（最後一段且剩餘距離夠近）
    const isLastLeg = cur.legIndex === this.route.legs.length - 1;
    if (isLastLeg && remainingDist < config.arrivalThreshold) {
      this.finishArrival();
      return;
    }

    // 通知 UI
    const upcoming = next ? next.step.maneuver : cur.step.maneuver;
    this.cb.onUpdate({
      distToManeuver,
      lanes,
      camera,
      congestion,
      instruction: upcoming.instruction,
      iconSVG: maneuverIconSVG(upcoming.type, upcoming.modifier),
      nextInstruction:
        next && distToManeuver < 120 && this.flatSteps[csi + 2]
          ? this.flatSteps[csi + 2].step.maneuver.instruction
          : null,
      remainingDist,
      remainingDur,
      speedKmh,
      speedLimit,
    });
  }

  async reroute(currentPos, heading) {
    if (this.rerouting) return;
    this.rerouting = true;
    speak('偏離路線，正在重新規劃');
    try {
      // 只保留還沒經過的停靠點與終點
      const legIndex = this.flatSteps[this.currentStepIndex].legIndex;
      const remaining = this.waypoints.slice(legIndex + 1);
      const wps = [currentPos, ...remaining];
      const routes = await fetchRoutes(wps, this.profile, { bearing: heading });
      this.waypoints = wps;
      this.setRoute(routes[0]);
      this.cb.onReroute(routes[0]);
    } catch (e) {
      this.cb.onError('重新規劃失敗：' + e.message);
      this.offRouteCounter = 0;
    } finally {
      this.rerouting = false;
    }
  }

  finishArrival() {
    speak('您已抵達目的地，導航結束。');
    this.cb.onArrive();
    this.stop();
  }

  setFollowing(f) {
    this.following = f;
    this.cb.onFollowChange(f);
    if (f) this.lastCamera = 0;
  }

  /** 檢視整條路線（暫停跟隨） */
  overview() {
    this.setFollowing(false);
    const coords = this.navCoords;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );
    this.map.fitBounds(bounds, {
      padding: { top: 120, bottom: 140, left: 60, right: 60 },
      pitch: 0, bearing: 0, duration: 800,
    });
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.simTimer !== null) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  stop() {
    this.active = false;
    this.stopTracking();
    if (this.puck) {
      this.puck.remove();
      this.puck = null;
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
