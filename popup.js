'use strict';

const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
const openOptions = document.getElementById('openOptions');

function render(settings, bg) {
  const enabled = settings.enabled !== false;
  const engine = settings.engine === 'openai' ? 'OpenAI TTS' : 'Browser TTS';
  const deepl = settings.deeplKey ? '✓ ayarlı' : '✗ eksik';
  const sync = settings.syncEnabled !== false ? 'açık' : 'kapalı';

  statusEl.innerHTML =
    'Dublaj: <b>' + (enabled ? 'AÇIK' : 'KAPALI') + '</b><br>' +
    'Motor: <b>' + engine + '</b><br>' +
    'Sync: <b>' + sync + '</b><br>' +
    'DeepL anahtarı: <b>' + deepl + '</b>';

  toggleBtn.textContent = enabled ? 'Dublajı Durdur' : 'Dublajı Başlat';
  toggleBtn.className = enabled ? 'toggle-on' : 'toggle-off';
  toggleBtn.dataset.enabled = enabled ? '1' : '0';
}

function load() {
  chrome.storage.sync.get(null, (settings) => {
    render(settings || {});
  });
}

toggleBtn.addEventListener('click', () => {
  const next = toggleBtn.dataset.enabled !== '1';
  chrome.storage.sync.set({ enabled: next }, () => {
    // Aktif sekmeye haber ver
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'setEnabled', value: next }, () => {
          void chrome.runtime.lastError; // sekme content yoksa sessiz geç
        });
      }
    });
    load();
  });
});

openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

load();
