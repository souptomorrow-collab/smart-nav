// ============ 語音播報（Web Speech API） ============

let muted = false;
let voice = null;
let voicesLoaded = false;

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voicesLoaded = true;
  // 優先挑 Google 的台灣中文語音（俗稱「Google 小姐」，Chrome 內建），
  // 沒有的話依序退回其他台灣中文 / 任何中文語音
  const isZhTW = (v) => v.lang === 'zh-TW' || v.lang === 'zh_TW';
  voice =
    voices.find((v) => isZhTW(v) && v.name.includes('Google')) ||
    voices.find((v) => v.lang.startsWith('zh') && v.name.includes('Google')) ||
    voices.find(isZhTW) ||
    voices.find((v) => v.lang.startsWith('zh')) ||
    null;
}

if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

export function speak(text, { interrupt = true } = {}) {
  if (muted || !text || !('speechSynthesis' in window)) return;
  if (!voicesLoaded) pickVoice();
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-TW';
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.volume = 1;
  speechSynthesis.speak(u);
}

export function setMuted(m) {
  muted = m;
  if (m && 'speechSynthesis' in window) speechSynthesis.cancel();
}

export function isMuted() {
  return muted;
}
