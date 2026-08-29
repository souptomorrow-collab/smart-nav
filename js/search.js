// ============ 地點搜尋（Mapbox Geocoding API） ============
import { getToken, config } from './config.js';
import { parseCoords, fmtCoords, debounce, escapeHtml } from './utils.js';

let proximity = null; // [lng, lat]，讓搜尋結果偏向使用者附近

export function setProximity(lngLat) {
  proximity = lngLat;
}

/**
 * 正向地理編碼（搜尋）。回傳 [{ name, address, lngLat }]
 */
export async function geocode(query, { limit = 6, signal } = {}) {
  const coords = parseCoords(query);
  if (coords) {
    return [{ name: fmtCoords(coords), address: '座標位置', lngLat: coords }];
  }
  const params = new URLSearchParams({
    access_token: getToken(),
    language: config.language,
    limit: String(limit),
    autocomplete: 'true',
  });
  if (proximity) params.set('proximity', proximity.join(','));
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`搜尋失敗（${res.status}）`);
  const data = await res.json();
  return (data.features || []).map((f) => ({
    name: f.text || f.place_name,
    address: f.place_name || '',
    lngLat: f.center,
  }));
}

/**
 * 反向地理編碼（座標 → 地名）。回傳 { name, address, lngLat }
 */
export async function reverseGeocode(lngLat) {
  const params = new URLSearchParams({
    access_token: getToken(),
    language: config.language,
    limit: '1',
  });
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lngLat[0]},${lngLat[1]}.json?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`查詢失敗（${res.status}）`);
  const data = await res.json();
  const f = (data.features || [])[0];
  if (!f) return { name: fmtCoords(lngLat), address: '未知位置', lngLat };
  return { name: f.text || f.place_name, address: f.place_name || '', lngLat };
}

/**
 * 為輸入框加上自動完成下拉選單。
 * dropdownEl 需為絕對定位的容器；onPick(place) 於選擇後呼叫。
 */
export function attachAutocomplete(inputEl, dropdownEl, onPick) {
  let items = [];
  let activeIndex = -1;
  let abortCtrl = null;

  const render = () => {
    if (!items.length) { dropdownEl.hidden = true; return; }
    dropdownEl.innerHTML = items
      .map(
        (p, i) => `<button class="dropdown-item${i === activeIndex ? ' active' : ''}" data-i="${i}">
          <div class="di-name">${escapeHtml(p.name)}</div>
          <div class="di-context">${escapeHtml(p.address)}</div>
        </button>`
      )
      .join('');
    dropdownEl.hidden = false;
  };

  const pick = (i) => {
    const p = items[i];
    if (!p) return;
    items = [];
    dropdownEl.hidden = true;
    inputEl.value = p.name;
    onPick(p);
  };

  const doSearch = debounce(async (q) => {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    try {
      items = await geocode(q, { signal: abortCtrl.signal });
      activeIndex = -1;
      render();
    } catch (e) {
      if (e.name !== 'AbortError') { items = []; render(); }
    }
  }, 300);

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim();
    if (q.length < 1) { items = []; render(); return; }
    doSearch(q);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (dropdownEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(activeIndex >= 0 ? activeIndex : 0);
    } else if (e.key === 'Escape') {
      items = [];
      render();
    }
  });

  dropdownEl.addEventListener('mousedown', (e) => {
    // 用 mousedown 以免輸入框先失焦
    const btn = e.target.closest('.dropdown-item');
    if (btn) { e.preventDefault(); pick(Number(btn.dataset.i)); }
  });

  inputEl.addEventListener('blur', () => {
    // 稍等一下讓點擊事件先處理
    setTimeout(() => { items = []; render(); }, 200);
  });

  return { close: () => { items = []; render(); } };
}
