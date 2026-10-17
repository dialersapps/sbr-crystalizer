/*!
 * sbr-crystalizer.js 1.0.0 - artificially restore the missing top end of low-quality voice recordings.
 *
 * Spectral band replication (SBR) in plain JavaScript: finds where a recording's real content ends, then
 * synthesises a speech-shaped high band above that point. No dependencies, no WebAssembly, no DOM: pure
 * Float32Array DSP that runs in a page, a Web Worker, an Android WebView or Node.
 *
 * Copyright (c) 2026 Dialer's Apps
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * What it does, per clip:
 *   1. finds where the real content ends (the "cutoff": the steepest cliff in the clip's average spectrum, or a
 *      manual frequency); for stereo the spectra of all channels are pooled so both share one cutoff;
 *   2. per frame, measures the level just under the cutoff and extends it upward with a speech-like downward
 *      tilt, shaped by the texture of the band just below the cutoff and given deterministic noise phases
 *      (which is what fricatives and breath are), with a speech-spectrum floor that keeps the top present
 *      when a codec left it hollow;
 *   3. gates the new top end by frame energy so silence and room noise are not turned into hiss.
 * Everything at or below the cutoff passes through untouched (a transparent STFT: sqrt-Hann analysis and
 * synthesis windows at 75 % overlap). The output is deterministic: the "noise" is a hash of (frame, bin).
 * This is a perceptual enhancer for speech, not a reconstruction: it adds plausible top end, it cannot recover
 * the information a recording has lost.
 *
 * API: sbrCrystalizer.process(channels, sampleRate, options?, hooks?) -> Promise<{ applied, channels, sampleRate, info }>
 */
'use strict';
/** Default options. */
const DEFAULTS = Object.freeze({
  strength: 0.85,        // HF_STRENGTH: level of the rebuilt band (1 = same level as just under the cutoff)
  tilt: 11,              // TILT_DB_PER_OCT: how fast the rebuilt band falls off
  cutoffMode: 'auto',    // 'auto' (cliff detection) | 'manual'
  cutoffHz: 4000,        // used when cutoffMode === 'manual'
  cliffDb: 15,           // CLIFF_DB: how steep (dB drop over ~375 Hz) a roll-off must be to count as the cutoff
  floor: 0.5,            // MODEL_FLOOR: long-term speech spectrum floor amount
  floorSlope: 9,         // MODEL_DB_PER_OCT: slope of that floor above 2 kHz
  taperEndHz: 14900,     // HF_TAPER_END_HZ: nothing rebuilt above this (taper starts at 86 % of it)
  gateEnabled: true,
  gateThreshold: 6,      // multiplier of the quiet-frame energy floor where the gate starts to open
  texture: 1             // 0 = flat noise band, 1 = shaped by the harmonic texture just below the cutoff
});

/** [min, max, step] for every numeric option (UI sliders and sanitising share these). */
const LIMITS = Object.freeze({
  strength: [0, 1.5, 0.05],
  tilt: [3, 24, 0.5],
  cutoffHz: [3000, 16000, 100],
  cliffDb: [6, 30, 1],
  floor: [0, 1, 0.05],
  floorSlope: [3, 18, 0.5],
  taperEndHz: [8000, 20000, 100],
  gateThreshold: [2, 20, 0.5],
  texture: [0, 1, 0.05]
});

const TAPER_START_RATIO = 12800 / 14900;
const MIN_CUTOFF_HZ = 3000;
const YIELD_EVERY = 96;

function clampNum(value, key) {
  const [lo, hi] = LIMITS[key];
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
}

/** Fill in defaults and clamp everything; safe to call with undefined or stored JSON. */
function normalizeOptions(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(LIMITS)) out[key] = clampNum(s[key], key);
  out.cutoffMode = s.cutoffMode === 'manual' ? 'manual' : 'auto';
  out.gateEnabled = s.gateEnabled !== false;
  return out;
}

