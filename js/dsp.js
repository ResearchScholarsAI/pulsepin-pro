/* PulsePin Pro Ultra DSP – browser version */
function goertzel(samples, sampleRate, freq) {
  const n = samples.length;
  if (n < 64) return { mag: 0, phase: 0, real: 0, imag: 0 };
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const cosine = Math.cos(w);
  const sine = Math.sin(w);
  const coeff = 2 * cosine;
  let q0 = 0, q1 = 0, q2 = 0;
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    const win = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
    q0 = coeff * q1 - q2 + samples[i] * win;
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * sine;
  const scale = n * 0.42;
  return {
    real: real / scale,
    imag: imag / scale,
    mag: Math.hypot(real, imag) / scale,
    phase: Math.atan2(imag, real),
  };
}

function multiGoertzel(samples, sampleRate, centerFreq, bins = 5) {
  let totalReal = 0, totalImag = 0, weightSum = 0;
  const binWidth = sampleRate / samples.length;
  for (let b = -Math.floor(bins / 2); b <= Math.floor(bins / 2); b++) {
    const f = centerFreq + b * binWidth;
    const g = goertzel(samples, sampleRate, f);
    const w = Math.exp(-0.5 * (b / 1.4) ** 2);
    totalReal += g.real * w;
    totalImag += g.imag * w;
    weightSum += w;
  }
  const real = totalReal / weightSum;
  const imag = totalImag / weightSum;
  return {
    real, imag,
    mag: Math.hypot(real, imag),
    phase: Math.atan2(imag, real),
  };
}

class AdvancedLockIn {
  constructor() { this.reset(); }
  reset() {
    this.baselineI = 0;
    this.baselineQ = 0;
    this.primed = false;
    this.peak = 0;
    this.noiseFloor = 0.00025;
    this.history = [];
    this.phaseHistory = [];
    this.lastPhase = 0;
    this.stability = 0;
  }
  ground(i, q, dt, force = false) {
    const tau = force ? 0.09 : 0.42;
    const a = 1 - Math.exp(-dt / tau);
    if (!this.primed) {
      this.baselineI = i; this.baselineQ = q; this.primed = true; return;
    }
    this.baselineI += (i - this.baselineI) * a;
    this.baselineQ += (q - this.baselineQ) * a;
  }
  read(i, q) {
    const di = i - this.baselineI;
    const dq = q - this.baselineQ;
    const mag = Math.hypot(di, dq);
    let phase = Math.atan2(dq, di);
    let dPhase = phase - this.lastPhase;
    if (dPhase > Math.PI) dPhase -= 2 * Math.PI;
    if (dPhase < -Math.PI) dPhase += 2 * Math.PI;
    this.lastPhase = phase;
    this.phaseHistory.push(Math.abs(dPhase));
    if (this.phaseHistory.length > 16) this.phaseHistory.shift();
    const avgJitter = this.phaseHistory.reduce((s, v) => s + v, 0) / Math.max(1, this.phaseHistory.length);
    this.stability = Math.max(0, 1 - avgJitter * 3.5);
    this.history.push(mag);
    if (this.history.length > 64) this.history.shift();
    if (this.history.length >= 16) {
      const sorted = [...this.history].sort((a, b) => a - b);
      this.noiseFloor = sorted[Math.floor(sorted.length * 0.15)] * 1.12;
    }
    this.peak = mag > this.peak ? mag : this.peak * 0.91;
    return { mag, phase, peak: this.peak, noise: this.noiseFloor, stability: this.stability };
  }
}

function classifyMetalPro(phase, mag, noise, disc, stability = 1) {
  const snr = mag / Math.max(noise, 1e-7);
  if (snr < 2.6 || stability < 0.25) return { id: 0, kind: "none", confidence: 0 };
  let deg = ((phase * 180) / Math.PI + 360) % 360;
  const conf = Math.min(1, ((snr - 2.4) / 11) * stability);
  let kind = "unknown", id = 50;
  if (deg < 108 || deg > 322) {
    kind = "fe";
    id = deg > 322 ? Math.round(7 + ((deg - 322) / 38) * 24) : Math.round(10 + (deg / 108) * 30);
    id = Math.max(4, Math.min(40, id));
  } else if (deg > 142 && deg < 278) {
    kind = "nfe";
    const t = (deg - 142) / 136;
    if (t < 0.11) id = 57 + Math.round(t * 55);
    else if (t < 0.26) id = 67 + Math.round((t - 0.11) * 45);
    else if (t < 0.42) id = 75 + Math.round((t - 0.26) * 38);
    else if (t < 0.58) id = 83 + Math.round((t - 0.42) * 28);
    else if (t < 0.78) id = 88 + Math.round((t - 0.58) * 28);
    else id = 94 + Math.round((t - 0.78) * 28);
    id = Math.max(55, Math.min(99, id));
  } else {
    kind = "hotrock";
    id = Math.max(41, Math.min(55, Math.round(41 + (deg - 108) / 3.8)));
  }
  if (disc === "fe-only" && kind !== "fe") return { id: 0, kind: "none", confidence: 0 };
  if (disc === "nfe-only" && kind !== "nfe") return { id: 0, kind: "none", confidence: 0 };
  if (disc === "jewelry" && (kind === "fe" || id < 72)) return { id: 0, kind: "none", confidence: 0 };
  if (disc === "coins" && (kind === "fe" || id < 82)) return { id: 0, kind: "none", confidence: 0 };
  return { id, kind, confidence: conf };
}

function tidLabel(id) {
  if (id <= 0) return "—";
  if (id <= 40) return "آهن / فولاد";
  if (id <= 55) return "سنگ داغ / کانی";
  if (id <= 65) return "فویل / آلومینیوم نازک";
  if (id <= 75) return "نیکل / سکه کوچک";
  if (id <= 82) return "زبانه قوطی";
  if (id <= 88) return "روی / سکه رویی";
  if (id <= 94) return "مس / برنز";
  return "نقره / طلای بالا";
}

function depthFromSignal(signal01, kind) {
  if (signal01 < 0.07 || kind === "none") return null;
  const max = kind === "nfe" ? 9 : kind === "fe" ? 20 : 12;
  const r = max * Math.pow(Math.max(1 - signal01, 0.035), 0.34);
  return Math.round(Math.max(0.4, Math.min(max, r)) * 10) / 10;
}
