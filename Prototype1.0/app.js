'use strict';

//  DOM refs
const videoEl        = document.getElementById('videoEl');
const overlayCanvas  = document.getElementById('overlayCanvas');
const canvasCtx      = overlayCanvas.getContext('2d');

const btnInitCam     = document.getElementById('btnInitCam');
const btnCalibrate   = document.getElementById('btnCalibrate');
const btnToggle      = document.getElementById('btnToggle');

const globalStatus   = document.getElementById('globalStatus');
const statusHead     = document.getElementById('statusHead');
const statusShoulder = document.getElementById('statusShoulder');
const statusNeck     = document.getElementById('statusNeck');
const statusSlouch   = document.getElementById('statusSlouch');

//  Constants 
const STABILITY_FRAMES = 15; // Reduced for a more responsive prototype
const THRESHOLDS = { earDiff: 0.03, shoulderDiff: 0.03, neckZ: 0.10, slouchY: 0.04 };
const KEY_LANDMARKS = [0, 7, 8, 11, 12, 23, 24];

// State 
let isMonitoring  = false;
let calibration   = null;
let lastLandmarks = null;

const frameCounters = { head: 0, shoulder: 0, neck: 0, slouch: 0 };

// Button Actions 
btnInitCam.addEventListener('click', setupCamera);

btnCalibrate.addEventListener('click', () => {
  if (!lastLandmarks) {
    alert("No body detected. Please stand in front of the camera.");
    return;
  }
  
  const lm = lastLandmarks;
  calibration = {
    earDiff:         Math.abs(lm[7].y - lm[8].y),
    shoulderDiff:    Math.abs(lm[11].y - lm[12].y),
    noseToShoulderZ: lm[0].z - (lm[11].z + lm[12].z) / 2,
    shoulderMidY:    (lm[11].y + lm[12].y) / 2,
  };

  btnToggle.disabled = false;
  alert("Reference position saved!");
});

btnToggle.addEventListener('click', () => {
  isMonitoring = !isMonitoring;
  if (isMonitoring) {
    btnToggle.textContent = "Stop Monitoring";
    globalStatus.textContent = "Monitoring active";
  } else {
    btnToggle.textContent = "Start Monitoring";
    globalStatus.textContent = "Monitoring paused";
    resetUI();
  }
});

// Camera & MediaPipe
async function setupCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    videoEl.srcObject = stream;
    
    setupMediaPipe();
    btnInitCam.disabled = true;
    btnCalibrate.disabled = false;
    globalStatus.textContent = "Camera active, please calibrate.";
  } catch (err) {
    alert("Error accessing camera.");
  }
}

function setupMediaPipe() {
  const pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  pose.onResults(onPoseResults);

  const camera = new Camera(videoEl, {
    onFrame: async () => { await pose.send({ image: videoEl }); },
    width: 640,
    height: 480,
  });

  camera.start();
}

function onPoseResults(results) {
  canvasCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (results.poseLandmarks) {
    // Draw base points for debugging
    drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 2 });
    drawLandmarks(canvasCtx, results.poseLandmarks, { color: '#FF0000', lineWidth: 1, radius: 2 });
    
    lastLandmarks = results.poseLandmarks;

    if (isMonitoring && calibration) {
      analyzePosture(lastLandmarks);
    }
  } else {
    lastLandmarks = null;
  }
}

// Posture Analysis
function analyzePosture(lm) {
  const cal = calibration;
  const raw = { head: false, shoulder: false, neck: false, slouch: false };

  // 1. Head tilt
  const curEarDiff = Math.abs(lm[7].y - lm[8].y);
  raw.head = Math.abs(curEarDiff - cal.earDiff) > THRESHOLDS.earDiff;

  // 2. Uneven shoulders
  const curShoulderDiff = Math.abs(lm[11].y - lm[12].y);
  raw.shoulder = Math.abs(curShoulderDiff - cal.shoulderDiff) > THRESHOLDS.shoulderDiff;

  // 3. Forward neck (Z-axis)
  const curNeckZ = lm[0].z - (lm[11].z + lm[12].z) / 2;
  raw.neck = (curNeckZ - cal.noseToShoulderZ) < -THRESHOLDS.neckZ;

  // 4. Slouching (Y-axis)
  const curSlouchY = (lm[11].y + lm[12].y) / 2;
  raw.slouch = (curSlouchY - cal.shoulderMidY) > THRESHOLDS.slouchY;

  const stable = { head: false, shoulder: false, neck: false, slouch: false };

  // Stability filter (requires N consecutive bad frames to trigger alert)
  for (const type of Object.keys(frameCounters)) {
    if (raw[type]) {
      frameCounters[type]++;
      if (frameCounters[type] >= STABILITY_FRAMES) stable[type] = true;
    } else {
      frameCounters[type] = 0;
    }
  }

  updateUI(stable);
}

//  UI 
function updateUI(alerts) {
  const isBadPosture = Object.values(alerts).some(Boolean);
  
  if (isBadPosture) {
    globalStatus.textContent = "Bad Posture!";
    globalStatus.className = "bad";
  } else {
    globalStatus.textContent = "Correct Posture";
    globalStatus.className = "good";
  }

  updateLabel(statusHead, alerts.head);
  updateLabel(statusShoulder, alerts.shoulder);
  updateLabel(statusNeck, alerts.neck);
  updateLabel(statusSlouch, alerts.slouch);
}

function updateLabel(element, isTriggered) {
  if (isTriggered) {
    element.textContent = "ALERT";
    element.className = "bad";
  } else {
    element.textContent = "OK";
    element.className = "good";
  }
}

function resetUI() {
  globalStatus.className = "";
  [statusHead, statusShoulder, statusNeck, statusSlouch].forEach(el => {
    el.textContent = "OK";
    el.className = "";
  });
}