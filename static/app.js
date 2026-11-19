"use strict";

/* HandPortal: AR Hand Portal dan Filter.
   Mekanik di-port dari referensi "AR Hand Portal & Filter" (MediaPipe
   Hands klasik, hands.js). Deteksi jalan di browser, frame tidak pernah
   keluar dari HP. Pustaka dan wasm disajikan dari server ini sendiri;
   kalau file lokal gagal, fallback ke jsdelivr.
   Filter piksel hanya diterapkan pada region portal (bukan full frame)
   supaya FPS tetap tinggi; full frame hanya saat filter layar aktif
   sesudah tembakan ketapel. Filter dan gestur tambahan di-port dari
   Retrolens (syahdanfx/Retrolens: FilterBank, pinch jempol-kelingking,
   portal satu tangan, mode 3D). */

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const HANDS_LOCAL_BASE = "/static/vendor/hands/";
const HANDS_CDN_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/";
const HANDS_WASM_PROBE = "hands_solution_simd_wasm_bin.wasm";

/* Level resolusi deteksi, dari ringan ke paling ringan. Mulai di 640x360;
   kalau FPS deteksi di bawah target, turun otomatis selangkah. */
const LEVELS = [
  { w: 640, h: 360 },
  { w: 320, h: 240 },
];
const FPS_TARGET = 45;
const FPS_STEP_DOWN = 40;

/* Filter portal dan amunisi ketapel. Tujuh filter, port dari FilterBank
   Retrolens; kode jari 1/2/3 tetap ke tiga filter pertama. */
const FILTERS = ["THERMAL", "CYBER", "NEGATIVE", "DUAL-TONE", "PIXELATE", "GLITCH", "RAINBOW-WAVE"];
/* Kode jari satu tangan ke filter: 1 THERMAL, 2 CYBER, 3 NEGATIVE. */
const FINGER_TO_FILTER = { 1: 0, 2: 1, 3: 2 };
const FINGER_DEBOUNCE_MS = 1000;
const RESET_COOLDOWN_MS = 1500;
const SMOOTHING_FACTOR = 0.55;
const PINCH_DIST = 0.065;
/* Cubit jempol-kelingking ganti filter: ambang ternormalisasi (satuan
   landmark 0..1, seperti PINCH_DIST), bukan px tetap. */
const PINCH_TP_DIST = 0.07;
const PINCH_TP_COOLDOWN_MS = 300;
/* Warna bola amunisi ketapel per filter. */
const FILTER_COLORS = {
  THERMAL: "#f97316",
  CYBER: "#d946ef",
  NEGATIVE: "#38bdf8",
  "DUAL-TONE": "#fb923c",
  PIXELATE: "#a3e635",
  GLITCH: "#f43f5e",
  "RAINBOW-WAVE": "#facc15",
};
const PULL_MIN_DIST = 25;
const PROJECTILE_SPEED = 0.28;
const PROJECTILE_MAX_LIFE = 12;
const BANNER_MS = 2200;
const RESULTS_WATCHDOG_MS = 30000;

const INSTRUCTION_DEFAULT =
  "Buka tangan: portal · Pistol kiri + cubit kanan: ketapel · Kepal 2 tangan: reset";

const video = document.getElementById("video");
const canvas = document.getElementById("output");
const ctx = canvas.getContext("2d");
const offCanvas = document.createElement("canvas");
const offCtx = offCanvas.getContext("2d", { willReadFrequently: true });
/* Kanvas kecil untuk PIXELATE: region diperkecil lalu diperbesar lagi. */
const pixelCanvas = document.createElement("canvas");
const pixelCtx = pixelCanvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const cycleBtn = document.getElementById("cycleBtn");
const resetBtn = document.getElementById("resetBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const screenshotBtn = document.getElementById("screenshotBtn");
const mode3dBtn = document.getElementById("mode3dBtn");
const stageWrap = document.querySelector(".stage-wrap");
const retryBtn = document.getElementById("retryBtn");
const themeToggle = document.getElementById("themeToggle");
const stageMessage = document.getElementById("stageMessage");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadStageEl = document.getElementById("loadStage");
const loadBarEl = document.getElementById("loadBar");
const loadBarFillEl = document.getElementById("loadBarFill");
const errorOverlay = document.getElementById("errorOverlay");
const errorMessage = document.getElementById("errorMessage");
const handCountEl = document.getElementById("handCount");
const fpsEl = document.getElementById("fps");
const fpsFillEl = document.getElementById("fpsFill");
const gestureEl = document.getElementById("gesture");
const filterLine = document.getElementById("filterLine");
const modeLine = document.getElementById("modeLine");
const errorBox = document.getElementById("errorBox");
const bannerEl = document.getElementById("banner");
const holdBarEl = document.getElementById("holdBar");
const holdLabelEl = document.getElementById("holdLabel");
const holdFillEl = document.getElementById("holdFill");
const instructionEl = document.getElementById("instruction");
const themeIconMoon = document.getElementById("themeIconMoon");
const themeIconSun = document.getElementById("themeIconSun");
const themeLabel = document.getElementById("themeLabel");
const mode3dLabel = document.getElementById("mode3dLabel");
const fullscreenLabel = document.getElementById("fullscreenLabel");

let currentPortalFilterIdx = 0;
let activeScreenFilter = "NORMAL";
let isPullingSlingshot = false;
let slingshotPullPos = { x: 0, y: 0 };
let slingshotAnchorPos = { x: 0, y: 0 };
let projectile = null;
let shockwave = null;
let resetCooldown = 0;
let smoothedHands = [];
let bannerTimeout = null;
let is3dMode = false;
let thumbPinkyActive = [];
let lastThumbPinkySwitch = 0;

let filterCandidate = null;
let filterCandidateSince = 0;

let stream = null;
let hands = null;
let handsBase = HANDS_LOCAL_BASE;
let handsFailed = false;
let gotResults = false;
let rafId = 0;
let sending = false;
let levelIdx = 0;
let switchingLevel = false;
let startedAt = 0;
let detectTimes = [];
let statusUpdatedAt = 0;
let lastAdaptCheck = 0;
let shownFps = 0;

/* --- Banner dan filter --- */

function showBanner(text, bg) {
  bannerEl.textContent = text;
  bannerEl.style.background = bg || "#22c55e";
  /* Teks banner selalu hitam: kontras lolos di semua warna latar
     (putih di ungu #a855f7 hanya 3.96:1, gagal AA). */
  bannerEl.style.color = "#000000";
  bannerEl.hidden = false;
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => { bannerEl.hidden = true; }, BANNER_MS);
}

