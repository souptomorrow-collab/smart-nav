// ============ 地理計算與格式化工具 ============

const R = 6371008.8; // 地球半徑（公尺）
const D2R = Math.PI / 180;

/** 兩點間距離（公尺），輸入 [lng, lat] */
export function distance(a, b) {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** a 到 b 的方位角（度，0 = 北） */
export function bearing(a, b) {
  const φ1 = a[1] * D2R, φ2 = b[1] * D2R, Δλ = (b[0] - a[0]) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/** 沿 a→b 方向前進 dist 公尺後的座標 */
export function destination(a, dist, brg) {
  const δ = dist / R, θ = brg * D2R;
  const φ1 = a[1] * D2R, λ1 = a[0] * D2R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [λ2 / D2R, φ2 / D2R];
}

/** 兩點間線性插值 */
export function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * 把點 p 投影（吸附）到折線 coords 上。
 * cumDist 為預先算好的各頂點累積距離。
 * 回傳 { point, dist(偏離距離), along(沿線累積距離), segIndex }
 */
export function snapToLine(p, coords, cumDist) {
  let best = { point: coords[0], dist: Infinity, along: 0, segIndex: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    // 以簡化的平面投影計算（小範圍內足夠精確）
    const cosLat = Math.cos(p[1] * D2R);
    const ax = (a[0] - p[0]) * cosLat, ay = a[1] - p[1];
    const bx = (b[0] - p[0]) * cosLat, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    let t = 0;
    if (segLen2 > 0) t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / segLen2));
    const proj = interpolate(a, b, t);
    const d = distance(p, proj);
    if (d < best.dist) {
      best = {
        point: proj,
        dist: d,
        along: cumDist[i] + distance(a, proj),
        segIndex: i,
      };
    }
  }
  return best;
}

/** 折線各頂點的累積距離陣列 */
export function cumulativeDistances(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
  }
  return cum;
}

// ============ 格式化 ============

/** 公尺 → 「850 公尺」/「3.2 公里」 */
export function fmtDistance(m) {
  if (m < 10) return '10 公尺內';
  if (m < 1000) return `${Math.round(m / 10) * 10} 公尺`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m / 1000)} 公里`;
}

/** 秒 → 「5 分鐘」/「1 小時 20 分」 */
export function fmtDuration(s) {
  const min = Math.round(s / 60);
  if (min < 1) return '不到 1 分鐘';
  if (min < 60) return `${min} 分鐘`;
  return `${Math.floor(min / 60)} 小時 ${min % 60} 分`;
}

/** 現在 + 秒數 → 「14:35」 */
export function fmtETA(s) {
  const d = new Date(Date.now() + s * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 座標 → 「25.03399, 121.56451」 */
export function fmtCoords(lngLat) {
  return `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`;
}

/** 嘗試把輸入解析為「緯度,經度」座標 */
export function parseCoords(text) {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)[,，\s]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

// ============ DOM 小工具 ============

export const $ = (id) => document.getElementById(id);

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
