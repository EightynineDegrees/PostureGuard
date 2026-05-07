'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const videoEl        = document.getElementById('videoEl');
const overlayCanvas  = document.getElementById('overlayCanvas');
const cameraBox      = document.getElementById('cameraBox');
const btnToggle      = document.getElementById('btnToggle');
const btnCalibrate   = document.getElementById('btnCalibrate');
const calibGuide     = document.getElementById('calibGuide');
const toggleMirror   = document.getElementById('toggleMirror');
const toggleLandmark = document.getElementById('toggleLandmark');
const toastAlert     = document.getElementById('toastAlert');
const toastText      = document.getElementById('toastText');
const placeholder    = document.querySelector('.camera-placeholder');
const canvasCtx      = overlayCanvas.getContext('2d');

// ── Constants ─────────────────────────────────────────────────────────────────
const KEY_LANDMARKS = [0, 7, 8, 11, 12, 23, 24];
const STABILITY_FRAMES = 30;

const THRESHOLDS = {
  low:    { earDiff: 0.05, shoulderDiff: 0.05, neckZ: 0.15, slouchY: 0.06 },
  medium: { earDiff: 0.03, shoulderDiff: 0.03, neckZ: 0.10, slouchY: 0.04 },
  high:   { earDiff: 0.02, shoulderDiff: 0.02, neckZ: 0.07, slouchY: 0.02 },
};

const ALERT_META = {
  head:     { label: 'Head Tilt',      icon: '↕',  message: 'Your head is tilted. Please straighten it.' },
  shoulder: { label: 'Shoulder Tilt',  icon: '↗',  message: 'Your shoulders are uneven. Please level them.' },
  neck:     { label: 'Forward Neck',   icon: '🐢', message: 'Your neck is leaning forward. Pull it back.' },
  slouch:   { label: 'Slouching',      icon: '⬇',  message: 'Your shoulders are dropping. Sit up straight.' },
};

const DEFAULT_SETTINGS = {
  sensitivity:   'medium',
  cooldown:      60,
  speech:        false,
  notifications: false,
  landmarks:     true,
  mirror:        true,
};

// ── Global state ──────────────────────────────────────────────────────────────
const state = {
  isMonitoring:  false,
  isMirrored:    true,
  showLandmarks: true,
  lastLandmarks: null,
  calibration:   null,
  settings:      { ...DEFAULT_SETTINGS },
  sessions:      [],
};

// ── Per-frame analysis state ──────────────────────────────────────────────────
const frameCounters = { head: 0, shoulder: 0, neck: 0, slouch: 0 };
const lastAlertTime = { head: 0, shoulder: 0, neck: 0, slouch: 0 };
const wasAlerted    = { head: false, shoulder: false, neck: false, slouch: false };
const prevStable    = { head: false, shoulder: false, neck: false, slouch: false };

let goodFrameCount  = 0;
let totalFrameCount = 0;

// ── Session state ─────────────────────────────────────────────────────────────
let currentSession  = null;
let sessionInterval = null;

// ── Camera / FPS state ────────────────────────────────────────────────────────
let cameraStream  = null;   // kept for resolution downgrade
let lastFrameTime = 0;      // ms timestamp of previous onPoseResults call
let lowFpsStart   = 0;      // when consecutive low-fps began (0 = not low)

// ── Lazy-created overlay banners ──────────────────────────────────────────────
let bodyWarnEl  = null;
let lightWarnEl = null;

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  try {
    const sess = localStorage.getItem('postureguard_sessions');
    const sett = localStorage.getItem('postureguard_settings');
    if (sess) state.sessions = JSON.parse(sess);
    if (sett) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(sett) };
  } catch (e) {
    console.warn('[PostureGuard] localStorage load failed:', e);
  }

  applySettingsToUI();
  loadCalibration();
  setupCamera();
  renderTodayStats();
  renderSessionList('today');
}

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION
// ─────────────────────────────────────────────────────────────────────────────

