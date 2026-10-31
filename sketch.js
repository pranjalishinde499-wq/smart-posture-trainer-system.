/* Smart Posture Trainer Pro++ (sketch.js)
   - p5.js + ml5 PoseNet
   - Fixed template-literal/string bugs, CSV quoting, and minor text formatting issues
*/

let video, poseNet, pose;
let monitoring = false, paused = false;
let lastPosture = "", stableFrames = 0, postureLabel = "—";
let correctCount = 0, wrongCount = 0, lastCorrectTime = 0, correctDuration = 0, sessionStart = 0;
let voiceEnabled = true, soundEnabled = true;
let voiceReady = true, lastSpokenMessage = "", lastVoiceTime = 0;
let sessionLog = []; // {t, posture}

// Chart & confetti state
const accuracyHistory = []; // holds last N accuracy values (0-100)
const HISTORY_LENGTH = 60; // ~last 60 updates
let goodStreak = 0; // seconds with accuracy >= threshold
let confettiTriggered = false;
const CONFETTI_THRESHOLD = 90; // percent
const CONFETTI_STREAK_SECONDS = 10; // must maintain >= threshold for this many seconds

// Audio
let audioCtx = null;

// DOM refs (populated in setup)
let canvasWrapperEl = null;
let chartCanvasEl = null;

function setup() {
    // create canvas and attach to wrapper
    const canvas = createCanvas(640, 480);
    canvas.parent("canvasWrapper");
    canvas.id("poseCanvas");
    canvas.style("display", "block");

    video = createCapture(VIDEO, () => { });
    video.size(width, height);
    video.hide();

    poseNet = ml5.poseNet(video, modelLoaded);
    poseNet.on("pose", gotPoses);

    // DOM refs
    canvasWrapperEl = document.getElementById("canvasWrapper");
    chartCanvasEl = document.getElementById("chartCanvas");

    // UI events
    const startBtn = document.getElementById("startBtn");
    const pauseBtn = document.getElementById("pauseBtn");
    const resetBtn = document.getElementById("resetBtn");
    const exportBtn = document.getElementById("exportBtn");
    const voiceToggle = document.getElementById("voiceToggle");
    const soundToggle = document.getElementById("soundToggle");

    if (startBtn) startBtn.addEventListener("click", startMonitoring);
    if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
    if (resetBtn) resetBtn.addEventListener("click", resetStats);
    if (exportBtn) exportBtn.addEventListener("click", exportCSV);
    if (voiceToggle) voiceToggle.addEventListener("change", (e) => { voiceEnabled = e.target.checked; });
    if (soundToggle) soundToggle.addEventListener("change", (e) => { soundEnabled = e.target.checked; });

    // Add small pointer interactions for camera wrapper: subtle lift on hover
    if (canvasWrapperEl) {
        canvasWrapperEl.addEventListener("mouseenter", () => canvasWrapperEl.classList.add("hover"));
        canvasWrapperEl.addEventListener("mouseleave", () => canvasWrapperEl.classList.remove("hover"));
    }

    // initialize chart
    drawChart();

    updateBadge("Initializing...", "neutral");
    updateLog("Camera ready. Press Start.");

    // small entrance animation after load
    requestAnimationFrame(() => document.body.classList.add("loaded"));
}

// model loaded
function modelLoaded() {
    console.log("PoseNet ready");
    updateBadge("Model loaded", "neutral");
}

// pose callback
function gotPoses(poses) {
    if (poses.length > 0) pose = poses[0].pose;
}

function draw() {
    background(18);
    if (!video) return;

    // mirror camera
    push();
    translate(width, 0);
    scale(-1, 1);
    image(video, 0, 0, width, height);
    pop();

    if (pose) drawKeypoints();

    if (pose && monitoring && !paused) {
        let postureState = detectPosture();
        drawPostureLine(postureState);
        handleUIUpdates(postureState);
    } else if (!pose) {
        fill(255);
        textAlign(CENTER);
        textSize(20);
        text("Move into frame 👀", width / 2, height / 2);
    }
}

/* draw keypoints */
function drawKeypoints() {
    noStroke();
    for (let k of pose.keypoints) {
        if (k.score > 0.2) {
            fill(124, 237, 182, 200);
            // mirror x just like the video mirror used in draw()
            ellipse(width - k.position.x, k.position.y, 8);
        }
    }
}

