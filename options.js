'use strict';

const DEFAULTS = {
  enabled: true,
  syncEnabled: true,
  deeplKey: '',
  sourceLang: '',
  openaiKey: '',
  engine: 'browser',
  browserVoice: '',
  openaiVoice: 'nova',
  openaiInstructions: '',
  protectedTermsText: '',
  pronunciationText: '',
  maxTtsRate: 2.5,
  duckingVolume: 0.15,
  showOriginal: true,
  compact: false
};

const TEXT_FIELDS = ['deeplKey', 'sourceLang', 'openaiKey', 'engine', 'browserVoice',
  'openaiVoice', 'openaiInstructions', 'protectedTermsText', 'pronunciationText'];
const CHECK_FIELDS = ['syncEnabled', 'showOriginal', 'compact'];
const RANGE_FIELDS = ['maxTtsRate', 'duckingVolume'];

function $(id) { return document.getElementById(id); }

// ---- Browser ses listesini doldur ----
function populateVoices(selected) {
  const sel = $('browserVoice');
  const voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  // Türkçe sesleri öne al
  const sorted = voices.slice().sort((a, b) => {
    const at = /^tr/i.test(a.lang) ? 0 : 1;
    const bt = /^tr/i.test(b.lang) ? 0 : 1;
    return at - bt;
  });
  // Mevcut "Otomatik" seçeneğini koru, gerisini yenile
  sel.length = 1;
  sorted.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = v.name + ' (' + v.lang + ')';
    sel.appendChild(opt);
  });
  if (selected) sel.value = selected;
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => populateVoices($('browserVoice').value);
}

// ---- Yükle ----
function load() {
  chrome.storage.sync.get(null, (raw) => {
    const s = Object.assign({}, DEFAULTS, raw || {});
    TEXT_FIELDS.forEach((f) => { if ($(f) != null) $(f).value = s[f] != null ? s[f] : ''; });
    CHECK_FIELDS.forEach((f) => { $(f).checked = !!s[f]; });
    RANGE_FIELDS.forEach((f) => {
      $(f).value = s[f];
      const lbl = $(f + 'Val');
      if (lbl) lbl.textContent = s[f];
    });
    populateVoices(s.browserVoice);
  });
}

// ---- Range etiketleri canlı güncelle ----
RANGE_FIELDS.forEach((f) => {
  $(f).addEventListener('input', () => {
    const lbl = $(f + 'Val');
    if (lbl) lbl.textContent = $(f).value;
  });
});

// ---- Kaydet ----
$('save').addEventListener('click', () => {
  const data = {};
  TEXT_FIELDS.forEach((f) => { data[f] = $(f).value; });
  CHECK_FIELDS.forEach((f) => { data[f] = $(f).checked; });
  RANGE_FIELDS.forEach((f) => { data[f] = parseFloat($(f).value); });

  chrome.storage.sync.set(data, () => {
    const saved = $('saved');
    saved.style.display = 'inline';
    setTimeout(() => { saved.style.display = 'none'; }, 1500);
  });
});

load();