function nextFilterName() {
  return FILTERS[(currentPortalFilterIdx + 1) % FILTERS.length];
}

function filterAmmoColor(filterName) {
  return FILTER_COLORS[filterName] || "#38bdf8";
}

function updateFilterLine() {
  filterLine.textContent =
    "Filter layar: " + activeScreenFilter + " · Amunisi: " + FILTERS[currentPortalFilterIdx]
    + " · Berikutnya: " + nextFilterName();
}

function cycleFilter() {
  currentPortalFilterIdx = (currentPortalFilterIdx + 1) % FILTERS.length;
  showBanner("Amunisi: " + FILTERS[currentPortalFilterIdx], "#22d3ee");
  updateFilterLine();
}

function resetScreenFilter() {
  if (activeScreenFilter !== "NORMAL") {
    activeScreenFilter = "NORMAL";
    showBanner("Filter direset", "#22c55e");
    updateFilterLine();
  }
}

function setPortalFilter(idx) {
  if (idx === currentPortalFilterIdx) return;
  currentPortalFilterIdx = idx;
  showBanner("Amunisi: " + FILTERS[idx], "#22d3ee");
  updateFilterLine();
}

/* Progres muat model: tahap nyata (pustaka, kamera, model), bukan animasi. */
function setLoadStage(text, pct) {
  loadStageEl.textContent = text;
  loadBarFillEl.style.width = pct + "%";
  loadBarEl.setAttribute("aria-valuenow", String(pct));
}

/* Progres tahan gestur: terisi selama kode jari di-debounce sebelum
   amunisi berganti. Hanya tampil saat ada kandidat aktif. */
function updateHoldBar(now) {
  if (filterCandidate === null || !(filterCandidate in FINGER_TO_FILTER)) {
    holdBarEl.hidden = true;
    return;
  }
  const progress = Math.min(1, (now - filterCandidateSince) / FINGER_DEBOUNCE_MS);
  holdLabelEl.textContent = "Ganti ke " + FILTERS[FINGER_TO_FILTER[filterCandidate]];
  holdFillEl.style.width = Math.round(progress * 100) + "%";
  holdBarEl.hidden = false;
}

function updateFingerFilter(now, handCount, fingers) {
  /* Hanya saat tepat satu tangan terlihat: kode jari harus stabil
     sekitar 1 detik sebelum amunisi berganti. */
  if (handCount !== 1 || !(fingers in FINGER_TO_FILTER)) {
    filterCandidate = null;
    return;
  }
  if (filterCandidate !== fingers) {
    filterCandidate = fingers;
    filterCandidateSince = now;
    return;
  }
  if (now - filterCandidateSince >= FINGER_DEBOUNCE_MS) {
    setPortalFilter(FINGER_TO_FILTER[fingers]);
    filterCandidate = null;
  }
}

function updateThumbPinkyPinch(now, mappedHands) {
  /* Cubit jempol-kelingking ganti filter. Jalan juga saat portal 2 tangan
     terbuka: satu tangan mencubit, tangan lain tetap memegang portal.
     Edge-trigger + cooldown supaya sekali cubit hanya ganti sekali.
     Dijaga supaya tidak bentrok dengan cubit jempol-telunjuk ketapel
     dan dengan kepalan tangan. */
  mappedHands.forEach((hand, i) => {
    const pinch = isThumbPinkyPinch(hand.landmarks)
      && !isPinching(hand.landmarks) && !isFist(hand.landmarks);
    const was = thumbPinkyActive[i] || false;
    if (pinch && !was && now - lastThumbPinkySwitch >= PINCH_TP_COOLDOWN_MS) {
      cycleFilter();
      lastThumbPinkySwitch = now;
    }
    thumbPinkyActive[i] = pinch;
  });
  if (mappedHands.length < thumbPinkyActive.length) {
    thumbPinkyActive = thumbPinkyActive.slice(0, mappedHands.length);
  }
}

/* --- Filter piksel, port dari referensi + FilterBank Retrolens --- */

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* timeSec hanya dipakai RAINBOW-WAVE (animasi). PIXELATE tidak lewat sini,
   ia pakai drawPortalPixelate/drawFullscreenPixelate (tanpa loop piksel). */
