/*
 * content-udemy.js — Udemy'e özel caption capture
 *
 * Strateji:
 *  1. video.textTracks öncelikli ('cuechange', lookahead destekli).
 *  2. DOM caption fallback: hardcoded selector YOK — generic skorlama ile
 *     video ve caption elementi bulunur. Shadow DOM'a karşı deep query.
 */

(function () {
  'use strict';

  const TRDUB = window.TRDUB;
  if (!TRDUB) return;

  // ----- Shadow DOM dahil deep query -----
  function deepQueryAll(selector, root, out, seen) {
    root = root || document;
    out = out || [];
    seen = seen || new Set();
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll(selector)); } catch (e) { nodes = []; }
    nodes.forEach((n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } });
    // Shadow root'lara in
    let all = [];
    try { all = Array.from(root.querySelectorAll('*')); } catch (e) { all = []; }
    all.forEach((el) => {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out, seen);
    });
    return out;
  }

  // ----- aktif video (generic skorlama) -----
  function getActiveVideo() {
    const vids = deepQueryAll('video');
    let best = null;
    let bestScore = -1;
    vids.forEach((v) => {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      let score = area;
      if (!v.paused) score *= 3;       // oynayan video önceli
      if (v.readyState >= 2) score *= 1.5;
      if (area < 1000) score = 0;       // gizli/küçük
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best || vids[0] || null;
  }

  // ----- textTrack kaynağı -----
  function findCaptionTrack(video) {
    if (!video || !video.textTracks) return null;
    const tracks = video.textTracks;
    let candidate = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind === 'captions' || t.kind === 'subtitles') {
        if (t.cues && t.cues.length) return t;
        if (!candidate) candidate = t;
      }
    }
    return candidate;
  }

  function cueFrom(c) {
    if (!c) return null;
    let text = c.text || '';
    if (/[<&]/.test(text)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = text;
      text = tmp.textContent || '';
    }
    return { text: text.trim(), startTime: c.startTime, endTime: c.endTime };
  }

  function createTrackSource(track) {
    track.mode = 'hidden';
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
          if (cues[i].startTime > afterCue.startTime &&
              cues[i].startTime >= (afterCue.endTime != null ? afterCue.endTime : afterCue.startTime) - 0.001) {
            const cue = cueFrom(cues[i]);
            if (cue && cue.text) return cue;
          }
        }
        return null;
      }
    };
  }

  // ----- DOM caption fallback (generic skorlama) -----
  // Caption elementini bulurken hardcoded class kullanmıyoruz; bunun yerine:
  //  - 'caption|subtitle|cue|transcript' ipuçlarını class/id/attribute'ta ara
  //  - video alt bölgesinde konumlanmış, kısa metinli görünür elementleri skorla
  function findCaptionElement(video) {
    const hintRe = /caption|subtitle|cue|transcript|dialogue/i;
    const candidates = [];

    function consider(el) {
      if (!el || !el.getBoundingClientRect) return;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 220) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) return;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return;

      let score = 0;
      const idClass = (el.className && el.className.toString ? el.className.toString() : '') + ' ' +
                      (el.id || '') + ' ' + (el.getAttribute('data-purpose') || '');
      if (hintRe.test(idClass)) score += 100;

      // Video bounding box'ının alt üçte birinde mi?
      if (video) {
        const vr = video.getBoundingClientRect();
        const inX = r.left >= vr.left - 20 && r.right <= vr.right + 20;
        const lowerThird = r.top >= vr.top + vr.height * 0.6;
        if (inX && lowerThird) score += 40;
        if (r.bottom <= vr.bottom + 40) score += 10;
      }
      // Kısa metin caption olma ihtimalini artırır
      if (text.length < 120) score += 10;

      if (score > 0) candidates.push({ el, text, score });
    }

    // Önce ipuçlu elementler (deep)
    deepQueryAll('[class*="caption" i],[class*="subtitle" i],[data-purpose*="caption" i],[class*="cue" i]', document)
      .forEach(consider);

    if (!candidates.length) {
      // Hiç ipucu yoksa video çevresindeki span/div'leri tara
      deepQueryAll('span,div', document).forEach((el) => {
        // Çok sayıda eleman olmasın diye sadece metni olan yaprakları al
        if (el.children.length === 0) consider(el);
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].el : null;
  }

  function createDomSource(video) {
    let lastText = '';
    let timer = null;

    function readCaption() {
      let el = findCaptionElement(video);
      if (!el) return '';
      return (el.textContent || '').trim();
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
      getNextCue() { return null; }
    };
  }

  function buildCaptionSource() {
    const video = getActiveVideo();
    const track = findCaptionTrack(video);
    if (track) return createTrackSource(track);
    return createDomSource(video);
  }

  // ----- bootstrap -----
  let initTries = 0;
  function initWhenReady() {
    const video = getActiveVideo();
    if (video && (findCaptionTrack(video) || findCaptionElement(video) || initTries > 10)) {
      const sched = TRDUB.getScheduler && TRDUB.getScheduler();
      if (sched) sched.stop();
      const source = buildCaptionSource();
      TRDUB.run(source, getActiveVideo).then((s) => { if (s) s.attachVideoListeners(); });
      return;
    }
    initTries++;
    setTimeout(initWhenReady, 700);
  }

  initWhenReady();

  // Udemy de SPA — ders değişiminde URL değişir
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      initTries = 0;
      setTimeout(initWhenReady, 600);
    }
  }, 1000);
})();