// ---- radix-2 complex FFT (in place), plans cached per size ----
const FFT_CACHE = {};
function fftPlan(n) {
  if (FFT_CACHE[n]) return FFT_CACHE[n];
  const levels = Math.log2(n) | 0, rev = new Uint16Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return (FFT_CACHE[n] = { n, rev, cos, sin });
}
function fft(re, im, inverse) {
  const { n, rev, cos, sin } = fftPlan(re.length);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k], wi = sgn * sin[k], a = i + j, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
const WINDOWS = {};
function getWindow(n) {
  if (WINDOWS[n]) return WINDOWS[n];
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  return (WINDOWS[n] = w);
}

// Deterministic per-(frame,bin) noise phase, so the same clip always renders identically.
function phaseNoise(frame, bin) {
  let x = (frame * 73856093) ^ (bin * 19349663) ^ 0x9e3779b9;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return ((x >>> 0) / 4294967296) * 2 * Math.PI;
}
const defaultYield = () => new Promise((r) => setTimeout(r, 0));

/** STFT size for a sample rate (about 23-47 Hz bins). */
function frameSize(sr) {
  return sr <= 26000 ? (sr <= 18000 ? 512 : 1024) : sr <= 40000 ? 1024 : 2048;
}

/**
 * @param {Float32Array[]} channels equal-length channel data (not modified)
 * @param {number} sampleRate 8000..48000 Hz (anything else is passed through untouched)
 * @param {object} [options] see DEFAULTS (`enabled` is ignored here), plus
 *   `doubleRate` (boolean, default false): output at 2x the rate for input <= 24 kHz
 * @param {{ yieldFn?: () => Promise<void>, signal?: { aborted?: boolean } }} [hooks]
 * @returns {Promise<{ applied: boolean, channels: Float32Array[], sampleRate: number, info: object }>}
 *   when `applied` is false, `channels` are the input arrays themselves.
 */