function applyPixelFilterRegion(targetCtx, x, y, w, h, filterType, timeSec) {
  if (filterType === "NORMAL" || filterType === "PIXELATE" || w <= 0 || h <= 0) return;
  const cw = targetCtx.canvas.width;
  const ch = targetCtx.canvas.height;
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(cw - x, Math.ceil(w));
  h = Math.min(ch - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return;
  const imageData = targetCtx.getImageData(x, y, w, h);
  const data = imageData.data;
  /* GLITCH membaca piksel tetangga: pakai salinan supaya hasilnya tidak
     menumpuk karena membaca piksel yang sudah diubah. */
  const orig = filterType === "GLITCH" ? new Uint8ClampedArray(data) : null;
  const shift = filterType === "GLITCH" ? 4 + Math.floor(Math.random() * 9) : 0;
  const phase = (timeSec || 0) * 5;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (filterType === "NEGATIVE") {
        data[idx] = 255 - r;
        data[idx + 1] = 255 - g;
        data[idx + 2] = 255 - b;
      } else if (filterType === "THERMAL") {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        let tr = 0, tg = 0, tb = 0;
        if (lum < 0.25) {
          tr = 0;
          tg = Math.floor((lum / 0.25) * 180);
          tb = Math.floor(120 + (lum / 0.25) * 135);
        } else if (lum < 0.5) {
          const t = (lum - 0.25) / 0.25;
          tr = 0;
          tg = Math.floor(180 + t * 75);
          tb = Math.floor(255 * (1 - t));
        } else if (lum < 0.75) {
          const t = (lum - 0.5) / 0.25;
          tr = Math.floor(t * 255);
          tg = 255;
          tb = 0;
        } else {
          const t = (lum - 0.75) / 0.25;
          tr = 255;
          tg = Math.floor(255 * (1 - t * 0.7));
          tb = Math.floor(t * 180);
        }
        data[idx] = tr;
        data[idx + 1] = tg;
        data[idx + 2] = tb;
      } else if (filterType === "CYBER") {
        data[idx] = Math.min(255, r * 1.35 + 45);
        data[idx + 1] = Math.floor(g * 0.45);
        data[idx + 2] = Math.min(255, b * 1.45 + 75);
      } else if (filterType === "DUAL-TONE") {
        /* Retrolens dual-tone: threshold 110, terang oranye, gelap ungu. */
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 110) {
          data[idx] = 255;
          data[idx + 1] = 140;
          data[idx + 2] = 10;
        } else {
          data[idx] = 220;
          data[idx + 1] = 30;
          data[idx + 2] = 180;
        }
      } else if (filterType === "GLITCH") {
        /* Retrolens glitch: channel R geser kanan, B geser kiri. */
        const rCol = Math.min(w - 1, col + shift);
        const bCol = Math.max(0, col - shift);
        data[idx] = orig[(row * w + rCol) * 4];
        data[idx + 2] = orig[(row * w + bCol) * 4 + 2];
      } else if (filterType === "RAINBOW-WAVE") {
        /* Retrolens rainbow-wave: pola sinus + waktu, campur 0.3/0.7. */
        const p = Math.sin((col + row) * 0.05 + phase) * 127 + 128;
        const rgb = hslToRgb((p / 255) * 360, 1, 0.5);
        data[idx] = Math.round(r * 0.3 + rgb[0] * 0.7);
        data[idx + 1] = Math.round(g * 0.3 + rgb[1] * 0.7);
        data[idx + 2] = Math.round(b * 0.3 + rgb[2] * 0.7);
      }
    }
  }
  if (filterType === "GLITCH") {
    for (let n = 0; n < 2; n++) {
      const ry = Math.floor(Math.random() * h);
      for (let col = 0; col < w; col++) {
        const idx = (ry * w + col) * 4;
        data[idx] = Math.floor(Math.random() * 256);
        data[idx + 1] = Math.floor(Math.random() * 256);
        data[idx + 2] = Math.floor(Math.random() * 256);
      }
    }
  }
  targetCtx.putImageData(imageData, x, y);
}

/* --- Geometri dan gestur, port dari referensi --- */

function getDistance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function isFingerExtended(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  return getDistance(landmarks[tipIdx], wrist) > getDistance(landmarks[pipIdx], wrist) * 1.15;
}

function isFist(landmarks) {
  return !isFingerExtended(landmarks, 8, 6)
    && !isFingerExtended(landmarks, 12, 10)
    && !isFingerExtended(landmarks, 16, 14)
    && !isFingerExtended(landmarks, 20, 18);
}

/* Pose pistol/L: telunjuk dan jempol terbuka, tiga jari lain menekuk. */
function isPistolGesture(landmarks) {
  return isFingerExtended(landmarks, 8, 6)
    && isFingerExtended(landmarks, 4, 2)
    && !isFingerExtended(landmarks, 12, 10)
    && !isFingerExtended(landmarks, 16, 14)
    && !isFingerExtended(landmarks, 20, 18);
}

function isPinching(landmarks) {
  return getDistance(landmarks[4], landmarks[8]) < PINCH_DIST;
}

/* Cubit jempol-kelingking (Retrolens: pinch jempol-kelingking ganti
   filter). Ambang ternormalisasi, bukan px tetap. */
function isThumbPinkyPinch(landmarks) {
  return getDistance(landmarks[4], landmarks[20]) < PINCH_TP_DIST;
}

/* Tangan terbuka penuh: kelima jari terentang. Gate portal satu tangan. */
function isHandOpen(landmarks) {
  return isFingerExtended(landmarks, 8, 6)
    && isFingerExtended(landmarks, 12, 10)
    && isFingerExtended(landmarks, 16, 14)
    && isFingerExtended(landmarks, 20, 18)
    && isFingerExtended(landmarks, 4, 2);
}