/* draw posture line */
function drawPostureLine(state) {
    if (!(pose.leftShoulder && pose.rightShoulder && pose.leftHip && pose.rightHip)) return;
    let lS = pose.leftShoulder, rS = pose.rightShoulder, lH = pose.leftHip, rH = pose.rightHip;
    let shoulderCenter = { x: (lS.x + rS.x) / 2, y: (lS.y + rS.y) / 2 };
    let hipCenter = { x: (lH.x + rH.x) / 2, y: (lH.y + rH.y) / 2 };
    let sx = width - shoulderCenter.x, hx = width - hipCenter.x;
    strokeWeight(6);
    stroke(state === "wrong" ? color(255, 110, 110) : color(26, 230, 160));
    line(sx, shoulderCenter.y, hx, hipCenter.y);
}

/* detect posture and handle events */
function detectPosture() {
    if (!pose) return;
    let lS = pose.leftShoulder, rS = pose.rightShoulder, lH = pose.leftHip, rH = pose.rightHip, lK = pose.leftKnee, rK = pose.rightKnee;
    if (!(lS && rS && lH && rH && lK && rK)) return;

    let shoulderCenterY = (lS.y + rS.y) / 2;
    let hipCenterY = (lH.y + rH.y) / 2;
    let kneeCenterY = (lK.y + rK.y) / 2;
    let shoulderCenterX = (lS.x + rS.x) / 2;
    let hipCenterX = (lH.x + rH.x) / 2;

    let isSitting = (kneeCenterY - hipCenterY) < 80;
    let verticalDistance = abs(hipCenterY - shoulderCenterY);
    let horizontalTilt = abs(lS.y - rS.y);
    let forwardBend = abs(shoulderCenterX - hipCenterX);

    let isForwardBend = forwardBend > 80 && verticalDistance < 180;
    let isSideTilt = horizontalTilt > 50;
    let posture = (isForwardBend || isSideTilt) ? "Wrong" : "Correct";

    if (posture !== lastPosture) { stableFrames = 0; lastPosture = posture; } else stableFrames++;

    if (stableFrames > 5) {
        const now = Date.now();
        sessionLog.push({ t: now, posture: posture });

        if (posture === "Wrong") {
            wrongCount++;
            postureLabel = isSitting ? "Sitting: Bend detected — Sit straight" : "Standing: Bend detected — Stand straight";
            if (voiceEnabled) {
                if (isSitting && isForwardBend) speakOnce("Please sit straight and avoid bending forward");
                else if (isSitting && isSideTilt) speakOnce("Please sit upright and avoid leaning sideways");
                else if (!isSitting && isForwardBend) speakOnce("Please stand straight and avoid leaning forward");
                else if (!isSitting && isSideTilt) speakOnce("Please stand straight and keep balance");
            }
            showOverlay(postureLabel, true);
            if (soundEnabled) playWarnSound();
            showEmoji("⚠");
        } else {
            correctCount++;
            postureLabel = isSitting ? "Sitting Straight" : "Standing Straight";
            showOverlay("Good posture — keep it up!", false);
            if (!lastCorrectTime) lastCorrectTime = now;
            correctDuration = (now - lastCorrectTime) / 1000;
            if (voiceEnabled) speakOnce(isSitting ? "Good sitting posture maintained" : "Good standing posture maintained");
            if (soundEnabled) playGoodSound();
            showEmoji("✅");
        }

        return posture === "Wrong" ? "wrong" : "correct";
    }
}

/* UI updates */
function handleUIUpdates(state) {
    const currentPostureEl = document.getElementById("currentPosture");
    const poseModeEl = document.getElementById("poseMode");
    const accuracyTextEl = document.getElementById("accuracyText");
    const fill = document.getElementById("accuracyFill");
    const correctCountEl = document.getElementById("correctCount");
    const wrongCountEl = document.getElementById("wrongCount");
    const durationTextEl = document.getElementById("durationText");
    const sessionTimerEl = document.getElementById("sessionTimer");

    if (currentPostureEl) currentPostureEl.innerText = postureLabel;
    if (poseModeEl) poseModeEl.innerText = "Mode: Live";

    let total = correctCount + wrongCount;
    let accuracy = total > 0 ? (correctCount / total) * 100 : 0;

    // update accuracy history for chart
    pushAccuracy(accuracy);

    if (accuracyTextEl) accuracyTextEl.innerText = accuracy.toFixed(1) + "%";
    if (fill) fill.style.width = Math.min(100, accuracy) + "%";
    if (correctCountEl) correctCountEl.innerText = correctCount;
    if (wrongCountEl) wrongCountEl.innerText = wrongCount;
    if (durationTextEl) durationTextEl.innerText = correctDuration.toFixed(1) + " s";

    if (sessionStart) {
        const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
        if (sessionTimerEl) sessionTimerEl.innerText = formatTime(elapsed);
    }

    if (state === "wrong") updateBadge("Bend detected", "warn");
    else if (state === "correct") updateBadge("Good posture", "good");

    // update camera wrapper glow classes
    setCameraState(state);

    // confetti logic
    if (accuracy >= CONFETTI_THRESHOLD) {
        goodStreak++;
    } else {
        goodStreak = 0;
        confettiTriggered = false;
    }

    if (goodStreak >= CONFETTI_STREAK_SECONDS && !confettiTriggered && accuracy >= CONFETTI_THRESHOLD) {
        confettiTriggered = true;
        triggerConfetti(80);
        updateLog("🎉 Great! Accuracy stable — confetti!");
    }

    // redraw chart
    drawChart();
}

