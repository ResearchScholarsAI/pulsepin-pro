(() => {
  const $ = (id) => document.getElementById(id);
  const engine = new AudioLoopEngine();
  let running = false;
  let mode = "vlf";
  let sensitivity = 8;
  let volume = 0.88;
  let vibe = true;
  let finds = 0;
  let lastVibe = 0;
  let deferredPrompt = null;

  const ua = navigator.userAgent || "";
  const a03s = /SM-A037|A03s|SM-S134|SM-S135/i.test(ua);
  const badge = $("device-badge");
  badge.textContent = a03s ? "Galaxy A03s" : /Android/i.test(ua) ? "اندروید" : "گوشی";
  if (a03s) badge.classList.add("a03s");

  const meter = $("meter");
  const ticks = [];
  for (let i = 0; i < 21; i++) {
    const a = ((-120 + i * 12) * Math.PI) / 180;
    const inner = i % 5 === 0 ? 60 : 67;
    ticks.push({
      x1: 100 + Math.cos(a) * inner,
      y1: 100 + Math.sin(a) * inner,
      x2: 100 + Math.cos(a) * 78,
      y2: 100 + Math.sin(a) * 78,
      major: i % 5 === 0,
      hot: i >= 16,
      mid: i >= 10,
    });
  }
  meter.innerHTML = `
    <circle cx="100" cy="100" r="95" fill="#0a0d0b" stroke="#2f3833" stroke-width="2.5"/>
    <circle cx="100" cy="100" r="83" fill="#0b0e0c" stroke="#1a201c" stroke-width="1"/>
    ${ticks.map((t) => `<line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}"
      stroke="${t.hot ? "#ff6b5a" : t.mid ? "#6dffb0" : "#4a544e"}"
      stroke-width="${t.major ? 2.2 : 1.1}"/>`).join("")}
    <text x="100" y="152" text-anchor="middle" fill="#5a6560" font-size="9" font-family="IBM Plex Mono">SIGNAL</text>
    <g id="needle" style="transform-origin:100px 100px">
      <polygon points="100,26 95.8,110 104.2,110" fill="#6dffb0"/>
      <circle cx="100" cy="100" r="8" fill="#eef2ef"/>
      <circle cx="100" cy="100" r="3.8" fill="#0a0c0b"/>
    </g>`;
  const needle = $("needle");

  const phaseEl = $("phase-dial");
  phaseEl.innerHTML = `
    <svg viewBox="0 0 100 100" width="90" height="90">
      <circle cx="50" cy="50" r="46" fill="#0c0f0d" stroke="#2a322e" stroke-width="1.5"/>
      <path d="M 50 10 A 40 40 0 0 1 84.64 70" fill="none" stroke="#ff6b5a" stroke-width="4" opacity="0.35"/>
      <path d="M 15.36 70 A 40 40 0 0 1 50 10" fill="none" stroke="#6dffb0" stroke-width="4" opacity="0.35" transform="rotate(140 50 50)"/>
      <g id="phase-needle" style="transform-origin:50px 50px">
        <line x1="50" y1="50" x2="50" y2="14" stroke="#8a948e" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="50" cy="50" r="4" fill="#8a948e"/>
      </g>
      <text x="50" y="68" text-anchor="middle" fill="#8a948e" font-size="9" font-family="IBM Plex Mono">TID</text>
      <text id="phase-tid" x="50" y="82" text-anchor="middle" fill="#8a948e" font-size="14" font-weight="600" font-family="IBM Plex Mono">—</text>
    </svg>`;
  const phaseNeedle = $("phase-needle");
  const phaseTid = $("phase-tid");

  function updateUI(r) {
    const raw = r.signal * 1550;
    const signal = Math.max(0, Math.min(100, raw * (0.42 + sensitivity / 13)));
    const shown = r.kind === "none" ? Math.min(signal, 5) : signal;
    const depth = depthFromSignal(shown / 100, r.kind);
    const conf = Math.round((r.confidence || 0) * 100);

    $("sig").textContent = String(Math.round(shown)).padStart(3, "0");
    $("sig").classList.toggle("hot", shown > 22 && r.kind !== "none");
    $("tid").textContent = r.targetId > 0 ? String(r.targetId).padStart(2, "0") : "—";
    $("depth").textContent = depth == null ? "—" : Math.round(depth);
    $("conf").textContent = conf > 0 ? String(conf) : "—";

    const angle = -120 + (shown / 100) * 240;
    needle.style.transform = `rotate(${angle}deg)`;
    needle.querySelector("polygon").setAttribute("fill", shown > 22 && r.kind !== "none" ? "#ff6b5a" : "#6dffb0");

    const deg = ((r.phase * 180) / Math.PI + 360) % 360;
    phaseNeedle.style.transform = `rotate(${deg}deg)`;
    const color = r.kind === "fe" ? "#ff6b5a" : r.kind === "nfe" ? "#6dffb0" : r.kind === "hotrock" ? "#f0c14a" : "#8a948e";
    phaseNeedle.querySelector("line").setAttribute("stroke", color);
    phaseNeedle.querySelector("circle").setAttribute("fill", color);
    phaseTid.textContent = r.targetId > 0 ? String(r.targetId).padStart(2, "0") : "—";
    phaseTid.setAttribute("fill", color);

    const kindEl = $("kind");
    kindEl.textContent = { none: "—", fe: "آهنی", nfe: "غیرآهنی", hotrock: "سنگ داغ", unknown: "فلز" }[r.kind] || "—";
    kindEl.className = "target-value " + (r.kind || "none");
    $("kind-sub").textContent = r.targetId > 0 ? tidLabel(r.targetId) : "منتظر هدف…";
    $("tx").textContent = `TX ${r.txHz} Hz`;
    const st = $("coil-status");
    if (!running) st.textContent = "آماده";
    else if (!r.coupled) { st.textContent = "حلقه نیست"; st.className = ""; }
    else if (r.coilQuality < 0.22) { st.textContent = "حلقه ضعیف"; st.className = ""; }
    else { st.textContent = `حلقه ${Math.round(r.coilQuality * 100)}%`; st.className = "ok"; }

    if (vibe && shown > 10 && r.kind !== "none") {
      const now = performance.now();
      const gap = 400 - Math.min(350, shown * 3.4);
      if (now - lastVibe > gap) {
        lastVibe = now;
        try { navigator.vibrate?.(shown > 60 ? [55, 25, 55] : [30]); } catch (_) {}
      }
    }

    if (r.kind !== "none" && shown > 18 && (r.confidence || 0) > 0.35) {
      finds++;
      $("finds").textContent = finds;
    }
  }

  async function arm() {
    $("error").classList.add("hidden");
    $("warn").classList.add("hidden");
    try {
      await engine.start({
        txHz: 5200,
        feedback: $("audio").checked ? $("feedback").value : "silent",
        disc: $("disc").value,
        onReading: updateUI,
      });
      engine.setTxLevel(volume);
      running = true;
      $("arm-btn").textContent = "توقف";
      $("arm-btn").classList.add("danger");
      $("arm-btn").classList.remove("primary");
      $("gb-btn").disabled = false;
    } catch (err) {
      const msg = err?.message || "خطای حسگر";
      const mic = /NotAllowed|Permission|Denied/i.test(msg);
      $("error").textContent = mic
        ? "دسترسی میکروفون لازم است — سیگنال برگشتی حلقه از پین میکروفون جک ۳.۵ خوانده می‌شود."
        : msg;
      $("error").classList.remove("hidden");
    }
  }

  function disarm() {
    engine.stop();
    running = false;
    $("arm-btn").textContent = "مسلح کردن";
    $("arm-btn").classList.remove("danger");
    $("arm-btn").classList.add("primary");
    $("gb-btn").disabled = true;
    $("sig").textContent = "000";
    $("tid").textContent = "—";
    $("depth").textContent = "—";
    $("conf").textContent = "—";
    $("kind").textContent = "—";
    $("kind-sub").textContent = "منتظر هدف…";
    $("coil-status").textContent = "آماده";
    needle.style.transform = "rotate(-120deg)";
    try { navigator.vibrate?.(0); } catch (_) {}
  }

  $("arm-btn").onclick = () => (running ? disarm() : arm());
  $("gb-btn").onclick = () => engine.groundBalance();

  document.querySelectorAll(".mode").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".mode").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mode = btn.dataset.mode;
      if (mode === "mag") {
        $("warn").textContent = a03s
          ? "A03s مغناطیس‌سنج ندارد. از حالت VLF یا پین‌پوینت با حلقه استفاده کنید."
          : "حالت مغناطیس فقط روی گوشی‌های دارای Magnetometer کار می‌کند.";
        $("warn").classList.remove("hidden");
      } else $("warn").classList.add("hidden");
    };
  });

  $("disc").onchange = () => engine.setDisc($("disc").value);
  $("feedback").onchange = () => {
    if (running) engine.setFeedback($("audio").checked ? $("feedback").value : "silent");
  };
  $("sens").oninput = () => {
    sensitivity = +$("sens").value;
    $("sens-val").textContent = sensitivity;
  };
  $("vol").oninput = () => {
    volume = +$("vol").value / 100;
    $("vol-val").textContent = Math.round(volume * 100) + "%";
    if (running) engine.setTxLevel(volume);
  };
  $("vibe").onchange = () => (vibe = $("vibe").checked);
  $("audio").onchange = () => {
    if (running) engine.setFeedback($("audio").checked ? $("feedback").value : "silent");
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("install-btn").classList.remove("hidden");
  });
  $("install-btn").onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("install-btn").classList.add("hidden");
  };
})();