function lerp(start, end, amt) {
  return (1 - amt) * start + amt * end;
}

/* Urutkan 4 sudut portal searah jarum jam supaya poligon tidak
   terlipat saat tangan diputar. */
function sortCornersClockwise(points) {
  const center = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
  return points.slice().sort((a, b) =>
    Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
}

function bboxOf(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min.apply(null, xs);
  const y0 = Math.min.apply(null, ys);
  const x1 = Math.max.apply(null, xs);
  const y1 = Math.max.apply(null, ys);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* --- Hitung jari, aturan yang sudah ada (dipertahankan) --- */

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fingerExtendedCount(lm, tip, mcp, wrist, factor) {
  const f = factor === undefined ? 1.15 : factor;
  return dist(lm[wrist], lm[tip]) > dist(lm[wrist], lm[mcp]) * f;
}

function countFingers(lm) {
  let count = 0;
  for (const pair of [[8, 5], [12, 9], [16, 13], [20, 17]]) {
    if (fingerExtendedCount(lm, pair[0], pair[1], 0, 1.25)) count += 1;
  }
  if (dist(lm[4], lm[5]) > dist(lm[2], lm[5]) * 1.3) count += 1;
  return count;
}

/* --- Gambar --- */

function drawMirrored(targetCtx, source, w, h) {
  targetCtx.save();
  targetCtx.translate(w, 0);
  targetCtx.scale(-1, 1);
  targetCtx.drawImage(source, 0, 0, w, h);
  targetCtx.restore();
}

/* Poligon N titik: segi empat portal biasa, segi enam mode 3D. */
function tracePoly(targetCtx, points) {
  targetCtx.beginPath();
  targetCtx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    targetCtx.lineTo(points[i].x, points[i].y);
  }
  targetCtx.closePath();
}

function drawPortal(targetCtx, sourceCanvas, corners, filterName, fillFiltered) {
  if (fillFiltered) {
    targetCtx.save();
    tracePoly(targetCtx, corners);
    targetCtx.clip();
    targetCtx.drawImage(sourceCanvas, 0, 0);
    targetCtx.restore();
  }
  targetCtx.save();
  tracePoly(targetCtx, corners);
  targetCtx.lineWidth = 4;
  targetCtx.strokeStyle = "#22c55e";
  targetCtx.shadowColor = "#22c55e";
  targetCtx.shadowBlur = 12;
  targetCtx.stroke();
  for (const pt of corners) {
    targetCtx.beginPath();
    targetCtx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
    targetCtx.fillStyle = "#4ade80";
    targetCtx.fill();
  }
  const topX = (corners[0].x + corners[1].x) / 2;
  const topY = Math.min(corners[0].y, corners[1].y) - 14;
  targetCtx.font = "bold 15px monospace";
  targetCtx.fillStyle = "#4ade80";
  targetCtx.textAlign = "center";
  targetCtx.shadowBlur = 0;
  targetCtx.fillText("PORTAL: " + filterName, topX, Math.max(25, topY));
  targetCtx.restore();
}

/* PIXELATE tanpa loop piksel (Retrolens pixelate): region diperkecil
   lalu diperbesar dengan smoothing mati, di-clip ke poligon portal. */
function drawPortalPixelate(targetCtx, sourceCanvas, corners, filterName) {
  const bb = bboxOf(corners);
  const block = 14;
  const sw = Math.max(1, Math.floor(bb.w / block));
  const sh = Math.max(1, Math.floor(bb.h / block));
  pixelCanvas.width = sw;
  pixelCanvas.height = sh;
  pixelCtx.imageSmoothingEnabled = true;
  pixelCtx.drawImage(sourceCanvas, bb.x, bb.y, bb.w, bb.h, 0, 0, sw, sh);
  targetCtx.save();
  tracePoly(targetCtx, corners);
  targetCtx.clip();
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.drawImage(pixelCanvas, 0, 0, sw, sh, bb.x, bb.y, bb.w, bb.h);
  targetCtx.restore();
  drawPortal(targetCtx, sourceCanvas, corners, filterName, false);
}

/* PIXELATE untuk seluruh layar (filter layar aktif hasil tembakan). */
function drawFullscreenPixelate(targetCtx, sourceCanvas, w, h) {
  const block = 14;
  const sw = Math.max(1, Math.floor(w / block));
  const sh = Math.max(1, Math.floor(h / block));
  pixelCanvas.width = sw;
  pixelCanvas.height = sh;
  pixelCtx.imageSmoothingEnabled = true;
  pixelCtx.drawImage(sourceCanvas, 0, 0, w, h, 0, 0, sw, sh);
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.drawImage(pixelCanvas, 0, 0, sw, sh, 0, 0, w, h);
}

function drawHandSkeleton(targetCtx, pts) {
  targetCtx.save();
  targetCtx.strokeStyle = "rgba(74, 222, 128, 0.35)";
  targetCtx.lineWidth = 2;
  targetCtx.beginPath();
  for (const pair of CONNECTIONS) {
    targetCtx.moveTo(pts[pair[0]].x, pts[pair[0]].y);
    targetCtx.lineTo(pts[pair[1]].x, pts[pair[1]].y);
  }
  targetCtx.stroke();
  for (const idx of [4, 8]) {
    targetCtx.beginPath();
    targetCtx.arc(pts[idx].x, pts[idx].y, 5, 0, Math.PI * 2);
    targetCtx.fillStyle = "#4ade80";
    targetCtx.fill();
  }
  targetCtx.restore();
}

function drawSlingshot(targetCtx, forkTop, forkBottom, pullPos, filterName) {
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.moveTo(forkTop.x, forkTop.y);
  targetCtx.lineTo(forkBottom.x, forkBottom.y);
  targetCtx.lineWidth = 3;
  targetCtx.strokeStyle = "rgba(34, 197, 94, 0.5)";
  targetCtx.stroke();

  targetCtx.beginPath();
  targetCtx.moveTo(forkTop.x, forkTop.y);
  targetCtx.lineTo(pullPos.x, pullPos.y);
  targetCtx.lineTo(forkBottom.x, forkBottom.y);
  targetCtx.lineWidth = 4;
  targetCtx.strokeStyle = "#22c55e";
  targetCtx.shadowColor = "#22c55e";
  targetCtx.shadowBlur = 10;
  targetCtx.stroke();

  if (isPullingSlingshot) {
    const dx = slingshotAnchorPos.x - pullPos.x;
    const dy = slingshotAnchorPos.y - pullPos.y;
    targetCtx.beginPath();
    targetCtx.setLineDash([8, 8]);
    targetCtx.moveTo(slingshotAnchorPos.x, slingshotAnchorPos.y);
    targetCtx.lineTo(slingshotAnchorPos.x + dx * 2.5, slingshotAnchorPos.y + dy * 2.5);
    targetCtx.lineWidth = 2;
    targetCtx.strokeStyle = "rgba(56, 189, 248, 0.7)";
    targetCtx.stroke();
    targetCtx.setLineDash([]);
  }

  const ammoColor = filterAmmoColor(filterName);
  targetCtx.beginPath();
  targetCtx.arc(pullPos.x, pullPos.y, 14, 0, Math.PI * 2);
  targetCtx.fillStyle = ammoColor;
  targetCtx.shadowColor = ammoColor;
  targetCtx.shadowBlur = 20;
  targetCtx.fill();
  targetCtx.lineWidth = 2;
  targetCtx.strokeStyle = "#ffffff";
  targetCtx.stroke();

  targetCtx.font = "bold 13px monospace";
  targetCtx.fillStyle = "#4ade80";
  targetCtx.textAlign = "center";
  targetCtx.shadowBlur = 0;
  targetCtx.fillText("AMMO: " + filterName, pullPos.x, pullPos.y - 24);
  targetCtx.restore();
}

function launchProjectile(startPos, anchorPos, filterType) {
  const dx = anchorPos.x - startPos.x;
  const dy = anchorPos.y - startPos.y;
  const distPull = Math.hypot(dx, dy);
  if (distPull < PULL_MIN_DIST) return;
  projectile = {
    x: startPos.x,
    y: startPos.y,
    vx: dx * PROJECTILE_SPEED,
    vy: dy * PROJECTILE_SPEED,
    filter: filterType,
    radius: 18,
    life: 0,
  };
}

function updateAndDrawProjectile(targetCtx, width, height) {
  if (!projectile) return;
  projectile.x += projectile.vx;
  projectile.y += projectile.vy;
  projectile.life += 1;
  const color = filterAmmoColor(projectile.filter);
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
  targetCtx.fillStyle = color;
  targetCtx.shadowColor = color;
  targetCtx.shadowBlur = 30;
  targetCtx.fill();
  targetCtx.restore();
  const hitEdge = projectile.x < 40 || projectile.x > width - 40
    || projectile.y < 40 || projectile.y > height - 40;
  if (projectile.life > PROJECTILE_MAX_LIFE || hitEdge) {
    activeScreenFilter = projectile.filter;
    shockwave = {
      x: Math.max(50, Math.min(width - 50, projectile.x)),
      y: Math.max(50, Math.min(height - 50, projectile.y)),
      radius: 20,
      maxRadius: Math.max(width, height) * 1.1,
      alpha: 1.0,
      color: color,
    };
    showBanner("Filter layar: " + activeScreenFilter, "#a855f7");
    updateFilterLine();
    projectile = null;
  }
}

function updateAndDrawShockwave(targetCtx) {
  if (!shockwave) return;
  shockwave.radius += 45;
  shockwave.alpha -= 0.04;
  if (shockwave.alpha <= 0 || shockwave.radius >= shockwave.maxRadius) {
    shockwave = null;
    return;
  }
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.arc(shockwave.x, shockwave.y, shockwave.radius, 0, Math.PI * 2);
  targetCtx.lineWidth = 8;
  targetCtx.strokeStyle = shockwave.color;
  targetCtx.globalAlpha = Math.max(0, shockwave.alpha);
  targetCtx.stroke();
  targetCtx.restore();
}

/* --- Loop utama hasil MediaPipe Hands --- */

function currentFps() {
  const now = performance.now();
  while (detectTimes.length && now - detectTimes[0] > 1000) detectTimes.shift();
  if (detectTimes.length < 2) return 0;
  const span = (detectTimes[detectTimes.length - 1] - detectTimes[0]) / 1000;
  return span > 0 ? Math.round((detectTimes.length - 1) / span) : 0;
}

function setStatus(handCount, gestureText, fps) {
  handCountEl.textContent = String(handCount);
  handCountEl.classList.toggle("on", handCount > 0);
  fpsEl.textContent = fps + " fps";
  fpsFillEl.style.width = Math.min(100, Math.round(fps / FPS_TARGET * 100)) + "%";
  gestureEl.textContent = gestureText;
  gestureEl.classList.toggle("on", handCount > 0);
}

function resizeCanvases(w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (offCanvas.width !== w || offCanvas.height !== h) {
    offCanvas.width = w;
    offCanvas.height = h;
  }
}

function onResults(results) {
  if (!gotResults) {
    gotResults = true;
    setLoadStage("Siap", 100);
    loadingOverlay.hidden = true;
  }
  const now = performance.now();
  detectTimes.push(now);
  if (detectTimes.length > 120) detectTimes.shift();

  const w = video.videoWidth || LEVELS[levelIdx].w;
  const h = video.videoHeight || LEVELS[levelIdx].h;
  resizeCanvases(w, h);

  /* 1. Frame mentah, mirror seperti selfie. */
  drawMirrored(ctx, video, w, h);
  drawMirrored(offCtx, video, w, h);

  /* 2. Petakan landmark ke piksel layar (mirror X), urutkan kiri-kanan,
     haluskan dengan lerp supaya tidak bergetar. */
  const rawHands = (results.multiHandLandmarks || []).map((landmarks) => ({
    landmarks: landmarks,
    pts: landmarks.map((pt) => ({
      x: (1 - pt.x) * w,
      y: pt.y * h,
    })),
  }));
  rawHands.sort((a, b) => a.pts[0].x - b.pts[0].x);
  const mappedHands = rawHands.map((hand, handIdx) => {
    if (!smoothedHands[handIdx]) {
      smoothedHands[handIdx] = hand.pts.map((p) => ({ x: p.x, y: p.y }));
    } else {
      hand.pts.forEach((p, ptIdx) => {
        smoothedHands[handIdx][ptIdx].x =
          lerp(smoothedHands[handIdx][ptIdx].x, p.x, SMOOTHING_FACTOR);
        smoothedHands[handIdx][ptIdx].y =
          lerp(smoothedHands[handIdx][ptIdx].y, p.y, SMOOTHING_FACTOR);
      });
    }
    return { landmarks: hand.landmarks, pts: smoothedHands[handIdx] };
  });
  if (mappedHands.length < smoothedHands.length) {
    smoothedHands = smoothedHands.slice(0, mappedHands.length);
  }

  /* 3. Klasifikasi gestur. */
  let gestureText = mappedHands.length > 0 ? "tangan terdeteksi" : "tidak ada";
  let portals = [];
  let slingDraw = null;
  if (mappedHands.length === 2) {
    const leftHand = mappedHands[0];
    const rightHand = mappedHands[1];
    if (isFist(leftHand.landmarks) && isFist(rightHand.landmarks)) {
      if (now > resetCooldown) {
        resetScreenFilter();
        cycleFilter();
        resetCooldown = now + RESET_COOLDOWN_MS;
      }
      isPullingSlingshot = false;
      gestureText = "Reset";
    } else if (isPistolGesture(leftHand.landmarks)) {
      const thumbL = leftHand.pts[4];
      const indexL = leftHand.pts[8];
      const pinchR = isPinching(rightHand.landmarks);
      const pinchCenterR = {
        x: (rightHand.pts[4].x + rightHand.pts[8].x) / 2,
        y: (rightHand.pts[4].y + rightHand.pts[8].y) / 2,
      };
      slingshotAnchorPos = {
        x: (thumbL.x + indexL.x) / 2,
        y: (thumbL.y + indexL.y) / 2,
      };
      if (pinchR) {
        isPullingSlingshot = true;
        slingshotPullPos = pinchCenterR;
        slingDraw = { top: thumbL, bottom: indexL, pull: pinchCenterR };
        instructionEl.textContent = "Lepas cubitan untuk menembak.";
        gestureText = "Ketapel: tarik";
      } else {
        if (isPullingSlingshot) {
          launchProjectile(slingshotPullPos, slingshotAnchorPos, FILTERS[currentPortalFilterIdx]);
          isPullingSlingshot = false;
        }
        slingDraw = { top: thumbL, bottom: indexL, pull: slingshotAnchorPos };
        instructionEl.textContent = "Cubit kanan untuk menarik, lepas untuk menembak.";
        gestureText = "Ketapel: siap";
      }
    } else {
      isPullingSlingshot = false;
      if (is3dMode) {
        /* Mode 3D (Retrolens): dua segi enam dari 5 ujung jari tiap
           tangan, filter aktif dan filter berikutnya. */
        const t1 = [4, 8, 12, 16, 20].map((i) => leftHand.pts[i]);
        const t2 = [4, 8, 12, 16, 20].map((i) => rightHand.pts[i]);
        portals = [
          { corners: sortCornersClockwise([t1[0], t1[1], t1[2], t2[2], t2[1], t2[0]]), filter: FILTERS[currentPortalFilterIdx] },
          { corners: sortCornersClockwise([t1[2], t1[3], t1[4], t2[4], t2[3], t2[2]]), filter: nextFilterName() },
        ];
        instructionEl.textContent = "Portal 3D " + FILTERS[currentPortalFilterIdx]
          + " + " + nextFilterName() + ".";
        gestureText = "Portal 3D";
      } else {
        const rawCorners = [
          leftHand.pts[8],
          rightHand.pts[8],
          rightHand.pts[4],
          leftHand.pts[4],
        ];
        portals = [{ corners: sortCornersClockwise(rawCorners), filter: FILTERS[currentPortalFilterIdx] }];
        instructionEl.textContent = "Portal " + FILTERS[currentPortalFilterIdx]
          + ". Cubit jempol-kelingking: ganti filter.";
        gestureText = "Portal";
      }
    }
  } else if (mappedHands.length === 1) {
    isPullingSlingshot = false;
    const hand = mappedHands[0];
    if (isHandOpen(hand.landmarks)) {
      /* Portal satu tangan (Retrolens): hanya saat tangan terbuka penuh,
         supaya tidak bentrok dengan kode jari dan pose pistol. */
      const tips = [4, 8, 12, 16, 20].map((i) => hand.pts[i]);
      const corners = is3dMode
        ? sortCornersClockwise(tips)
        : sortCornersClockwise([tips[0], tips[1], tips[2], tips[4]]);
      portals = [{ corners: corners, filter: FILTERS[currentPortalFilterIdx] }];
      instructionEl.textContent = "Portal 1 tangan " + FILTERS[currentPortalFilterIdx] + ".";
      gestureText = "Portal 1 tangan";
    } else {
      instructionEl.textContent = INSTRUCTION_DEFAULT;
    }
  } else {
    isPullingSlingshot = false;
    instructionEl.textContent = INSTRUCTION_DEFAULT;
  }

  /* Cubit jempol-kelingking ganti filter, jalan juga saat portal terbuka. */
  updateThumbPinkyPinch(now, mappedHands);

  /* 4. Filter piksel. Layar penuh hanya kalau filter layar aktif;
     portal hanya memfilter bounding-box region-nya. */
  const timeSec = now / 1000;
  if (activeScreenFilter !== "NORMAL") {
    if (activeScreenFilter === "PIXELATE") {
      drawFullscreenPixelate(ctx, offCanvas, w, h);
    } else {
      applyPixelFilterRegion(offCtx, 0, 0, w, h, activeScreenFilter, timeSec);
      ctx.drawImage(offCanvas, 0, 0);
    }
    for (const p of portals) {
      drawPortal(ctx, offCanvas, p.corners, p.filter, false);
    }
  } else {
    for (const p of portals) {
      if (p.filter === "PIXELATE") {
        drawPortalPixelate(ctx, offCanvas, p.corners, p.filter);
      } else {
        const bb = bboxOf(p.corners);
        applyPixelFilterRegion(offCtx, bb.x, bb.y, bb.w, bb.h, p.filter, timeSec);
        drawPortal(ctx, offCanvas, p.corners, p.filter, true);
      }
    }
  }

  /* 5. Skeleton tipis di atas frame. */
  for (const hand of mappedHands) drawHandSkeleton(ctx, hand.pts);

  /* 6. Ketapel, proyektil, gelombang kejut. */
  if (slingDraw) {
    drawSlingshot(ctx, slingDraw.top, slingDraw.bottom, slingDraw.pull, FILTERS[currentPortalFilterIdx]);
  }
  updateAndDrawProjectile(ctx, w, h);
  updateAndDrawShockwave(ctx);

  /* 7. Kode jari satu tangan ganti amunisi. */
  let fingers = null;
  if (mappedHands.length === 1) fingers = countFingers(mappedHands[0].landmarks);
  updateFingerFilter(now, mappedHands.length, fingers);
  updateHoldBar(now);

  /* 8. HUD dan adaptive degradation. */
  if (now - statusUpdatedAt >= 500) {
    statusUpdatedAt = now;
    shownFps = currentFps();
    setStatus(mappedHands.length, gestureText, shownFps);
  }
  void maybeStepDown(now);
}

/* --- Screenshot dan mode 3D --- */

/* Screenshot: simpan frame canvas komposit jadi PNG. */
function takeScreenshot() {
  if (!stream) {
    showError("Nyalakan kamera dulu untuk screenshot.");
    return;
  }
  const link = document.createElement("a");
  link.download = "cap_" + Date.now() + ".png";
  link.href = canvas.toDataURL("image/png");
  link.click();
  showBanner("Screenshot disimpan", "#22c55e");
}

/* Mode 3D: dua poligon, dua filter. Toggle lewat tombol, bukan kepalan
   (kepal 2 tangan sudah dipakai reset + rotasi filter). */
function toggle3dMode() {
  is3dMode = !is3dMode;
  mode3dLabel.textContent = is3dMode ? "Mode 2D" : "Mode 3D";
  mode3dBtn.setAttribute("aria-pressed", String(is3dMode));
  showBanner(is3dMode ? "Mode 3D" : "Mode 2D", "#22d3ee");
}

/* --- Kamera, model, dan adaptive degradation --- */

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function setStageMessage(text) {
  stageMessage.textContent = text;
  stageMessage.hidden = !text;
}

function updateModeLine() {
  const vw = video.videoWidth || LEVELS[levelIdx].w;
  const vh = video.videoHeight || LEVELS[levelIdx].h;
  const hemat = levelIdx > 0 ? " · mode hemat" : "";
  modeLine.textContent = "Deteksi: " + vw + "x" + vh + hemat;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("gagal memuat " + src));
    document.head.appendChild(s);
  });
}

