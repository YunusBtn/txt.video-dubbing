/*
 * content-shared.js — ortak çekirdek
 *
 * Burada:
 *  - Ayar yükleme (content tarafı; secret'lar background'da kalır)
 *  - computeIdealRate / estimateBrowserRate (hız adaptasyonu)
 *  - Overlay UI (çevrilmiş metin + opsiyonel orijinal + durum mesajı)
 *  - Ducking (dublaj sırasında orijinal sesi kısma)
 *  - TTS playback: Browser (Web Speech) ve OpenAI (Web Audio + crossfade)
 *  - Slot tabanlı pre-fetch scheduler (current + next, max 2 slot)
 *
 * Platform dosyaları (content-youtube.js / content-udemy.js) bir captionSource
 * ve getActiveVideo sağlar, sonra TRDUB.run(...) çağırır.
 *
 * captionSource interface:
 *   getActiveCue()            -> {text, startTime, endTime} | null
 *   onCueChange(cb)           -> disposer; cb(cue) yeni aktif cue gelince
 *   getNextCue(afterCue)      -> {text, startTime, endTime} | null  (lookahead)
 */

(function () {
  'use strict';

  const TRDUB = (window.TRDUB = window.TRDUB || {});
  if (TRDUB.__inited) return;
  TRDUB.__inited = true;

  // -------------------------------------------------------------------------
  // Ayarlar
  // -------------------------------------------------------------------------
  const DEFAULTS = {
    enabled: true,
    syncEnabled: true,
    engine: 'browser',
    browserVoice: '',
    maxTtsRate: 2.5,
    duckingVolume: 0.15,
    showOriginal: true,
    compact: false
  };
  let settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(null, (s) => {
          settings = Object.assign({}, DEFAULTS, s || {});
          applyOverlayMode();
          resolve(settings);
        });
      } catch (e) {
        resolve(settings);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Hız adaptasyonu
  // -------------------------------------------------------------------------
  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }
  TRDUB.clamp = clamp;

  // Taban dublaj hızı: hiçbir cümle bunun altında okunmaz (1.0x fazla yavaş
  // hissettiriyordu). Pencereye rahat sığan cümleler bile en az 1.38x okunur,
  // gerektiğinde maxTtsRate'e kadar hızlanır. (1.15 * 1.2 ≈ 1.38)
  const BASE_RATE = 1.38;
  TRDUB.BASE_RATE = BASE_RATE;

  // idealRate = max(BASE_RATE, audioDuration / (cueWindow / videoRate))
  // Video hızlandıkça gerçek pencere kısalır -> TTS daha da hızlanır.
  function computeIdealRate(audioDuration, cueWindowSeconds, videoRate, maxRate) {
    const vr = videoRate || 1;
    const mr = maxRate || 2.5;
    // Taban en az BASE_RATE * videoRate olsun (2x videoda taban da kayar)
    const floor = BASE_RATE * vr;
    if (!cueWindowSeconds || cueWindowSeconds <= 0) {
      // DOM modunda gerçek pencere yok -> taban hızla oku
      return clamp(floor, BASE_RATE, mr);
    }
    const effectiveWindow = cueWindowSeconds / vr;
    if (effectiveWindow <= 0 || !audioDuration) return clamp(floor, BASE_RATE, mr);
    const ideal = Math.max(floor, audioDuration / effectiveWindow);
    return clamp(ideal, BASE_RATE, mr);
  }
  TRDUB.computeIdealRate = computeIdealRate;

  // Browser TTS'te ses süresi önceden bilinmez; kelime sayısından tahmin et.
  function estimateSpeechDuration(text) {
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    // ~2.6 kelime/sn (≈156 kelime/dk) normal hızda
    return Math.max(0.6, words / 2.6);
  }
  TRDUB.estimateSpeechDuration = estimateSpeechDuration;

  function estimateBrowserRate(text, cueWindowSeconds, videoRate, maxRate) {
    const est = estimateSpeechDuration(text);
    return computeIdealRate(est, cueWindowSeconds, videoRate, maxRate);
  }
  TRDUB.estimateBrowserRate = estimateBrowserRate;

  // -------------------------------------------------------------------------
  // Overlay UI
  // -------------------------------------------------------------------------
  let overlayEl = null;
  let overlayMain = null;
  let overlayOrig = null;
  let overlayStatusEl = null;
  let statusTimer = null;

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'trdub-overlay';
    overlayEl.className = 'trdub-overlay';

    overlayMain = document.createElement('div');
    overlayMain.className = 'trdub-main';

    overlayOrig = document.createElement('div');
    overlayOrig.className = 'trdub-orig';

    overlayStatusEl = document.createElement('div');
    overlayStatusEl.className = 'trdub-status';

    overlayEl.appendChild(overlayStatusEl);
    overlayEl.appendChild(overlayMain);
    overlayEl.appendChild(overlayOrig);
    (document.body || document.documentElement).appendChild(overlayEl);
    applyOverlayMode();
  }

  function applyOverlayMode() {
    if (!overlayEl) return;
    overlayEl.classList.toggle('trdub-compact', !!settings.compact);
    if (overlayOrig) overlayOrig.style.display = settings.showOriginal ? '' : 'none';
  }

  function overlayText(translated, original) {
    ensureOverlay();
    overlayEl.classList.add('trdub-visible');
    overlayMain.textContent = translated || '';
    if (settings.showOriginal) {
      overlayOrig.textContent = original || '';
      overlayOrig.style.display = original ? '' : 'none';
    }
  }
  TRDUB.overlayText = overlayText;

  function overlayStatus(msg) {
    ensureOverlay();
    overlayStatusEl.textContent = msg || '';
    overlayStatusEl.style.display = msg ? '' : 'none';
    if (statusTimer) clearTimeout(statusTimer);
    if (msg) {
      statusTimer = setTimeout(() => {
        if (overlayStatusEl) overlayStatusEl.style.display = 'none';
      }, 2500);
    }
  }
  TRDUB.overlayStatus = overlayStatus;

  function overlayHide() {
    if (overlayEl) overlayEl.classList.remove('trdub-visible');
  }
  TRDUB.overlayHide = overlayHide;

  // -------------------------------------------------------------------------
  // Ducking (orijinal sesi kısma)
  // -------------------------------------------------------------------------
  function duck(video) {
    if (!video) return;
    if (video.dataset.trdubOrigVol === undefined) {
      video.dataset.trdubOrigVol = String(video.volume);
    }
    video.volume = clamp(settings.duckingVolume, 0, 1);
  }
  TRDUB.duck = duck;

  function unduck(video) {
    if (!video) return;
    if (video.dataset.trdubOrigVol !== undefined) {
      const v = parseFloat(video.dataset.trdubOrigVol);
      if (!isNaN(v)) video.volume = v;
      delete video.dataset.trdubOrigVol;
    }
  }
  TRDUB.unduck = unduck;

  // -------------------------------------------------------------------------
  // Web Audio context (crossfade için)
  // -------------------------------------------------------------------------
  let _ctx = null;
  function audioCtx() {
    if (!_ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _ctx = new AC();
    }
    if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }

  function fadeGain(gain, ctx, from, to, dur) {
    if (!gain || !ctx) return;
    const now = ctx.currentTime;
    const f = Math.max(from, 0.0001);
    const t = Math.max(to, 0.0001);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(f, now);
    gain.gain.exponentialRampToValueAtTime(t, now + dur);
  }

  // -------------------------------------------------------------------------
  // Browser ses seçimi
  // -------------------------------------------------------------------------
  function getVoices() {
    try {
      return window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    } catch (e) {
      return [];
    }
  }

  function pickVoice() {
    const voices = getVoices();
    if (!voices.length) return null;
    if (settings.browserVoice) {
      const byName = voices.find((v) => v.name === settings.browserVoice);
      if (byName) return byName;
    }
    const tr = voices.find((v) => /^tr(-|_|$)/i.test(v.lang));
    return tr || null;
  }

  // -------------------------------------------------------------------------
  // TTS Playback
  // -------------------------------------------------------------------------
  // OpenAI: data URL audio -> Web Audio gain (fade in/out) -> destination
  function playOpenAI(job, cueWindow, videoRate) {
    return new Promise((resolve) => {
      const url = 'data:' + (job.audioMime || 'audio/mpeg') + ';base64,' + job.audioData;
      const audio = new Audio(url);
      audio.preload = 'auto';
      const ctx = audioCtx();
      let gain = null;
      try {
        if (ctx) {
          const src = ctx.createMediaElementSource(audio);
          gain = ctx.createGain();
          gain.gain.value = 0.0001;
          src.connect(gain).connect(ctx.destination);
        }
      } catch (e) {
        gain = null; // Web Audio başarısız -> düz oynat
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      audio.addEventListener('loadedmetadata', () => {
        const rate = computeIdealRate(audio.duration, cueWindow, videoRate, settings.maxTtsRate);
        audio.playbackRate = rate;
      });
      audio.addEventListener('ended', () => {
        if (gain && ctx) fadeGain(gain, ctx, gain.gain.value, 0.0001, 0.08);
        finish();
      });
      audio.addEventListener('error', finish);

      job.controls = {
        pause: () => { try { audio.pause(); } catch (e) {} },
        resume: () => { if (!done) audio.play().catch(() => {}); },
        stop: () => { try { audio.pause(); } catch (e) {} finish(); }
      };

      audio.play()
        .then(() => { if (gain && ctx) fadeGain(gain, ctx, 0.0001, 1.0, 0.06); })
        .catch(finish);
    });
  }

  // Browser: Web Speech API
  function playBrowser(job, cueWindow, videoRate) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) { resolve(); return; }
      const text = job.ttsText || job.translatedText || '';
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : 'tr-TR';
      u.rate = estimateBrowserRate(text, cueWindow, videoRate, settings.maxTtsRate);

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;

      job.controls = {
        pause: () => { try { synth.pause(); } catch (e) {} },
        resume: () => { try { synth.resume(); } catch (e) {} },
        stop: () => { try { synth.cancel(); } catch (e) {} finish(); }
      };

      try { synth.cancel(); } catch (e) {} // üst üste binmeyi engelle
      synth.speak(u);
    });
  }

  // -------------------------------------------------------------------------
  // Slot tabanlı pre-fetch scheduler
  // -------------------------------------------------------------------------
  function createScheduler(opts) {
    const getActiveVideo = opts.getActiveVideo;
    const captionSource = opts.captionSource;

    // İki slotlu model: current (çalan / çalmaya hazır) + next (lookahead).
    let current = null;
    let next = null;
    let isPlaying = false;
    let active = false;
    let seq = 0;
    let disposer = null;
    let videoListeners = [];
    const enqueuedKeys = []; // tekrar yakalamayı engellemek için son anahtarlar

    const LAG_DROP_SECONDS = 8;    // sadece >8sn gerçek lag'de güncel cue'ya nazikçe atla
    const NEXT_STALE_SECONDS = 1;  // next SADECE >1sn geride kaldıysa değiştirilir
    const DEBUG = true;
    const LOG_PREFIX = /udemy/i.test(location.hostname) ? '[UD-DUB]' : '[YT-DUB]';

    function cueKey(cue) {
      const t = cue.startTime != null ? Math.round(cue.startTime * 10) / 10 : 'x';
      return t + '|' + (cue.text || '').slice(0, 60);
    }

    function alreadySeen(cue) {
      const k = cueKey(cue);
      if (enqueuedKeys.indexOf(k) !== -1) return true;
      if (current && cueKey(current.cue) === k) return true;
      if (next && cueKey(next.cue) === k) return true;
      return false;
    }

    function rememberCue(cue) {
      enqueuedKeys.push(cueKey(cue));
      if (enqueuedKeys.length > 12) enqueuedKeys.shift();
    }

    function makeJob(cue) {
      return {
        id: 'job_' + (++seq) + '_' + Date.now(),
        cue: cue,
        state: 'pending', // pending | ready | error
        translatedText: null,
        ttsText: null,
        audioData: null,
        audioMime: null,
        fallbackBrowser: false,
        abortRequested: false,
        controls: null
      };
    }

    function prep(job) {
      let responded = false;
      const onResult = (res) => {
        if (responded) return;
        responded = true;
        if (job.abortRequested) return;
        if (chrome.runtime.lastError || !res) {
          job.state = 'error';
          tryPlay();
          return;
        }
        if (!res.ok) {
          job.state = 'error';
          if (res.error === 'translate-timeout') {
            overlayStatus('Çeviri gecikti, segment atlandı');
          } else if (res.error === 'no-deepl-key') {
            overlayStatus('DeepL API anahtarı eksik');
          }
          tryPlay();
          return;
        }
        job.translatedText = res.translatedText;
        job.ttsText = res.ttsText || res.translatedText;
        if (res.audio) {
          job.audioData = res.audio;
          job.audioMime = res.mime || 'audio/mpeg';
        }
        if (res.fallback) {
          job.fallbackBrowser = true;
          if (!TRDUB.__warnedFallback) {
            TRDUB.__warnedFallback = true;
            overlayStatus('OpenAI anahtarı yok — Browser TTS kullanılıyor');
          }
        }
        job.state = 'ready';
        logSlots('prep ready');
        tryPlay();
      };

      try {
        chrome.runtime.sendMessage({ type: 'prepareDub', id: job.id, text: job.cue.text }, onResult);
      } catch (e) {
        job.state = 'error';
        tryPlay();
      }
    }

    // ----- zaman/lag yardımcıları -----
    function refTime(job) {
      if (!job) return null;
      const c = job.cue;
      return c.endTime != null ? c.endTime : c.startTime;
    }

    // Pozitif => slot videodan geride kaldı (saniye, video-zamanı)
    function lagOf(job) {
      const video = getActiveVideo();
      const r = refTime(job);
      if (!video || r == null) return 0;
      return video.currentTime - r;
    }

    // ----- slot durum logu -----
    function slotStr(job) {
      if (!job) return '∅';
      const c = job.cue;
      const win = (c.startTime != null ? c.startTime.toFixed(1) : '?') + '→' +
                  (c.endTime != null ? c.endTime.toFixed(1) : '?');
      return job.state + ' ' + win + ' "' + (c.text || '').slice(0, 24) + '"';
    }
    function logSlots(event) {
      if (!DEBUG) return;
      const v = getActiveVideo();
      const t = v ? v.currentTime.toFixed(1) : '?';
      const r = v ? (v.playbackRate || 1) : 1;
      console.debug(LOG_PREFIX + ' t=' + t + 's x' + r + ' | ' + event +
        '\n          current=[' + slotStr(current) + ']' +
        '\n          next   =[' + slotStr(next) + ']');
    }

    // ----- yakalama (iki slotlu, kayıpsız next) -----
    function enqueueCue(cue) {
      if (!active || !cue || !cue.text || !cue.text.trim()) return;
      if (alreadySeen(cue)) return;

      // 1) current boşsa -> doldur, hazırlamaya başla, oynatmayı dene
      if (!current) {
        current = makeJob(cue);
        rememberCue(cue);
        prep(current);
        logSlots('yakala -> current');
        tryPlay();
        return;
      }

      // 2) next boşsa -> doldur (decoupled pre-fetch)
      if (!next) {
        next = makeJob(cue);
        rememberCue(cue);
        prep(next);
        logSlots('yakala -> next');
        return;
      }

      // 3) Her iki slot da dolu -> bu, 3. segment.
      //    KURAL: next SADECE gerçekten geride kaldıysa (>1sn lag) değiştirilir.
      //    Aksi halde 3. segment ATILIR, next korunur ve sırayla oynatılır.
      const nextLag = lagOf(next);
      if (nextLag > NEXT_STALE_SECONDS) {
        logSlots('next BAYAT (lag=' + nextLag.toFixed(2) + 's) -> degistiriliyor');
        abortJob(next);
        next = makeJob(cue);
        rememberCue(cue);
        prep(next);
      } else {
        logSlots('3. segment ATILDI (next lag=' + nextLag.toFixed(2) + 's, korunuyor) "' +
          cue.text.slice(0, 24) + '"');
      }
    }

    // Lookahead: next boşken bir sonraki cue'yu önceden hazırla (asla ezme)
    function fillNextLookahead() {
      if (next || !current || !captionSource.getNextCue) return;
      let nc = null;
      try { nc = captionSource.getNextCue(current.cue); } catch (e) { nc = null; }
      if (nc && nc.text && nc.text.trim() && !alreadySeen(nc)) {
        next = makeJob(nc);
        rememberCue(nc);
        prep(next);
        logSlots('lookahead -> next');
      }
    }

    function promoteNext() {
      current = next;
      next = null;
      if (!current) {
        unduck(getActiveVideo());
        overlayHide();
      }
    }

    function tryPlay() {
      if (!active || isPlaying || !current) return;

      // Aşırı lag (>8sn): current çok eskidiyse nazikçe atla, next'e geç
      if (lagOf(current) > LAG_DROP_SECONDS) {
        logSlots('current >8s LAG -> atlanip next promote ediliyor');
        abortJob(current);
        promoteNext();
        tryPlay();
        return;
      }

      if (current.state === 'error') {
        logSlots('current HATA -> atlaniyor');
        abortJob(current);
        promoteNext();
        tryPlay();
        return;
      }

      if (current.state !== 'ready') return; // hazır değil; prep bitince tryPlay tekrar çağrılır
      playCurrent(current);
    }

    function playCurrent(job) {
      isPlaying = true;
      const video = getActiveVideo();
      const videoRate = video ? (video.playbackRate || 1) : 1;
      const cueWindow = (job.cue.endTime != null && job.cue.startTime != null)
        ? (job.cue.endTime - job.cue.startTime)
        : null;

      overlayText(job.translatedText, job.cue.text);
      duck(video);
      logSlots('OYNAT current');

      // current çalarken next için lookahead doldur (boşsa)
      fillNextLookahead();

      const useOpenAI = job.audioData && !job.fallbackBrowser;
      const player = useOpenAI
        ? playOpenAI(job, cueWindow, videoRate)
        : playBrowser(job, cueWindow, videoRate);

      player.then(() => {
        isPlaying = false;
        if (current === job) {
          logSlots('BITTI current -> next promote');
          promoteNext();
        }
        tryPlay();
      });
    }

    // ------- iptal / seek / pause -------
    function abortJob(job) {
      job.abortRequested = true;
      try { chrome.runtime.sendMessage({ type: 'abortDub', id: job.id }); } catch (e) {}
      if (job.controls && job.controls.stop) {
        try { job.controls.stop(); } catch (e) {}
      }
    }

    function abortAll() {
      if (current) { abortJob(current); current = null; }
      if (next) { abortJob(next); next = null; }
      isPlaying = false;
      enqueuedKeys.length = 0;
      try { chrome.runtime.sendMessage({ type: 'clearCache' }); } catch (e) {}
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
      unduck(getActiveVideo());
      overlayHide();
      logSlots('abortAll (seek/ended) — slotlar temizlendi');
    }

    function pauseAll() {
      if (current && current.controls && current.controls.pause) {
        try { current.controls.pause(); } catch (e) {}
      }
    }

    function resumeAll() {
      if (current && current.controls && current.controls.resume) {
        try { current.controls.resume(); } catch (e) {}
      }
    }

    function attachVideoListeners() {
      const video = getActiveVideo();
      if (!video) return;
      if (video.__trdubBound) return;
      video.__trdubBound = true;

      const onSeeking = () => abortAll();
      const onPause = () => pauseAll();
      const onPlay = () => resumeAll();
      const onEnded = () => abortAll();

      video.addEventListener('seeking', onSeeking);
      video.addEventListener('pause', onPause);
      video.addEventListener('play', onPlay);
      video.addEventListener('ended', onEnded);

      videoListeners.push(() => {
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('ended', onEnded);
        delete video.__trdubBound;
      });
    }

    function start() {
      if (active) return;
      active = true;
      attachVideoListeners();
      try {
        disposer = captionSource.onCueChange((cue) => enqueueCue(cue));
      } catch (e) {
        disposer = null;
      }
    }

    function stop() {
      active = false;
      abortAll();
      if (disposer) { try { disposer(); } catch (e) {} disposer = null; }
      videoListeners.forEach((fn) => { try { fn(); } catch (e) {} });
      videoListeners = [];
    }

    function reset() {
      abortAll();
    }

    return { start, stop, reset, attachVideoListeners };
  }
  TRDUB.createScheduler = createScheduler;

  // -------------------------------------------------------------------------
  // Çalıştırma / master kontrol
  // -------------------------------------------------------------------------
  let scheduler = null;

  function applyEnabled() {
    if (!scheduler) return;
    if (settings.enabled && settings.syncEnabled) {
      scheduler.start();
    } else {
      scheduler.stop();
      overlayHide();
    }
  }

  TRDUB.run = async function (captionSource, getActiveVideo) {
    await loadSettings();
    scheduler = createScheduler({ captionSource, getActiveVideo });
    applyEnabled();

    // Ayar değişikliklerini dinle
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      Object.keys(changes).forEach((k) => { settings[k] = changes[k].newValue; });
      applyOverlayMode();
      applyEnabled();
    });

    // Popup'tan aç/kapa
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'setEnabled') {
        settings.enabled = msg.value;
        applyEnabled();
      }
    });

    // YouTube voices async yüklenir
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = function () { /* voices hazır */ };
    }

    return scheduler;
  };

  // Platform dosyaları yeniden navigate olunca scheduler'ı yeniden bağlasın
  TRDUB.getScheduler = function () { return scheduler; };
})();
