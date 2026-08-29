// ============ 設定與 Mapbox 金鑰管理 ============
import { $ } from './utils.js';

const TOKEN_KEY = 'mapbox_token';

export const config = {
  language: 'zh-Hant',
  // 預設中心：台北 101（首次開啟、尚未取得定位時使用）
  defaultCenter: [121.5645, 25.0340],
  defaultZoom: 15,
  // 導航參數
  offRouteThreshold: 45,   // 偏離路線判定距離（公尺）
  offRouteCount: 3,        // 連續幾次偏離才重新規劃
  arrivalThreshold: 30,    // 抵達判定距離（公尺）
};

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** 顯示金鑰設定視窗；resolve 於使用者輸入有效格式的金鑰之後 */
export function promptForToken(errorMsg = '') {
  return new Promise((resolve) => {
    const modal = $('token-modal');
    const input = $('token-input');
    const errEl = $('token-error');
    modal.hidden = false;
    input.value = getToken();
    if (errorMsg) { errEl.textContent = errorMsg; errEl.hidden = false; }
    else errEl.hidden = true;

    const save = () => {
      const t = input.value.trim();
      if (!t.startsWith('pk.') || t.length < 20) {
        errEl.textContent = '金鑰格式不正確：應以「pk.」開頭。請確認複製的是 Public Token。';
        errEl.hidden = false;
        return;
      }
      setToken(t);
      modal.hidden = true;
      $('token-save').removeEventListener('click', save);
      resolve(t);
    };
    $('token-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    input.focus();
  });
}