// Loads saved calibration and updates button/toggle state
function loadCalibration() {
  try {
    const raw = localStorage.getItem('postureguard_calibration');
    state.calibration = raw ? JSON.parse(raw) : null;
  } catch (e) {
    state.calibration = null;
  }

  if (state.calibration) {
    calibGuide.classList.add('hidden');
    btnCalibrate.textContent = '📐 Recalibrate';
    btnCalibrate.classList.remove('needs-calib');
    btnToggle.disabled = false;
  } else {
    calibGuide.classList.remove('hidden');
    btnCalibrate.textContent = '📐 Set Baseline';
    btnCalibrate.classList.add('needs-calib');
    btnToggle.disabled = true;
  }
}

// Captures current landmark positions as the "good posture" baseline
function calibrate() {
  if (!state.lastLandmarks) {
    alert('Your upper body is not visible. Please adjust your position and try again.');
    return;
  }

  const lm = state.lastLandmarks;
  const requiredIdx = [0, 7, 8, 11, 12];
  const allVisible = requiredIdx.every(i => lm[i] && lm[i].visibility >= 0.5);

  if (!allVisible) {
    alert('Landmarks could not be detected. Please improve lighting and make sure your upper body is visible.');
    return;
  }

  state.calibration = {
    calibratedAt:    new Date().toISOString(),
    earDiff:         Math.abs(lm[7].y - lm[8].y),
    shoulderDiff:    Math.abs(lm[11].y - lm[12].y),
    noseToShoulderZ: lm[0].z - (lm[11].z + lm[12].z) / 2,
    shoulderMidY:    (lm[11].y + lm[12].y) / 2,
  };

  localStorage.setItem('postureguard_calibration', JSON.stringify(state.calibration));

  calibGuide.classList.add('hidden');
  btnCalibrate.textContent = '📐 Recalibrate';
  btnCalibrate.classList.remove('needs-calib');
  btnToggle.disabled = false;

  showToast('✅ Baseline posture saved', 'success');
}

// Clears calibration data and stops any active monitoring
function resetCalibration() {
  state.calibration = null;
  localStorage.removeItem('postureguard_calibration');

  if (state.isMonitoring) {
    state.isMonitoring = false;
    endSession();
    btnToggle.textContent = '▶ Start Monitoring';
    btnToggle.classList.remove('active');
  }

  calibGuide.classList.remove('hidden');
  btnCalibrate.textContent = '📐 Set Baseline';
  btnCalibrate.classList.add('needs-calib');
  btnToggle.disabled = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA
// ─────────────────────────────────────────────────────────────────────────────

// Requests camera access; constraints allow resolution downgrade on low-spec devices
async function setupCamera(constraints = { width: 640, height: 480 }) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { ...constraints, facingMode: 'user' },
      audio: false,
    });
    cameraStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    placeholder.style.display = 'none';
    setupMediaPipe();
  } catch (err) {
    showCameraError();
  }
}

// Shows a user-friendly error inside the camera box
function showCameraError() {
  placeholder.style.display = 'flex';
  placeholder.innerHTML = `
    <span class="cam-icon">📷</span>
    <p style="color:var(--red);text-align:center;max-width:280px;font-weight:600;margin-bottom:8px;">
      Camera access is required
    </p>
    <p style="color:var(--muted);text-align:center;max-width:280px;font-size:12px;line-height:1.6;">
      Click the lock icon in your browser's address bar → Camera → Allow, then refresh
    </p>
  `;
}

// Stops current stream and restarts at lower resolution
async function downgradeResolution() {
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  console.warn('[PostureGuard] Low-spec device detected: reducing resolution to 320×240');
  await setupCamera({ width: 320, height: 240 });
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIAPIPE
// ─────────────────────────────────────────────────────────────────────────────

function setupMediaPipe() {
  const pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });

  pose.setOptions({
    modelComplexity:        1,
    smoothLandmarks:        true,
    enableSegmentation:     false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence:  0.5,
  });

  pose.onResults(onPoseResults);

  const camera = new Camera(videoEl, {
    onFrame: async () => { await pose.send({ image: videoEl }); },
    width:  640,
    height: 480,
  });

  camera.start();
}

