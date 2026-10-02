/* Audio VLF Engine */
class AudioLoopEngine {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.txGain = null;
    this.clickGain = null;
    this.toneGain = null;
    this.toneOsc = null;
    this.analyser = null;
    this.stream = null;
    this.timer = null;
    this.samples = null;
    this.lock = new AdvancedLockIn();
    this.balancing = true;
    this.balanceUntil = 0;
    this.txHz = 5200;
    this.onReading = null;
    this.lastClick = 0;
    this.smooth = 0;
    this.running = false;
    this.feedback = "click";
    this.disc = "all";
  }

  async start({ txHz = 5200, onReading, feedback = "click", disc = "all" }) {
    this.stop();
    this.txHz = txHz;
    this.onReading = onReading;
    this.feedback = feedback;
    this.disc = disc;
    this.lock.reset();
    this.balancing = true;
    this.smooth = 0;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive", sampleRate: 48000 });
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    });

    const mic = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    mic.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);

    this.osc = this.ctx.createOscillator();
    this.osc.type = "sine";
    this.osc.frequency.value = this.txHz;
    this.txGain = this.ctx.createGain();
    this.txGain.gain.value = 0.9;

    const dest = this.ctx.createChannelMerger(2);
    const inv = this.ctx.createGain();
    inv.gain.value = -1;
    this.osc.connect(this.txGain);
    this.txGain.connect(dest, 0, 0);
    this.txGain.connect(inv);
    inv.connect(dest, 0, 1);
    dest.connect(this.ctx.destination);

    const clickOsc = this.ctx.createOscillator();
    clickOsc.type = "square";
    clickOsc.frequency.value = 185;
    this.clickGain = this.ctx.createGain();
    this.clickGain.gain.value = 0;
    clickOsc.connect(this.clickGain);
    this.clickGain.connect(this.ctx.destination);

    this.toneOsc = this.ctx.createOscillator();
    this.toneOsc.type = "sine";
    this.toneOsc.frequency.value = 400;
    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.value = 0;
    this.toneOsc.connect(this.toneGain);
    this.toneGain.connect(this.ctx.destination);

    clickOsc.start();
    this.toneOsc.start();
    this.osc.start();
    this.running = true;
    this.balanceUntil = performance.now() + 1700;
    this.timer = setInterval(() => this.tick(), 28);
  }

  retune(hz) {
    this.txHz = hz;
    if (this.osc && this.ctx) this.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.045);
    this.lock.reset();
    this.balancing = true;
    this.balanceUntil = performance.now() + 1200;
  }

  setDisc(d) { this.disc = d; }
  setFeedback(f) {
    this.feedback = f;
    if (f === "silent" || f === "click") this.setToneLevel(0);
  }
  groundBalance() {
    this.lock.reset();
    this.balancing = true;
    this.balanceUntil = performance.now() + 1500;
  }
  setTxLevel(v) {
    if (this.txGain && this.ctx)
      this.txGain.gain.setTargetAtTime(Math.max(0.1, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }
  setToneLevel(v) {
    if (this.toneGain && this.ctx)
      this.toneGain.gain.setTargetAtTime(Math.max(0, Math.min(0.32, v)), this.ctx.currentTime, 0.035);
  }
  setToneFreq(hz) {
    if (this.toneOsc && this.ctx)
      this.toneOsc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.07);
  }
  playClick(strength) {
    if (!this.clickGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.clickGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(0.15 + strength * 0.4, now + 0.0012);
    g.exponentialRampToValueAtTime(0.0001, now + 0.025);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.osc?.stop(); this.toneOsc?.stop(); } catch (_) {}
    this.osc = this.txGain = this.clickGain = this.toneGain = this.toneOsc = this.analyser = this.samples = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close();
    this.ctx = null;
  }

  tick() {
    if (!this.running || !this.analyser || !this.samples || !this.ctx) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    const g = multiGoertzel(this.samples, this.ctx.sampleRate, this.txHz, 5);
    const now = performance.now();
    const dt = 0.028;

    if (this.balancing || now < this.balanceUntil) {
      this.lock.ground(g.real, g.imag, dt, true);
      if (now >= this.balanceUntil) this.balancing = false;
    } else {
      this.lock.ground(g.real, g.imag, dt * 0.06, false);
    }

    const reading = this.lock.read(g.real, g.imag);
    const coupled = g.mag > 0.0035;
    const coilQuality = Math.min(1, g.mag / 0.017);
    const signal = this.balancing ? 0 : reading.mag;
    this.smooth = this.smooth * 0.55 + signal * 0.45;

    const cls = this.balancing
      ? { id: 0, kind: "none", confidence: 0 }
      : classifyMetalPro(reading.phase, this.smooth, Math.max(reading.noise, 0.00018), this.disc, reading.stability);

    const kind = this.smooth < Math.max(reading.noise, 0.00018) * 2.7 ? "none" : cls.kind;

    this.onReading?.({
      coupled,
      coilQuality,
      phase: reading.phase,
      signal: this.smooth,
      targetId: kind === "none" ? 0 : cls.id,
      kind,
      confidence: kind === "none" ? 0 : cls.confidence,
      txHz: this.txHz,
      stability: reading.stability,
    });

    if (!this.balancing && kind !== "none" && this.feedback !== "silent") {
      const strength = Math.min(1, this.smooth * 48);
      if (this.feedback === "click") {
        const interval = 360 - Math.min(330, this.smooth * 15500);
        if (now - this.lastClick > interval) {
          this.playClick(strength);
          this.lastClick = now;
        }
        this.setToneLevel(0);
      } else if (this.feedback === "tone" || this.feedback === "pitch") {
        const base = 260;
        const span = this.feedback === "pitch" ? 1550 : 580;
        this.setToneFreq(base + strength * span);
        this.setToneLevel(0.07 + strength * 0.24);
      }
    } else {
      this.setToneLevel(0);
    }
  }
}