/* set camera wrapper state for visual glow */
function setCameraState(state) {
    if (!canvasWrapperEl) return;
    canvasWrapperEl.classList.remove("correct", "wrong");
    if (state === "wrong") canvasWrapperEl.classList.add("wrong");
    else if (state === "correct") canvasWrapperEl.classList.add("correct");
}

/* accuracy history helpers */
function pushAccuracy(val) {
    accuracyHistory.push(val);
    if (accuracyHistory.length > HISTORY_LENGTH) accuracyHistory.shift();
}

/* draw trend chart on DOM canvas */
function drawChart() {
    const canvas = chartCanvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    // clear
    ctx.clearRect(0, 0, w, h);

    // background subtle
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0, 0, w, h);

    // grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
        const y = (h / 4) * i;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
    }
    ctx.stroke();

    if (accuracyHistory.length === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font = "12px Arial";
        ctx.fillText("Accuracy trend (live)", 12, 18);
        return;
    }

    const maxPoints = HISTORY_LENGTH;
    const stepX = w / (maxPoints - 1 || 1);
    ctx.beginPath();
    for (let i = 0; i < accuracyHistory.length; i++) {
        const val = accuracyHistory[i];
        const x = Math.round(i * stepX);
        const y = h - (val / 100) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#7decb6");
    grad.addColorStop(1, "#6bc3ff");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // fill under line
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
    fillGrad.addColorStop(0, "rgba(123,237,190,0.12)");
    fillGrad.addColorStop(1, "rgba(107,195,255,0.02)");
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // latest dot & text
    const lastVal = accuracyHistory[accuracyHistory.length - 1];
    const lastX = Math.round((accuracyHistory.length - 1) * stepX);
    const lastY = h - (lastVal / 100) * h;
    ctx.beginPath();
    ctx.fillStyle = "#ffffff";
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "12px Arial";
    ctx.fillText("Accuracy trend (live)", 12, 14);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText(lastVal.toFixed(1) + "%", w - 46, 16);
}

/* badge */
function updateBadge(text, kind = "neutral") {
    const b = document.getElementById("statusBadge");
    if (!b) return;
    b.innerText = text;
    b.className = "badge " + (kind === "good" ? "good" : kind === "warn" ? "warn" : "neutral");
}

/* overlay show/hide */
let overlayTimer = null;
function showOverlay(msg, isWarn = false) {
    const overlay = document.getElementById("overlayMessage");
    if (!overlay) return;
    overlay.innerText = msg;
    overlay.style.color = isWarn ? "#ffd6d6" : "#d6fff0";
    overlay.classList.add("show");

    const card = document.getElementById("videoCard");
    if (card) {
        card.style.boxShadow = isWarn ? "0 12px 46px rgba(255,80,80,0.12)" : "0 12px 46px rgba(0,200,150,0.08)";
    }

    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
        overlay.classList.remove("show");
        if (card) card.style.boxShadow = "";
    }, 2200);
}

