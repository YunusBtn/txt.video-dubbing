/*
 * background.js — MV3 service worker
 *
 * Sorumluluklar:
 *  - DeepL çeviri çağrıları (otomatik kaynak dil tespiti, çeviri önbelleği,
 *    teknik terim koruma, 3sn timeout).
 *  - OpenAI TTS çağrıları (gpt-4o-mini-tts), arraybuffer -> base64.
 *  - AbortController yönetimi: her prepareDub isteği bir controller'a bağlı,
 *    content "abortDub" gönderince (seek/rewind) iptal edilir.
 *  - Telaffuz sözlüğü uygulaması (TTS'e giden metni değiştirir).
 *
 * Mesajlar:
 *   prepareDub {id, text}     -> {ok, translatedText, ttsText?, audio?, mime?, fallback?}
 *   abortDub   {id}           -> (fire & forget)
 *   clearCache {}             -> önbelleği temizle (seek sonrası)
 *   getStatus  {}             -> {ok, hasDeepl, engine}
 */

'use strict';

// ---------------------------------------------------------------------------
// Ayarlar (chrome.storage.sync) — secret'lar burada tutulur, content'e gitmez
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: true,
  syncEnabled: true,
  deeplKey: '',
  sourceLang: '',           // '' => DeepL auto-detect
  openaiKey: '',
  engine: 'browser',        // 'browser' | 'openai'
  openaiVoice: 'nova',
  openaiInstructions: '',
  protectedTermsText: '',
  pronunciationText: '',
  maxTtsRate: 2.5,
  duckingVolume: 0.15
};

let settings = Object.assign({}, DEFAULTS);

async function loadSettings() {
  try {
    const s = await chrome.storage.sync.get(null);
    settings = Object.assign({}, DEFAULTS, s);
  } catch (e) {
    settings = Object.assign({}, DEFAULTS);
  }
}
loadSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') loadSettings();
});

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTerms(text) {
  // Her satır: "terim" veya "terim=terim". Tüm parçaları korunacak terim say.
  return (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      line.split('=').map((s) => s.trim()).filter(Boolean).forEach((t) => acc.push(t));
      return acc;
    }, []);
}

function parsePronun(text) {
  const map = {};
  (text || '').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && v) map[k] = v;
    }
  });
  return map;
}

function applyPronunciation(text) {
  const dict = parsePronun(settings.pronunciationText);
  let out = text;
  // Uzun anahtarları önce uygula (alt-string çakışmasını önlemek için)
  Object.keys(dict)
    .sort((a, b) => b.length - a.length)
    .forEach((k) => {
      const re = new RegExp('\\b' + escapeRegex(k) + '\\b', 'gi');
      out = out.replace(re, dict[k]);
    });
  return out;
}

function protectTerms(text) {
  const terms = parseTerms(settings.protectedTermsText);
  if (!terms.length) return { text, hasTags: false };
  let out = text;
  let hasTags = false;
  // Uzun terimler önce
  terms.sort((a, b) => b.length - a.length).forEach((t) => {
    const re = new RegExp('\\b' + escapeRegex(t) + '\\b', 'gi');
    out = out.replace(re, (m) => {
      hasTags = true;
      return '<x>' + m + '</x>';
    });
  });
  return { text: out, hasTags };
}

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function withTimeout(promise, ms, ctrl, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { ctrl.abort(); } catch (e) { /* noop */ }
      reject(new Error(label));
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ---------------------------------------------------------------------------
// Çeviri (DeepL) — önbellekli
// ---------------------------------------------------------------------------
const translationCache = new Map(); // key: sourceLang|text -> translated
const controllers = new Map();      // id -> AbortController

async function translate(text, ctrl) {
  const cacheKey = (settings.sourceLang || '') + '|' + text;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const key = (settings.deeplKey || '').trim();
  if (!key) throw new Error('no-deepl-key');

  const endpoint = key.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const protectedResult = protectTerms(text);
  const params = new URLSearchParams();
  params.append('text', protectedResult.text);
  params.append('target_lang', 'TR');
  if (settings.sourceLang) params.append('source_lang', settings.sourceLang);
  if (protectedResult.hasTags) {
    params.append('tag_handling', 'xml');
    params.append('ignore_tags', 'x');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString(),
    signal: ctrl.signal
  });

  if (!res.ok) throw new Error('deepl-http-' + res.status);
  const data = await res.json();
  let out = (data.translations && data.translations[0] && data.translations[0].text) || '';
  out = out.replace(/<\/?x>/g, ''); // koruma etiketlerini temizle

  translationCache.set(cacheKey, out);
  if (translationCache.size > 1500) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------
async function openaiTTS(text, ctrl) {
  const key = (settings.openaiKey || '').trim();
  if (!key) throw new Error('no-openai-key');

  const body = {
    model: 'gpt-4o-mini-tts',
    voice: settings.openaiVoice || 'nova',
    input: text,
    response_format: 'mp3'
  };
  if (settings.openaiInstructions) body.instructions = settings.openaiInstructions;

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: ctrl.signal
  });

  if (!res.ok) throw new Error('openai-http-' + res.status);
  const buf = await res.arrayBuffer();
  return abToBase64(buf);
}

// ---------------------------------------------------------------------------
// İstek işleyici
// ---------------------------------------------------------------------------
async function handlePrepare(msg) {
  const ctrl = new AbortController();
  controllers.set(msg.id, ctrl);
  try {
    // Çeviri 3sn içinde gelmezse "translate-timeout" hatası ver, akışı bloklama
    const translated = await withTimeout(translate(msg.text, ctrl), 3000, ctrl, 'translate-timeout');
    const ttsText = applyPronunciation(translated);

    if (settings.engine === 'openai') {
      if (!settings.openaiKey) {
        // Key yoksa Browser TTS'e düş, content kullanıcıyı uyarsın
        return { ok: true, translatedText: translated, ttsText, fallback: true };
      }
      const audio = await openaiTTS(ttsText, ctrl);
      return { ok: true, translatedText: translated, audio, mime: 'audio/mpeg' };
    }

    // Browser TTS: ses content tarafında üretilir, çevrilmiş + tts metni gönder
    return { ok: true, translatedText: translated, ttsText };
  } finally {
    controllers.delete(msg.id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'prepareDub') {
    handlePrepare(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === 'abortDub') {
    const c = controllers.get(msg.id);
    if (c) { try { c.abort(); } catch (e) { /* noop */ } }
    controllers.delete(msg.id);
    return;
  }

  if (msg.type === 'clearCache') {
    translationCache.clear();
    return;
  }

  if (msg.type === 'getStatus') {
    sendResponse({ ok: true, hasDeepl: !!settings.deeplKey, engine: settings.engine });
    return;
  }
});