async function pickHandsBase() {
  try {
    const r = await fetch(HANDS_LOCAL_BASE + HANDS_WASM_PROBE, { method: "HEAD" });
    if (r.ok) return HANDS_LOCAL_BASE;
  } catch (e) { /* pakai CDN */ }
  return HANDS_CDN_BASE;
}

async function ensureHands() {
  if (hands) return hands;
  if (typeof Hands === "undefined") {
    await loadScript(HANDS_CDN_BASE + "hands.js");
    if (typeof Hands === "undefined") {
      throw new Error("pustaka MediaPipe Hands tidak bisa dimuat");
    }
    handsBase = HANDS_CDN_BASE;
  } else {
    handsBase = await pickHandsBase();
  }
  hands = new Hands({
    locateFile: (file) => handsBase + file,
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.65,
  });
  hands.onResults(onResults);
  return hands;
}

async function acquireStream(level) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: level.w },
      height: { ideal: level.h },
      facingMode: "user",
    },
    audio: false,
  });
}

async function maybeStepDown(now) {
  if (switchingLevel || levelIdx >= LEVELS.length - 1) return;
  if (now - startedAt < 3000) return;
  if (now - lastAdaptCheck < 2000) return;
  lastAdaptCheck = now;
  if (currentFps() >= FPS_STEP_DOWN) return;
  switchingLevel = true;
  levelIdx += 1;
  try {
    const next = await acquireStream(LEVELS[levelIdx]);
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = next;
    video.srcObject = stream;
    await video.play();
    updateModeLine();
    detectTimes = [];
  } catch (err) {
    levelIdx -= 1;
    showError("Turun resolusi gagal: " + err.message);
  } finally {
    switchingLevel = false;
  }
}