// Processes each MediaPipe frame: draws landmarks and drives posture analysis
function onPoseResults(results) {
  // Case 4: FPS monitoring — downgrade resolution on sustained low fps
  const now = performance.now();
  if (lastFrameTime > 0) {
    const fps = 1000 / (now - lastFrameTime);
    if (fps < 10) {
      if (lowFpsStart === 0) lowFpsStart = now;
      else if (lowFpsStart > 0 && now - lowFpsStart >= 3000) {
        lowFpsStart = -1; // sentinel: prevent repeated downgrades
        downgradeResolution();
      }
    } else {
      lowFpsStart = 0;
    }
  }
  lastFrameTime = now;

  canvasCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (results.poseLandmarks && state.showLandmarks) {
    drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {
      color: 'rgba(0, 212, 170, 0.6)',
      lineWidth: 2,
    });
    drawLandmarks(canvasCtx, results.poseLandmarks, {
      color: 'rgba(0, 212, 170, 0.25)',
      fillColor: 'rgba(0, 212, 170, 0.1)',
      lineWidth: 1,
      radius: 2,
    });
    const keyPoints = KEY_LANDMARKS.map(i => results.poseLandmarks[i]).filter(Boolean);
    drawLandmarks(canvasCtx, keyPoints, {
      color: '#00d4aa',
      fillColor: '#00d4aa',
      lineWidth: 2,
      radius: 5,
    });
  }

  state.lastLandmarks = results.poseLandmarks ?? null;

  if (state.isMonitoring && state.lastLandmarks) {
    analyzePosture(state.lastLandmarks);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTURE ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

// Runs all four posture checks, applies stability filter, and updates UI
function analyzePosture(landmarks) {
  if (!landmarks) return;

  const keyIndices = [0, 7, 8, 11, 12];

  // Case 2: upper body out of frame
  const keyAvgVis = keyIndices.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / keyIndices.length;
  if (keyAvgVis < 0.3) {
    showBodyWarning(true);
    showLightWarning(false);
    return;
  }
  showBodyWarning(false);

  // Case 3: low lighting — all landmarks are dim
  const allAvgVis = landmarks.reduce((s, lm) => s + (lm?.visibility ?? 0), 0) / landmarks.length;
  showLightWarning(allAvgVis < 0.4);

  const cal = state.calibration;
  const thr = THRESHOLDS[state.settings.sensitivity] ?? THRESHOLDS.medium;
  const lm  = landmarks;

  // Raw per-frame detections
  const raw = { head: false, shoulder: false, neck: false, slouch: false };

  // 1. Head tilt
  if ((lm[7]?.visibility ?? 0) > 0.5 && (lm[8]?.visibility ?? 0) > 0.5) {
    const cur = Math.abs(lm[7].y - lm[8].y);
    raw.head = Math.abs(cur - cal.earDiff) > thr.earDiff;
  }

  // 2. Shoulder tilt
  if ((lm[11]?.visibility ?? 0) > 0.5 && (lm[12]?.visibility ?? 0) > 0.5) {
    const cur = Math.abs(lm[11].y - lm[12].y);
    raw.shoulder = Math.abs(cur - cal.shoulderDiff) > thr.shoulderDiff;
  }

  // 3. Forward neck (turtle neck)
  if ((lm[0]?.visibility ?? 0) > 0.5 && (lm[11]?.visibility ?? 0) > 0.5 && (lm[12]?.visibility ?? 0) > 0.5) {
    const cur = lm[0].z - (lm[11].z + lm[12].z) / 2;
    raw.neck = (cur - cal.noseToShoulderZ) < -thr.neckZ;
  }

  // 4. Slouch
  if ((lm[11]?.visibility ?? 0) > 0.5 && (lm[12]?.visibility ?? 0) > 0.5) {
    const cur = (lm[11].y + lm[12].y) / 2;
    raw.slouch = (cur - cal.shoulderMidY) > thr.slouchY;
  }

  // Stability filter: require STABILITY_FRAMES consecutive bad frames before alerting
  const stable = { head: false, shoulder: false, neck: false, slouch: false };

  for (const type of Object.keys(frameCounters)) {
    if (raw[type]) {
      frameCounters[type]++;
      if (frameCounters[type] >= STABILITY_FRAMES) {
        stable[type] = true;
        triggerAlert(type);
      }
    } else {
      frameCounters[type] = 0;
    }
  }

  // Recovery: fire resolveAlert on bad→good transition
  for (const type of Object.keys(stable)) {
    if (prevStable[type] && !stable[type]) resolveAlert(type, stable);
    prevStable[type] = stable[type];
  }

  // Score: ratio of good frames in this session
  const isBad = Object.values(stable).some(Boolean);
  totalFrameCount++;
  if (!isBad) goodFrameCount++;

  const score = Math.round((goodFrameCount / totalFrameCount) * 100);
  document.getElementById('todayScore').textContent = score;

  updatePostureUI(stable);
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────────

// Fires all notification channels for a posture issue (respects cooldown)
function triggerAlert(type) {
  const cooldownMs = (state.settings.cooldown ?? 60) * 1000;
  if (Date.now() - lastAlertTime[type] < cooldownMs) return;

  lastAlertTime[type] = Date.now();
  wasAlerted[type]    = true;

  if (currentSession) {
    currentSession.alertCount++;
    currentSession.alerts.push({ type, occurredAt: new Date().toISOString() });
  }

  const meta = ALERT_META[type];

  showToast(`${meta.icon} ${meta.label}: ${meta.message}`, 'warning', 3000);
  if (state.settings.notifications) notifyBrowser(meta);
  if (state.settings.speech)        notifySpeech(meta);
}

// Shows recovery toast when all posture issues are resolved
function resolveAlert(type, currentStable) {
  if (!wasAlerted[type]) return;
  wasAlerted[type] = false;

  const allGood = Object.values(currentStable).every(v => !v);
  if (allGood) showToast('✅ Posture corrected — great job!', 'success', 1500);
}

// Sends a browser notification (only if permission already granted)
function notifyBrowser(meta) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification('PostureGuard', { body: meta.message, icon: '/favicon.ico' });
  }
}

