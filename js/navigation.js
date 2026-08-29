// ============ 逐步導航引擎 ============
// GPS 追蹤、路線吸附、轉彎提示、語音播報、偏航重規劃、模擬導航
import {
  distance, bearing, snapToLine, cumulativeDistances, interpolate,
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
  start(route, { profile, waypoints, simulate = false }) {
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
    this.currentStepIndex = 0;
    this.offRouteCounter = 0;
    this.simAlong = 0;
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
      // 依照目前路段的實際平均速度模擬前進
      const fs = this.flatSteps[this.currentStepIndex];
      const stepSpeed = fs && fs.step.duration > 0
        ? fs.step.distance / fs.step.duration
        : 12;
      const v = Math.max(3, Math.min(stepSpeed, 33));
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

    // 相機跟隨
    if (this.following) {
      const now = Date.now();
      if (now - this.lastCamera > 700) {
        this.lastCamera = now;
        const zoom = speedMs > 22 ? 15 : speedMs > 12 ? 16 : 16.8;
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
      instruction: upcoming.instruction,
      iconSVG: maneuverIconSVG(upcoming.type, upcoming.modifier),
      nextInstruction:
        next && distToManeuver < 120 && this.flatSteps[csi + 2]
          ? this.flatSteps[csi + 2].step.maneuver.instruction
          : null,
      remainingDist,
      remainingDur,
      speedKmh: Math.round(Math.max(0, speedMs) * 3.6),
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
