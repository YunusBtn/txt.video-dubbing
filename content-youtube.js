/*
 * content-youtube.js — YouTube'a özel caption capture
 *
 * Strateji:
 *  1. video.textTracks: mode='hidden' yapıp 'cuechange' dinle (en güvenilir).
 *     getNextCue ile gerçek lookahead mümkün.
 *  2. textTrack yoksa/boşsa DOM caption polling (.ytp-caption-segment) — lookahead yok.
 *
 * SPA: 'yt-navigate-finish' + history.pushState override ile video geçişlerini
 * yakala, her geçişte session'ı temiz sıfırla ve caption source'u yeniden bağla.
 */

(function () {
  'use strict';

  const TRDUB = window.TRDUB;
  if (!TRDUB) return;

  // ----- aktif video -----
  function getActiveVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    vids.forEach((v) => {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      // Oynayan/yüklü ve görünür olanı tercih et
      if (v.readyState >= 1 && area >= bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best || vids[0] || null;
  }

  // ----- textTrack tabanlı kaynak -----
  function findCaptionTrack(video) {
    if (!video || !video.textTracks) return null;
    const tracks = video.textTracks;
    let candidate = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind === 'captions' || t.kind === 'subtitles') {
        // Cue'su olanı tercih et
        if (t.cues && t.cues.length) return t;
        if (!candidate) candidate = t;
      }
    }
    return candidate;
  }

  function cueFrom(c) {
    if (!c) return null;
    // YouTube cue text bazen HTML içerir; düz metne çevir
    let text = c.text || '';
    if (/[<&]/.test(text)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = text;
      text = tmp.textContent || '';
    }
    return { text: text.trim(), startTime: c.startTime, endTime: c.endTime };
  }

  function createTrackSource(video, track) {
    track.mode = 'hidden'; // render etme ama cue'ları al
    return {
      getActiveCue() {
        const ac = track.activeCues;
        return ac && ac.length ? cueFrom(ac[ac.length - 1]) : null;
      },
      onCueChange(cb) {
        const handler = () => {
          const ac = track.activeCues;
          if (ac && ac.length) {
            const cue = cueFrom(ac[ac.length - 1]);
            if (cue && cue.text) cb(cue);
          }
        };
        track.addEventListener('cuechange', handler);
        return () => track.removeEventListener('cuechange', handler);
      },
      getNextCue(afterCue) {
        const cues = track.cues;
        if (!cues || !afterCue) return null;
        for (let i = 0; i < cues.length; i++) {
          if (cues[i].startTime >= (afterCue.endTime != null ? afterCue.endTime : afterCue.startTime) - 0.001 &&
              cues[i].startTime > afterCue.startTime) {
            const cue = cueFrom(cues[i]);
            if (cue && cue.text) return cue;
          }
        }
        return null;
      }
    };
  }

  // ----- DOM caption fallback -----
  function createDomSource(video) {
    let lastText = '';
    let timer = null;

    function readCaption() {
      const segs = document.querySelectorAll('.ytp-caption-segment');
      if (!segs.length) return '';
      return Array.from(segs).map((s) => s.textContent).join(' ').trim();
    }

    return {
      getActiveCue() {
        const text = readCaption();
        return text ? { text, startTime: video ? video.currentTime : 0, endTime: null } : null;
      },
      onCueChange(cb) {
        timer = setInterval(() => {
          const text = readCaption();
          if (text && text !== lastText) {
            lastText = text;
            cb({ text, startTime: video ? video.currentTime : 0, endTime: null });
          } else if (!text) {
            lastText = '';
          }
        }, 250);
        return () => { if (timer) clearInterval(timer); };
      },
      getNextCue() { return null; } // DOM modunda gerçek lookahead yok
    };
  }

  function buildCaptionSource() {
    const video = getActiveVideo();
    const track = findCaptionTrack(video);
    if (track) return createTrackSource(video, track);
    return createDomSource(video);
  }

  // ----- bootstrap + SPA -----
  let currentScheduler = null;

  function rebind() {
    // Önceki scheduler'ı durdur (session temiz sıfırlama)
    const sched = TRDUB.getScheduler && TRDUB.getScheduler();
    if (sched) sched.stop();

    const source = buildCaptionSource();
    TRDUB.run(source, getActiveVideo).then((s) => {
      currentScheduler = s;
      if (s) s.attachVideoListeners();
    });
  }

  // textTrack bazen gecikmeli gelir; ilk bağlanmayı biraz beklet ve birkaç kez dene
  let initTries = 0;
  function initWhenReady() {
    const video = getActiveVideo();
    if (video && (findCaptionTrack(video) || document.querySelector('.ytp-caption-segment') || initTries > 8)) {
      rebind();
      return;
    }
    initTries++;
    setTimeout(initWhenReady, 600);
  }

  // İlk yükleme
  initWhenReady();

  // SPA: yt-navigate-finish
  window.addEventListener('yt-navigate-finish', () => {
    initTries = 0;
    setTimeout(initWhenReady, 400);
  });

  // SPA: history.pushState override (yedek)
  const origPush = history.pushState;
  history.pushState = function () {
    const r = origPush.apply(this, arguments);
    initTries = 0;
    setTimeout(initWhenReady, 600);
    return r;
  };
  window.addEventListener('popstate', () => {
    initTries = 0;
    setTimeout(initWhenReady, 600);
  });
})();