// Speaks the alert message via Web Speech API (skips if already speaking)
function notifySpeech(meta) {
  if (!window.speechSynthesis || window.speechSynthesis.speaking) return;
  const utter = new SpeechSynthesisUtterance(meta.message);
  utter.lang = 'ko-KR';
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Updates alert badges, status badge, and camera box border
function updatePostureUI(alerts) {
  const alertMap = {
    head:     'alert-head',
    shoulder: 'alert-shoulder',
    neck:     'alert-neck',
    slouch:   'alert-slouch',
  };

  let anyBad = false;
  for (const [type, id] of Object.entries(alertMap)) {
    document.getElementById(id).classList.toggle('triggered', alerts[type]);
    if (alerts[type]) anyBad = true;
  }

  const statusEl = document.getElementById('postureStatus');
  if (anyBad) {
    statusEl.textContent = 'Poor ⚠️';
    statusEl.classList.add('bad');
    cameraBox.classList.add('bad-posture');
  } else {
    statusEl.textContent = 'Good ✅';
    statusEl.classList.remove('bad');
    cameraBox.classList.remove('bad-posture');
  }
}

// Yellow banner: body not visible in frame
function showBodyWarning(show) {
  if (show) {
    if (!bodyWarnEl) {
      bodyWarnEl = document.createElement('div');
      Object.assign(bodyWarnEl.style, {
        position: 'absolute', top: '12px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(240,165,0,0.92)', color: '#fff',
        fontSize: '12px', fontWeight: '600',
        padding: '6px 16px', borderRadius: '100px',
        whiteSpace: 'nowrap', zIndex: '20', pointerEvents: 'none',
      });
      bodyWarnEl.textContent = '📐 Please center your upper body in the frame';
      cameraBox.appendChild(bodyWarnEl);
    }
    bodyWarnEl.style.display = 'block';
  } else if (bodyWarnEl) {
    bodyWarnEl.style.display = 'none';
  }
}

// Yellow banner: lighting too dim for reliable detection
function showLightWarning(show) {
  if (show) {
    if (!lightWarnEl) {
      lightWarnEl = document.createElement('div');
      Object.assign(lightWarnEl.style, {
        position: 'absolute', top: '48px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(240,165,0,0.92)', color: '#fff',
        fontSize: '12px', fontWeight: '600',
        padding: '6px 16px', borderRadius: '100px',
        whiteSpace: 'nowrap', zIndex: '20', pointerEvents: 'none',
      });
      lightWarnEl.textContent = '💡 Lighting is too dim for reliable pose detection';
      cameraBox.appendChild(lightWarnEl);
    }
    lightWarnEl.style.display = 'block';
  } else if (lightWarnEl) {
    lightWarnEl.style.display = 'none';
  }
}

// Syncs video/canvas mirror transform to state
function applyMirror() {
  const val = state.isMirrored ? 'scaleX(-1)' : 'scaleX(1)';
  videoEl.style.transform       = val;
  overlayCanvas.style.transform = val;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(msg, type = 'warning', duration = 3000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastText.textContent = msg;
  toastAlert.classList.toggle('toast-success', type === 'success');
  toastAlert.classList.add('show');
  toastTimer = setTimeout(() => {
    toastAlert.classList.remove('show');
    toastTimer = null;
  }, duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

// Applies state.settings values to all modal UI elements
function applySettingsToUI() {
  const s = state.settings;

  state.isMirrored    = s.mirror;
  state.showLandmarks = s.landmarks;

  toggleMirror.checked   = s.mirror;
  toggleLandmark.checked = s.landmarks;

  document.getElementById('toggleSpeech').checked = s.speech;
  document.getElementById('toggleNotif').checked  = s.notifications;

  const cooldownSlider = document.getElementById('cooldownSlider');
  const cooldownVal    = document.getElementById('cooldownVal');
  cooldownSlider.value    = s.cooldown;
  cooldownVal.textContent = s.cooldown + 's';

  document.querySelectorAll('input[name="sensitivity"]').forEach(r => {
    r.checked = (r.value === s.sensitivity);
  });

  applyMirror();
}

// Persists current settings to localStorage
function saveSettings() {
  localStorage.setItem('postureguard_settings', JSON.stringify(state.settings));
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// Initialises a new session object and starts the elapsed-time timer
function startSession() {
  currentSession = {
    sessionId:        crypto.randomUUID(),
    date:             todayString(),
    startedAt:        new Date().toISOString(),
    endedAt:          null,
    durationSeconds:  0,
    alertCount:       0,
    goodPostureRatio: 0,
    score:            0,
    alerts:           [],
  };

  document.getElementById('sessionTimer').textContent = '00:00';
  sessionInterval = setInterval(() => {
    currentSession.durationSeconds++;
    const m = String(Math.floor(currentSession.durationSeconds / 60)).padStart(2, '0');
    const s = String(currentSession.durationSeconds % 60).padStart(2, '0');
    document.getElementById('sessionTimer').textContent = `${m}:${s}`;
  }, 1000);
}

// Finalises the session, saves to localStorage, and refreshes history UI
function endSession() {
  if (!currentSession) return;

  clearInterval(sessionInterval);
  sessionInterval = null;

  currentSession.endedAt          = new Date().toISOString();
  currentSession.goodPostureRatio  = totalFrameCount > 0 ? goodFrameCount / totalFrameCount : 0;
  currentSession.score             = Math.round(currentSession.goodPostureRatio * 100);

  state.sessions.unshift(currentSession);
  if (state.sessions.length > 30) state.sessions.pop();

  // Case 5: guard against storage quota overflow
  try {
    localStorage.setItem('postureguard_sessions', JSON.stringify(state.sessions));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      state.sessions.splice(-5);
      localStorage.setItem('postureguard_sessions', JSON.stringify(state.sessions));
    }
  }

  currentSession = null;
  document.getElementById('sessionTimer').textContent = '00:00';

  renderTodayStats();
  renderSessionList(activeTab());
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS & HISTORY UI
// ─────────────────────────────────────────────────────────────────────────────

// Computes and displays today's aggregate stats
function renderTodayStats() {
  const today        = todayString();
  const todaySessions = state.sessions.filter(s => s.date === today);

  const totalSec    = todaySessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const totalAlerts = todaySessions.reduce((sum, s) => sum + (s.alertCount || 0), 0);
  const avgScore    = todaySessions.length
    ? Math.round(todaySessions.reduce((sum, s) => sum + (s.score || 0), 0) / todaySessions.length)
    : '--';

  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');

  document.getElementById('statDuration').textContent = totalSec > 0 ? `${m}:${s}` : '--';
  document.getElementById('statAlerts').textContent   = todaySessions.length ? totalAlerts : '--';
  document.getElementById('statScore').textContent    = avgScore;
}

// Returns the currently active tab key
function activeTab() {
  const active = document.querySelector('.tab-btn.active');
  return active ? active.dataset.tab : 'today';
}

// Renders session cards for the given tab (today / week / all)
function renderSessionList(tab = 'today') {
  const today   = todayString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let filtered;
  if (tab === 'today')     filtered = state.sessions.filter(s => s.date === today);
  else if (tab === 'week') filtered = state.sessions.filter(s => s.date >= weekAgo);
  else                     filtered = state.sessions;

  const list  = document.getElementById('sessionList');
  const empty = document.getElementById('emptyState');

  list.querySelectorAll('.session-card').forEach(el => el.remove());

  if (filtered.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  filtered.forEach(sess => {
    const dt    = new Date(sess.startedAt);
    const mmdd  = `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
    const hhmm  = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const dur   = sess.durationSeconds || 0;
    const durStr = `${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(dur % 60).padStart(2, '0')}`;
    const score = sess.score ?? 0;
    const scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? '#f0a500' : 'var(--red)';

    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div>
        <div class="session-time">${mmdd} ${hhmm}</div>
        <div class="session-meta">⏱ ${durStr} &nbsp;|&nbsp; ⚠️ ${sess.alertCount || 0} alerts</div>
      </div>
      <div class="session-score" style="color:${scoreColor}">${score}pts</div>
    `;
    list.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT BINDINGS
// ─────────────────────────────────────────────────────────────────────────────

btnCalibrate.addEventListener('click', calibrate);

btnToggle.addEventListener('click', () => {
  // Case 6: guard against bypassing disabled state
  if (!state.calibration) {
    showToast('Please set a baseline posture first', 'warning');
    return;
  }

  state.isMonitoring = !state.isMonitoring;

  if (state.isMonitoring) {
    goodFrameCount  = 0;
    totalFrameCount = 0;
    for (const k of Object.keys(frameCounters)) {
      frameCounters[k] = 0;
      lastAlertTime[k] = 0;
      wasAlerted[k]    = false;
      prevStable[k]    = false;
    }
    updatePostureUI({ head: false, shoulder: false, neck: false, slouch: false });
    document.getElementById('todayScore').textContent = '--';

    startSession();
    btnToggle.textContent = '⏹ Stop Monitoring';
    btnToggle.classList.add('active');
  } else {
    endSession();
    btnToggle.textContent = '▶ Start Monitoring';
    btnToggle.classList.remove('active');
  }
});

toggleMirror.addEventListener('change', () => {
  state.isMirrored      = toggleMirror.checked;
  state.settings.mirror = toggleMirror.checked;
  applyMirror();
  saveSettings();
});

toggleLandmark.addEventListener('change', () => {
  state.showLandmarks      = toggleLandmark.checked;
  state.settings.landmarks = toggleLandmark.checked;
  // Canvas is cleared each frame, so turning off takes effect immediately
  saveSettings();
});

document.getElementById('toggleSpeech').addEventListener('change', (e) => {
  state.settings.speech = e.target.checked;
  saveSettings();
});

document.getElementById('toggleNotif').addEventListener('change', (e) => {
  state.settings.notifications = e.target.checked;
  // Request permission once when user first enables browser notifications
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  saveSettings();
});

document.getElementById('cooldownSlider').addEventListener('change', (e) => {
  state.settings.cooldown = Number(e.target.value);
  saveSettings();
});

document.querySelectorAll('input[name="sensitivity"]').forEach(r => {
  r.addEventListener('change', () => {
    state.settings.sensitivity = r.value;
    saveSettings();
  });
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('Reset all settings and history? This cannot be undone.')) return;

  resetCalibration();

  state.sessions  = [];
  state.settings  = { ...DEFAULT_SETTINGS };
  localStorage.removeItem('postureguard_sessions');
  localStorage.removeItem('postureguard_settings');
  applySettingsToUI();

  document.getElementById('settingsModal').classList.remove('open');
  showToast('All data has been reset', 'warning', 2500);

  renderTodayStats();
  renderSessionList(activeTab());
});

// Tab switching — active class + re-render
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderSessionList(btn.dataset.tab);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
init();
