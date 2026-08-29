// ============ 地點搜尋（Mapbox Geocoding API） ============
import { getToken, config } from './config.js';
import { parseCoords, fmtCoords, debounce, escapeHtml } from './utils.js';

let proximity = null; // [lng, lat]，讓搜尋結果偏向使用者附近

export function setProximity(lngLat) {
  proximity = lngLat;
}

/**
 * 正向地理編碼（搜尋）。回傳 [{ name, address, lngLat }]
 *
 * 策略：
 * 1. 查詢展開：台/臺 互換、學校名自動補「國立」前綴（口語常省略）
 * 2. 以 Search Box API 平行查詢所有變體並合併
 * 3. 沒有名稱高度吻合的結果時，加問 OSM Nominatim（台灣在地資料豐富）
 * 4. 全部落空時退回舊版 Geocoding API（純地址較強）
 * 最後依「名稱與輸入的吻合度」排序，避免字面拆開的模糊比對排在前面。
 */
export async function geocode(query, { limit = 6, signal } = {}) {
  const coords = parseCoords(query);
  if (coords) {
    return [{ name: fmtCoords(coords), address: '座標位置', lngLat: coords }];
  }

  const variants = buildVariants(query);
  const settled = await Promise.all(
    variants.map((v) =>
      searchBoxForward(v, { limit, signal }).catch((e) => {
        if (e.name === 'AbortError') throw e;
        return [];
      })
    )
  );
  let merged = rankAndDedupe(settled.flat(), query);

  if (!hasStrongMatch(merged, query)) {
    const nom = await nominatimSearch(variants, { signal }).catch(() => []);
    merged = rankAndDedupe(merged.concat(nom), query);
  }
  if (!merged.length) {
    merged = await legacyGeocode(query, { limit, signal }).catch(() => []);
  }
  return merged.slice(0, 8);
}

/** 正規化：小寫、台→臺、去空白，用於比對 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/台/g, '臺').replace(/[\s　]/g, '');
}

/** 產生查詢變體：原文、台/臺互換、補「國立」的學校名 */
function buildVariants(query) {
  const v = [query];
  let swapped = null;
  if (query.includes('台')) swapped = query.replace(/台/g, '臺');
  else if (query.includes('臺')) swapped = query.replace(/臺/g, '台');
  if (swapped && swapped !== query) v.push(swapped);
  const qn = norm(query);
  if (/(大學|學院|高中|中學|國中|國小|小學|科大)$/.test(qn) && !/^(國立|市立|縣立|私立)/.test(qn)) {
    v.push('國立' + query);
  }
  return v.slice(0, 3);
}

/** 名稱吻合度：完全相同 > 名稱包含輸入 > 輸入包含名稱 > 地址包含輸入 */
const MINOR_KINDS = new Set(['bus_stop', 'bicycle_rental', 'platform', 'stop_position', 'parking_entrance']);

function matchScore(item, qn) {
  if (!qn) return 0;
  const n = norm(item.name);
  const a = norm(item.address);
  let s = 0;
  if (n === qn) s = 120;
  else if (n.includes(qn)) s = 100;
  else if (qn.includes(n) && n.length >= 3) s = 90;
  else if (a.includes(qn)) s = 40;
  // 公車站、YouBike 站這類附屬設施降權，讓主體地標排前面
  if (s > 0 && MINOR_KINDS.has(item.kind)) s -= 25;
  return s;
}

function rankAndDedupe(items, query) {
  const qn = norm(query);
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    if (!it.lngLat) continue;
    const key = `${norm(it.name)}|${it.lngLat[0].toFixed(3)},${it.lngLat[1].toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }
  return unique
    .map((it, i) => ({ it, i, s: matchScore(it, qn) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.it);
}

function hasStrongMatch(items, query) {
  const qn = norm(query);
  return items.some((it) => matchScore(it, qn) >= 90);
}

/** OSM Nominatim：免金鑰的開放資料搜尋，台灣機構名稱涵蓋佳 */
async function nominatimSearch(variants, { signal }) {
  const qs = [variants[0]];
  const withPrefix = variants.find((v) => v.startsWith('國立'));
  if (withPrefix) qs.push(withPrefix);
  const settled = await Promise.all(
    qs.map(async (q) => {
      const params = new URLSearchParams({
        q, format: 'jsonv2', limit: '5', 'accept-language': 'zh-TW',
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((r) => ({
        name: r.name || (r.display_name || '').split(',')[0],
        address: r.display_name || '',
        lngLat: [parseFloat(r.lon), parseFloat(r.lat)],
        kind: r.type || '',
      }));
    })
  );
  return settled.flat();
}

/** Mapbox Search Box API：POI 涵蓋佳，支援中文地標名稱 */
async function searchBoxForward(query, { limit, signal }) {
  const params = new URLSearchParams({
    q: query,
    access_token: getToken(),
    language: config.language,
    limit: String(limit),
  });
  if (proximity) params.set('proximity', proximity.join(','));
  const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params}`, { signal });
  if (!res.ok) throw new Error(`搜尋失敗（${res.status}）`);
  const data = await res.json();
  return (data.features || []).map((f) => ({
    name: f.properties.name || f.properties.full_address || '',
    address: f.properties.full_address || f.properties.place_formatted || '',
    lngLat: f.geometry.coordinates,
  }));
}

/** 舊版 Geocoding API：當 Search Box 沒有結果時的地址備援 */
async function legacyGeocode(query, { limit, signal }) {
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
