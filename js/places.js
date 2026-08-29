// ============ 收藏地點與搜尋歷史（localStorage） ============

const FAV_KEY = 'nav_favorites';
const HIST_KEY = 'nav_history';
const HIST_MAX = 30;

function load(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 空間不足時忽略 */ }
}

/** place: { name, address, lngLat: [lng, lat] } */

export function getFavorites() {
  return load(FAV_KEY);
}

export function isFavorite(lngLat) {
  return getFavorites().some(
    (f) => Math.abs(f.lngLat[0] - lngLat[0]) < 1e-5 && Math.abs(f.lngLat[1] - lngLat[1]) < 1e-5
  );
}

export function toggleFavorite(place) {
  let favs = getFavorites();
  if (isFavorite(place.lngLat)) {
    favs = favs.filter(
      (f) => !(Math.abs(f.lngLat[0] - place.lngLat[0]) < 1e-5 && Math.abs(f.lngLat[1] - place.lngLat[1]) < 1e-5)
    );
    save(FAV_KEY, favs);
    return false;
  }
  favs.unshift({ name: place.name, address: place.address || '', lngLat: place.lngLat });
  save(FAV_KEY, favs);
  return true;
}

export function removeFavorite(index) {
  const favs = getFavorites();
  favs.splice(index, 1);
  save(FAV_KEY, favs);
}

export function getHistory() {
  return load(HIST_KEY);
}

export function addHistory(place) {
  let hist = getHistory();
  // 去除重複（同座標）
  hist = hist.filter(
    (h) => !(Math.abs(h.lngLat[0] - place.lngLat[0]) < 1e-5 && Math.abs(h.lngLat[1] - place.lngLat[1]) < 1e-5)
  );
  hist.unshift({ name: place.name, address: place.address || '', lngLat: place.lngLat, time: Date.now() });
  if (hist.length > HIST_MAX) hist.length = HIST_MAX;
  save(HIST_KEY, hist);
}

export function clearHistory() {
  save(HIST_KEY, []);
}
