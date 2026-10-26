// YouTube-style keyboard shortcuts for Twitch VODs and clips:
//   > / <      speed up / down (0.25x steps, 0.25x-2x)
//   J / L      seek -10s / +10s
//   ← / →      seek -5s / +5s (replaces Twitch's 10s)
//   0-9        jump to 0%-90%
// Live streams are left alone so Twitch's own keys (e.g. ← for live rewind) keep working.
(() => {
  'use strict';

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const SEEK_SHORT = 5;
  const SEEK_LONG = 10;
  const OVERLAY_MS = 800;
  // A rate change this soon after a seek/load is assumed to be Twitch resetting it.
  const RESET_WINDOW_MS = 1000;
  const EPSILON = 1e-3;
  const TEXT_INPUT =
    'textarea, select, input:not([type=range], [type=checkbox], [type=radio], [type=button], [type=submit])';

  let desiredRate = null; // speed the user picked; null means we leave the rate alone
  let ratePath = null; // pathname of the video desiredRate was picked on
  let lastResetRiskAt = -Infinity;
  const swallowedKeyups = new Set();
  let overlay = null;
  let hideTimer = 0;

  // The main player is the largest <video>; this skips sidebar previews and the mini-player.
  // Queried fresh each time because Twitch swaps the element on navigation.
  function getVideo() {
    let best = null;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  function isReplayable() {
    return (
      location.hostname === 'clips.twitch.tv' ||
      /^\/videos\/\d+/.test(location.pathname) ||
      /^\/[^/]+\/clip\//.test(location.pathname)
    );
  }

  function isEditable(el) {
    return el instanceof Element && (el.isContentEditable || el.matches(TEXT_INPUT));
  }

  function setRate(video, rate) {
    desiredRate = rate;
    ratePath = location.pathname;
    video.playbackRate = rate;
  }

  function stepSpeed(video, dir) {
    const cur = video.playbackRate;
    // Strictly above/below the current rate, so an off-grid rate from Twitch's menu still steps cleanly.
    const next =
      dir > 0 ? SPEEDS.find((s) => s > cur + EPSILON) : SPEEDS.findLast((s) => s < cur - EPSILON);
    const rate = next ?? cur;
    setRate(video, rate);
    showOverlay(video, `${rate}x`);
  }

  function seekTo(video, time) {
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(time, 0), end);
  }

  function seekBy(video, delta) {
    seekTo(video, video.currentTime + delta);
    showOverlay(video, delta > 0 ? `+${delta}s` : `−${-delta}s`);
  }

  function seekToPercent(video, pct) {
    if (!Number.isFinite(video.duration)) return;
    seekTo(video, (video.duration * pct) / 100);
    showOverlay(video, `${pct}%`);
  }

  function showOverlay(video, text) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ytk-overlay';
    }
    // Mount inside the fullscreen element when there is one, or the overlay would be hidden.
    const fs = document.fullscreenElement;
    const host =
      fs && fs !== video && fs.contains(video)
        ? fs
        : video.closest('[data-a-target="video-player"]') ?? video.parentElement;
    if (!host) return;
    if (overlay.parentElement !== host) host.append(overlay);

    overlay.textContent = text;
    overlay.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => overlay.classList.remove('visible'), OVERLAY_MS);
  }

  function actionFor(key) {
    switch (key) {
      case '>':
        return (v) => stepSpeed(v, 1);
      case '<':
        return (v) => stepSpeed(v, -1);
      case 'l':
        return (v) => seekBy(v, SEEK_LONG);
      case 'j':
        return (v) => seekBy(v, -SEEK_LONG);
      case 'ArrowRight':
        return (v) => seekBy(v, SEEK_SHORT);
      case 'ArrowLeft':
        return (v) => seekBy(v, -SEEK_SHORT);
      default:
        return /^[0-9]$/.test(key) ? (v) => seekToPercent(v, Number(key) * 10) : null;
    }
  }

  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowedKeyups.add(e.code);
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (isEditable(e.composedPath()[0])) return;

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = actionFor(key);
    if (!action) return;
    const video = getVideo();
    if (!video) return;

    if (!isReplayable()) {
      if (key === '>' || key === '<') {
        consume(e);
        showOverlay(video, 'Live · 1x');
      }
      return;
    }
    consume(e);
    action(video);
  }

  // Twitch never saw the keydown, so hide the matching keyup in case it acts on keyup.
  function onKeyUp(e) {
    if (!swallowedKeyups.delete(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Reset to 1x when a new video loads, even if Twitch reuses the same <video> element.
  function resetIfNewVideo() {
    if (desiredRate === null || location.pathname === ratePath) return false;
    desiredRate = null;
    for (const video of document.querySelectorAll('video')) video.playbackRate = 1;
    return true;
  }

  function markResetRisk() {
    lastResetRiskAt = performance.now();
  }

  function onRateChange(e) {
    if (resetIfNewVideo() || desiredRate === null) return;
    const video = e.target;
    if (video !== getVideo() || Math.abs(video.playbackRate - desiredRate) < EPSILON) return;

    if (performance.now() - lastResetRiskAt < RESET_WINDOW_MS) {
      video.playbackRate = desiredRate; // Twitch reset it after a seek/load
    } else {
      desiredRate = video.playbackRate; // user picked a speed from Twitch's own menu
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  // Media events don't bubble, but capture-phase listeners on document still see them.
  document.addEventListener('seeking', markResetRisk, true);
  document.addEventListener('loadstart', markResetRisk, true);
  document.addEventListener('ratechange', onRateChange, true);
  document.addEventListener('loadedmetadata', resetIfNewVideo, true);
  document.addEventListener('playing', resetIfNewVideo, true);
})();