/* floating emoji reaction */
function showEmoji(emoji) {
    const container = document.getElementById("emojiContainer");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "emoji";
    el.textContent = emoji;
    const w = container.clientWidth || 640;
    const x = Math.floor(w * 0.5 + (Math.random() - 0.5) * 120);
    const y = Math.floor(container.clientHeight * 0.6 + Math.random() * 40);
    el.style.left = x + "px";
    el.style.top = y + "px";
    container.appendChild(el);

    const duration = 1600 + Math.random() * 800;
    const start = performance.now();
    function animate(t) {
        const p = (t - start) / duration;
        if (p >= 1) { el.remove(); return; }
        const translateY = - (p * 120 + Math.sin(p * Math.PI * 2) * 6);
        const scale = 1 + 0.12 * Math.sin(p * Math.PI);
        // use template string to build transform
        el.style.transform = `translateY(${translateY}px) scale(${scale}) rotate(${p * 45}deg)`;
        el.style.opacity = String(1 - p * 1.1);
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

/* confetti trigger */
function triggerConfetti(count = 60) {
    const colors = ["#7decb6", "#6bc3ff", "#ffd36b", "#ff9b9b", "#c98cff"];
    for (let i = 0; i < count; i++) {
        const el = document.createElement("div");
        el.className = "confetti";
        el.style.left = (Math.random() * 100) + "vw";
        el.style.top = (-Math.random() * 40) + "vh";
        el.style.background = colors[Math.floor(Math.random() * colors.length)];
        el.style.transform = `rotate(${Math.random() * 360}deg)`;
        el.style.width = (6 + Math.random() * 8) + "px";
        el.style.height = (8 + Math.random() * 10) + "px";
        el.style.opacity = 1;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1600 + Math.random() * 600);
    }
}

/* voice with cooldown & dedupe */
function speakOnce(msg) {
    const now = Date.now();
    if (!voiceEnabled) return;
    if (!voiceReady && (now - lastVoiceTime < 4000)) return;
    if (msg === lastSpokenMessage && (now - lastVoiceTime < 5000)) return;
    lastVoiceTime = now;
    lastSpokenMessage = msg;
    voiceReady = false;
    const u = new SpeechSynthesisUtterance(msg);
    u.lang = "en-IN";
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    u.onend = () => { voiceReady = true; };
    updateLog(msg);
}

/* small logger */
function updateLog(text) {
    const l = document.getElementById("logArea");
    const dt = new Date().toLocaleTimeString();
    if (l) l.innerText = `[${dt}] ${text}`;
}

/* start monitoring */
function startMonitoring() {
    if (!pose) {
        updateLog("No camera input yet. Move into frame.");
        return;
    }
    if (!monitoring) {
        monitoring = true;
        paused = false;
        sessionStart = Date.now();
        updateBadge("Monitoring", "neutral");
        updateLog("Monitoring started");
        const btn = document.getElementById("startBtn");
        if (btn) btn.setAttribute("disabled", "true");
        ensureAudio();
    }
}

/* pause/resume */
function togglePause() {
    if (!monitoring) return;
    paused = !paused;
    const pb = document.getElementById("pauseBtn");
    if (pb) pb.innerText = paused ? "▶ Resume" : "⏸ Pause";
    updateLog(paused ? "Paused" : "Resumed");
    updateBadge(paused ? "Paused" : "Monitoring", "neutral");
}

/* reset */
function resetStats() {
    correctCount = 0; wrongCount = 0; correctDuration = 0; lastCorrectTime = 0;
    sessionStart = monitoring ? Date.now() : 0;
    sessionLog = [];
    accuracyHistory.splice(0, accuracyHistory.length);
    goodStreak = 0;
    confettiTriggered = false;
    const accuracyTextEl = document.getElementById("accuracyText");
    if (accuracyTextEl) accuracyTextEl.innerText = "0%";
    const fill = document.getElementById("accuracyFill");
    if (fill) fill.style.width = "0%";
    const correctCountEl = document.getElementById("correctCount");
    const wrongCountEl = document.getElementById("wrongCount");
    const durationTextEl = document.getElementById("durationText");
    if (correctCountEl) correctCountEl.innerText = "0";
    if (wrongCountEl) wrongCountEl.innerText = "0";
    if (durationTextEl) durationTextEl.innerText = "0.0 s";
    updateLog("Statistics reset");
    if (soundEnabled) playGoodSound();
    speakOnce("Posture statistics reset");
    drawChart();
}

/* export CSV */
function exportCSV() {
    if (sessionLog.length === 0) {
        updateLog("No session data to export");
        return;
    }
    const rows = [["timestamp", "posture", "local_time"]];
    for (let r of sessionLog) {
        const dt = new Date(r.t);
        rows.push([r.t, r.posture, dt.toLocaleString()]);
    }
    // Proper CSV quoting - wrap in double quotes and escape internal quotes
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `posture_session_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateLog("Session exported as CSV");
}

/* sounds (Web Audio) */
function ensureAudio() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn("AudioContext not available:", e);
        }
    }
}

function playTone(freq, duration = 0.12, type = "sine", volume = 0.06) {
    try {
        ensureAudio();
        if (!audioCtx) return;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.value = volume;
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
        o.stop(audioCtx.currentTime + duration + 0.02);
    } catch (e) {
        console.warn("Audio play failed:", e);
    }
}

function playGoodSound() {
    if (!soundEnabled) return;
    playTone(880, 0.08, "sine", 0.04);
    setTimeout(() => playTone(1320, 0.12, "sine", 0.05), 80);
}

function playWarnSound() {
    if (!soundEnabled) return;
    playTone(260, 0.12, "sawtooth", 0.08);
    setTimeout(() => playTone(200, 0.12, "sawtooth", 0.06), 90);
}

/* util */
function formatTime(totalSeconds) {
    const mm = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const ss = (totalSeconds % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
}