function onHandsError(err) {
  if (handsFailed) return;
  handsFailed = true;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  loadingOverlay.hidden = true;
  errorOverlay.hidden = false;
  errorMessage.textContent = "Model tidak bisa dimuat: " + (err && err.message ? err.message : err)
    + " Periksa koneksi lalu coba lagi.";
}

function loop() {
  if (!stream || handsFailed) return;
  rafId = requestAnimationFrame(loop);
  if (!hands || video.readyState < 2 || sending) return;
  sending = true;
  hands.send({ image: video }).then(
    () => { sending = false; },
    (err) => { sending = false; onHandsError(err); }
  );
}

async function startCamera() {
  clearError();
  errorOverlay.hidden = true;
  setStageMessage("");
  loadingOverlay.hidden = false;
  setLoadStage("Muat pustaka", 20);
  startBtn.disabled = true;
  gotResults = false;
  handsFailed = false;
  try {
    await ensureHands();
    setLoadStage("Buka kamera", 55);
    stream = await acquireStream(LEVELS[levelIdx]);
    video.srcObject = stream;
    await video.play();
    setLoadStage("Muat model", 80);
    updateModeLine();
    stopBtn.disabled = false;
    detectTimes = [];
    startedAt = performance.now();
    lastAdaptCheck = startedAt;
    statusUpdatedAt = 0;
    setTimeout(() => {
      if (stream && !gotResults && !handsFailed) {
        onHandsError(new Error("tidak ada hasil deteksi dalam 15 detik"));
      }
    }, RESULTS_WATCHDOG_MS);
    loop();
  } catch (err) {
    loadingOverlay.hidden = true;
    errorOverlay.hidden = false;
    errorMessage.textContent = "Kamera tidak bisa dibuka: " + err.message;
    setStageMessage("Kamera tidak bisa dibuka.");
    startBtn.disabled = false;
  }
}

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video.srcObject = null;
  sending = false;
  isPullingSlingshot = false;
  projectile = null;
  shockwave = null;
  smoothedHands = [];
  thumbPinkyActive = [];
  filterCandidate = null;
  activeScreenFilter = "NORMAL";
  currentPortalFilterIdx = 0;
  updateFilterLine();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  setStatus(0, "tidak ada", 0);
  instructionEl.textContent = INSTRUCTION_DEFAULT;
  loadingOverlay.hidden = true;
  errorOverlay.hidden = true;
  holdBarEl.hidden = true;
  setStageMessage("Kamera mati.");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const dark = theme === "dark";
  themeLabel.textContent = dark ? "Terang" : "Gelap";
  themeIconMoon.hidden = dark;
  themeIconSun.hidden = !dark;
  themeToggle.setAttribute("aria-pressed", String(dark));
  try { localStorage.setItem("tracking-theme", theme); } catch (e) { /* abaikan */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("tracking-theme"); } catch (e) { /* abaikan */ }
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    applyTheme("dark");
  } else {
    applyTheme("light");
  }
}

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    cycleFilter();
  } else if (e.code === "KeyR") {
    resetScreenFilter();
  } else if (e.code === "KeyS") {
    takeScreenshot();
  }
});

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const req = stageWrap.requestFullscreen || stageWrap.webkitRequestFullscreen;
  if (!req) {
    showError("Browser ini tidak mendukung layar penuh.");
    return;
  }
  req.call(stageWrap).catch((err) => showError("Layar penuh gagal: " + err.message));
}

document.addEventListener("fullscreenchange", () => {
  fullscreenLabel.textContent = document.fullscreenElement ? "Keluar Layar Penuh" : "Layar Penuh";
});

startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);
cycleBtn.addEventListener("click", cycleFilter);
resetBtn.addEventListener("click", resetScreenFilter);
fullscreenBtn.addEventListener("click", toggleFullscreen);
screenshotBtn.addEventListener("click", takeScreenshot);
mode3dBtn.addEventListener("click", toggle3dMode);
retryBtn.addEventListener("click", () => { location.reload(); });

initTheme();
updateFilterLine();
window.__trackingReady = true;