async function processChannels(channels, sampleRate, options = {}, hooks = {}) {
  const o = { ...normalizeOptions(options), doubleRate: options.doubleRate === true };
  const yieldFn = hooks.yieldFn || defaultYield;
  const pass = (reason, extra = {}) => ({ applied: false, channels, sampleRate, info: { applied: false, reason, ...extra } });
  const sr = Number(sampleRate);
  if (!Array.isArray(channels) || !channels.length) return pass('empty');
  if (!(sr >= 8000 && sr <= 48000)) return pass('rate');
  const len = channels[0].length;
  const up = o.doubleRate && sr <= 24000 ? 2 : 1;
  const N_IN = frameSize(sr);
  const HOP = N_IN / 4, N_OUT = N_IN * up, BINS = N_IN / 2, HI_BINS = N_OUT / 2;
  const binHz = sr / N_IN, hz = (v) => Math.max(1, Math.round(v / binHz));
  if (len < N_IN * 2) return pass('short');
  const nFrames = Math.ceil((len + N_IN) / HOP);
  const winIn = getWindow(N_IN), winOut = getWindow(N_OUT);
  const re = new Float64Array(N_IN), im = new Float64Array(N_IN);
  const startOf = (f) => f * HOP - (N_IN - HOP);
  const spectrum = (x, start) => {
    for (let i = 0; i < N_IN; i++) { const idx = start + i; re[i] = (idx >= 0 && idx < len ? x[idx] : 0) * winIn[i]; im[i] = 0; }
    fft(re, im, false);
  };
  const check = () => { if (hooks.signal?.aborted) { const e = new Error('Cancelled'); e.name = 'AbortError'; throw e; } };

  const minCut = hz(MIN_CUTOFF_HZ), maxCut = Math.floor(BINS * 0.985), e0 = hz(1500), e1 = hz(3000);

  // ---- pass 1: clip-level average spectrum (pooled over channels, every 4th frame) and per-frame energy per channel ----
  const avg = new Float64Array(BINS + 1), frameEs = [];
  let used = 0, sumSq = 0;
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    const hopE = new Float64Array(Math.ceil(len / HOP) + 1);
    for (let i = 0; i < len; i++) { const v = x[i]; hopE[(i / HOP) | 0] += v * v; sumSq += v * v; }
    const frameE = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let e = 0; const h0 = Math.floor(startOf(f) / HOP);
      for (let h = h0; h < h0 + 4; h++) if (h >= 0 && h < hopE.length) e += hopE[h];
      frameE[f] = e;
      if (f % 4 === 0) {
        spectrum(x, startOf(f));
        for (let k = 0; k <= BINS; k++) avg[k] += Math.hypot(re[k], im[k]);
        used++;
        if (used % 24 === 0) { await yieldFn(); check(); }
      }
    }
    frameEs.push(frameE);
  }
  const rms = Math.sqrt(sumSq / (len * channels.length));
  const avgDb = new Float64Array(BINS + 1);
  for (let k = 0; k <= BINS; k++) avgDb[k] = 20 * Math.log10(avg[k] / Math.max(1, used) + 1e-9);
  const sw = hz(94);
  const sm = (k) => { let s = 0, c = 0; for (let d = -sw; d <= sw; d++) { const i = k + d; if (i >= 0 && i <= BINS) { s += avgDb[i]; c++; } } return s / c; };
  let sig = 0; for (let k = e0; k < e1; k++) sig += sm(k); sig /= Math.max(1, e1 - e0);
  let top = 0, tc = 0; for (let k = BINS - hz(500); k < BINS - hz(60); k++) { top += sm(k); tc++; } top /= Math.max(1, tc);
  // Level-independent "this is just noise / silence" test: the level is referenced to a -20 dBFS RMS, so it behaves
  // the same for quiet and loud input.
  const sigRef = sig + (rms > 1e-5 ? 20 * Math.log10(0.1 / rms) : -200);
  const noSpeech = sig - top < 12 && sigRef < -20;

  // cutoff = manual, or the lowest steep cliff in the average spectrum (centred on its steepest point), else the top of the band
  const win12 = hz(375), scanMax = BINS - hz(440);
  const dropAt = (k) => { let below = 0, above = 0; for (let d = 1; d <= win12; d++) { below += sm(k - d); above += sm(k + d); } return (below - above) / win12; };
  let kc = maxCut, bestK = -1, bestDrop = 0;
  if (o.cutoffMode === 'manual') {
    kc = hz(o.cutoffHz);
  } else {
    for (let k = minCut; k <= scanMax; k++) {
      if (dropAt(k) >= o.cliffDb) {
        bestK = k; bestDrop = dropAt(k);
        for (let j = k + 1; j <= Math.min(scanMax, k + hz(500)); j++) { const d = dropAt(j); if (d > bestDrop) { bestDrop = d; bestK = j; } }
        break;
      }
    }
    if (bestK > 0) kc = bestK - hz(250);                // stay below the transition band
  }
  kc = Math.max(minCut, Math.min(maxCut, kc));
  const cutoffHz = Math.round(kc * binHz);
  const effStrength = noSpeech ? 0 : o.strength;
  const noCliff = o.cutoffMode === 'auto' && bestK < 0;
  const info = {
    applied: true, reason: 'ok', sampleRate: sr, outSampleRate: sr * up, channels: channels.length,
    cutoffMode: o.cutoffMode, cutoffHz, cliffFound: bestK > 0, cliffDropDb: bestDrop, noSpeech, noCliff,
    strength: effStrength, requestedStrength: o.strength, tilt: o.tilt, frameSize: N_IN
  };
  if (effStrength <= 0 || kc >= maxCut) {
    // nothing to rebuild (no speech, no band-limit, or strength 0): hand the input back untouched
    return { applied: false, channels, sampleRate: sr, info: { ...info, applied: false, reason: noSpeech ? 'nospeech' : noCliff ? 'nocliff' : 'zero' } };
  }

  const ks1 = kc - hz(60), ks0 = Math.max(hz(1000), kc - hz(3000)), srcSpan = ks1 - ks0 + 1;
  const taperEnd = Math.floor(o.taperEndHz / binHz), taperStart = Math.floor((o.taperEndHz * TAPER_START_RATIO) / binHz);
  const hiLimit = Math.min(HI_BINS, taperEnd), lvlSpan = hz(280), rampBins = hz(250), tw = hz(94), scale = 0.5 / N_IN;
  const outLen = len * up;

  // ---- pass 2: synthesis, per channel ----
  const outs = [];
  const zr = new Float64Array(N_OUT), zi = new Float64Array(N_OUT), mag = new Float64Array(BINS + 1), smooth = new Float64Array(BINS + 1);
  let counter = 0;
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c], frameE = frameEs[c], out = new Float32Array(outLen);
    const sorted = Array.from(frameE).sort((a, b) => a - b);
    const floorE = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.15)]);
    const gate = (e) => {
      if (!o.gateEnabled) return 1;
      const t = (e / (floorE * o.gateThreshold) - 1) / 3;
      return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    };
    let levelPrev = 0, midPrev = 0;
    for (let f = 0; f < nFrames; f++) {
      spectrum(x, startOf(f));
      for (let k = 0; k <= BINS; k++) mag[k] = Math.hypot(re[k], im[k]);
      zr.fill(0); zi.fill(0);
      for (let k = 0; k < BINS; k++) { zr[k] = re[k]; zi[k] = im[k]; }        // the real spectrum passes through untouched
      for (let k = ks0; k <= ks1; k++) { let s = 0, n = 0; for (let d = -tw; d <= tw; d++) { const i = k + d; if (i >= ks0 && i <= ks1) { s += mag[i]; n++; } } smooth[k] = s / n; }
      let lvl = 0; for (let k = ks1 - lvlSpan; k <= ks1; k++) lvl += mag[k]; lvl /= lvlSpan + 1;
      let mid = 0; for (let k = e0; k < e1; k++) mid += mag[k]; mid /= Math.max(1, e1 - e0);
      let srcMean = 0; for (let k = ks0; k <= ks1; k++) srcMean += smooth[k]; srcMean = srcMean / srcSpan + 1e-12;
      levelPrev = f === 0 ? lvl : 0.55 * levelPrev + 0.45 * lvl;
      midPrev = f === 0 ? mid : 0.55 * midPrev + 0.45 * mid;
      const g = gate(frameE[f]) * effStrength;
      if (g > 0 && (levelPrev > 0 || midPrev > 0)) {
        for (let k = kc; k < hiLimit; k++) {
          const fHz = (k + 0.5) * binHz, oct = Math.log2((k + 0.5) / (kc + 0.5));
          const measured = levelPrev * Math.pow(10, (-o.tilt * oct) / 20);
          const model = midPrev * o.floor * Math.pow(10, (-o.floorSlope * Math.log2(fHz / 2250)) / 20);
          let a = Math.max(measured, model) * g * Math.min(1, (k - kc + 1) / rampBins);
          if (k > taperStart) a *= 0.5 + 0.5 * Math.cos((Math.PI * (k - taperStart)) / Math.max(1, taperEnd - taperStart));
          const tex = 0.4 + 0.6 * Math.max(0.4, Math.min(2.2, smooth[ks0 + ((k - kc) % srcSpan + srcSpan) % srcSpan] / srcMean));
          a *= 1 + o.texture * (tex - 1);
          const ph = phaseNoise(f, k);
          zr[k] += a * Math.cos(ph); zi[k] += a * Math.sin(ph);
        }
      }
      for (let k = 1; k < HI_BINS; k++) { zr[N_OUT - k] = zr[k]; zi[N_OUT - k] = -zi[k]; }   // Hermitian mirror
      zi[0] = 0; zi[HI_BINS] = 0;
      fft(zr, zi, true);
      const base = startOf(f) * up;
      for (let m = 0; m < N_OUT; m++) { const idx = base + m; if (idx >= 0 && idx < outLen) out[idx] += zr[m] * winOut[m] * scale; }
      if (++counter % YIELD_EVERY === 0) { await yieldFn(); check(); }
    }
    outs.push(out);
  }
  return { applied: true, channels: outs, sampleRate: sr * up, info };
}
export const version = '1.0.0';
export { processChannels as process, DEFAULTS as defaults, LIMITS as limits, normalizeOptions };
export default { version, process: processChannels, defaults: DEFAULTS, limits: LIMITS, normalizeOptions };
