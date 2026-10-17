// Reproducible measurements and figures for sbr-crystalizer.js.
//   node tools/measure.mjs        -> writes docs/results.json, docs/spectrograms-48k.svg, docs/spectrograms-16k.svg,
//                                    docs/avg-spectrum-48k.svg and prints a summary.
// The test voice is SYNTHETIC (a glottal source through formant filters plus fricative noise), generated here with a
// fixed seed, so every number below can be reproduced. It is not a substitute for listening to real recordings.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sbr from '../sbr-crystalizer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
fs.mkdirSync(docs, { recursive: true });

// ---------- small helpers ----------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function biquad(type, fs_, f0, q) {
  const w = (2 * Math.PI * f0) / fs_, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const a0 = 1 + al;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
function runBiquad(x, f) { const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
const BUTTER8_Q = [0.5098, 0.6013, 0.9, 2.5629];
function lowpass8(x, sr, fc) { let y = x; for (const q of BUTTER8_Q) y = runBiquad(y, biquad('lp', sr, fc, q)); return y; }
function decimate(x, k) { const y = new Float32Array(Math.floor(x.length / k)); for (let i = 0; i < y.length; i++) y[i] = x[i * k]; return y; }

// ---------- synthetic voice (deterministic) ----------
function synthVoice(sr, seconds) {
  const rnd = mulberry32(20261016), n = Math.floor(sr * seconds), out = new Float32Array(n);
  const vowels = [[700, 1220, 2600], [300, 2300, 3000], [350, 800, 2400], [500, 1800, 2500], [450, 800, 2830]];
  let t0 = Math.floor(0.25 * sr), v = 0;
  while (t0 < n - sr * 0.4) {
    const dur = Math.floor(sr * (0.18 + rnd() * 0.22)), fric = rnd() < 0.55 ? Math.floor(sr * (0.07 + rnd() * 0.08)) : 0;
    const form = vowels[v++ % vowels.length], f0a = 105 + rnd() * 45, f0b = f0a * (0.85 + rnd() * 0.3);
    // fricative burst: band-passed noise 3..11 kHz with a smooth envelope
    if (fric) {
      const noise = new Float32Array(fric); for (let i = 0; i < fric; i++) noise[i] = rnd() * 2 - 1;
      const bp = runBiquad(runBiquad(noise, biquad('hp', sr, 3500, 0.707)), biquad('lp', sr, 11000, 0.707));
      for (let i = 0; i < fric; i++) { const e = Math.sin((Math.PI * i) / fric); out[t0 + i] += bp[i] * e * e * 0.35; }
      t0 += fric;
    }
    // voiced part: glottal pulse train through a leaky integrator (about -6 dB/oct), formants, vibrato
    const src = new Float32Array(dur); let phase = 0, lp = 0;
    for (let i = 0; i < dur; i++) {
      const f0 = f0a + (f0b - f0a) * (i / dur) + 3 * Math.sin((2 * Math.PI * 5.2 * i) / sr);
      phase += f0 / sr; let pulse = 0; if (phase >= 1) { phase -= 1; pulse = 1; }
      lp = 0.97 * lp + pulse; src[i] = lp * 0.6 + (rnd() * 2 - 1) * 0.02;
    }
    let y = new Float32Array(dur);
    for (const [fc, gain] of [[form[0], 1], [form[1], 0.7], [form[2], 0.45], [3500, 0.25], [4500, 0.15], [6000, 0.07]]) {
      const bpn = runBiquad(src, biquad('bp', sr, fc, 7)); for (let i = 0; i < dur; i++) y[i] += bpn[i] * gain;
    }
    for (let i = 0; i < dur; i++) { const e = Math.sin((Math.PI * i) / dur); out[t0 + i] += y[i] * Math.sqrt(e) * 1.4; }
    t0 += dur + Math.floor(sr * (0.05 + rnd() * 0.12));
  }
  for (let i = 0; i < n; i++) out[i] += (rnd() * 2 - 1) * 0.0007;      // quiet room floor
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] *= 0.5 / pk;
  return out;
}

// ---------- analysis ----------
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
function stft(x, N = 1024, hop = 512) {
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = [], re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    const mag = new Float64Array(N / 2 + 1); let e = 0;
    for (let k = 0; k <= N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]) / N; e += mag[k] * mag[k]; }
    frames.push({ mag, e });
  }
  return frames;
}
const db = (v) => 20 * Math.log10(v + 1e-9);
function bandLevelDb(frames, sr, N, f0, f1, active) {
  const k0 = Math.round((f0 * N) / sr), k1 = Math.round((f1 * N) / sr); let s = 0, c = 0;
  frames.forEach((f, i) => { if (!active[i]) return; let m = 0; for (let k = k0; k <= k1; k++) m += f.mag[k] * f.mag[k]; s += m / (k1 - k0 + 1); c++; });
  return 10 * Math.log10(s / Math.max(1, c) + 1e-18);
}
function lsd(refF, tstF, sr, N, f0, f1, active) {
  const k0 = Math.round((f0 * N) / sr), k1 = Math.round((f1 * N) / sr); let tot = 0, c = 0;
  refF.forEach((f, i) => { if (!active[i]) return; let s = 0; for (let k = k0; k <= k1; k++) { const d = db(f.mag[k]) - db(tstF[i].mag[k]); s += d * d; } tot += Math.sqrt(s / (k1 - k0 + 1)); c++; });
  return tot / Math.max(1, c);
}
function activeFrames(frames) { const es = frames.map((f) => f.e).sort((a, b) => a - b); const thr = es[Math.floor(es.length * 0.4)]; return frames.map((f) => f.e > thr); }
function belowDiff(aF, bF, sr, N, fmax, active) {
  const k1 = Math.round((fmax * N) / sr); let tot = 0, c = 0;
  aF.forEach((f, i) => { if (!active[i]) return; for (let k = 2; k <= k1; k++) { if (f.mag[k] < 1e-6) continue; tot += Math.abs(db(f.mag[k]) - db(bF[i].mag[k])); c++; } });
  return tot / Math.max(1, c);
}
function avgSpectrumDb(x, sr, N = 1024, points = 160) {
  const fr = stft(x, N, 512), avg = new Float64Array(N / 2 + 1);
  for (const f of fr) for (let k = 0; k <= N / 2; k++) avg[k] += f.mag[k] * f.mag[k];
  const out = []; for (let p = 0; p < points; p++) { const k0 = Math.floor((p * (N / 2)) / points), k1 = Math.max(k0 + 1, Math.floor(((p + 1) * (N / 2)) / points)); let s = 0; for (let k = k0; k < k1; k++) s += avg[k]; out.push([((k0 + k1) / 2 / (N / 2)) * (sr / 2), 10 * Math.log10(s / (k1 - k0) / fr.length + 1e-18)]); }
  return out;
}

function brick(x, sr, fc) {   // ideal low-pass by zeroing FFT bins above fc (models a codec / resampler cutoff)
  let N = 1; while (N < x.length) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < x.length; i++) re[i] = x[i];
  fftInPlace(re, im);
  const kc = Math.floor((fc * N) / sr);
  for (let k = kc + 1; k <= N - kc - 1; k++) { re[k] = 0; im[k] = 0; }
  fftInPlace(im, re);                                   // inverse via swapped real/imag
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = re[i] / N;
  return y;
}
// ---------- PNG + colour map ----------
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
const STOPS = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function color(t) { t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1); const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i; return STOPS[i].map((v, j) => Math.round(v + (STOPS[i + 1][j] - v) * f)); }
function spectrogramPng(x, sr, maxDb, rangeDb, fMax) {
  const N = 1024, fr = stft(x, N, 1024), w = fr.length, kMax = Math.floor((fMax * N) / sr), h = Math.floor(kMax / 4), rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w; i++) for (let y = 0; y < h; y++) {
    const k = kMax - 1 - y * 4; const m = Math.max(fr[i].mag[k], fr[i].mag[k - 1] || 0, fr[i].mag[k - 2] || 0, fr[i].mag[k - 3] || 0); const c = color((db(m) - (maxDb - rangeDb)) / rangeDb);
    const o = (y * w + i) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
  return { png: encodePng(w, h, rgb), w, h, frames: fr };
}
function maxFrameDb(x, N = 1024) { let m = 0; for (const f of stft(x, N, 512)) for (let k = 0; k < f.mag.length; k++) m = Math.max(m, f.mag[k]); return db(m); }

// ---------- SVG figures ----------
const SVG_STYLE = '<style>text{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;fill:#e6ecf5}.dim{fill:#9fb4cc}</style>';
function spectrogramFigure(file, title, desc, panels, sr, fMax, seconds) {
  const W = 760, left = 70, pw = 660, ph = 150, gap = 38, top = 66, H = top + panels.length * (ph + gap) + 30;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d"><title id="t">${title}</title><desc id="d">${desc}</desc>${SVG_STYLE}<rect width="100%" height="100%" rx="10" fill="#0b0f14" stroke="#24364a"/><text x="20" y="26" font-size="14" font-weight="600">${title}</text>`;
  panels.forEach((p, i) => {
    const y = top + i * (ph + gap);
    s += `<text x="${left}" y="${y - 8}" font-size="12" font-weight="600">${p.label}</text><image x="${left}" y="${y}" width="${pw}" height="${ph}" preserveAspectRatio="none" href="data:image/png;base64,${p.png.toString('base64')}"/><rect x="${left}" y="${y}" width="${pw}" height="${ph}" fill="none" stroke="#3b5a7c"/>`;
    for (let f = 0; f <= fMax; f += (fMax >= 16000 ? 4000 : 2000)) { const yy = y + ph - (f / fMax) * ph; s += `<line x1="${left - 4}" y1="${yy}" x2="${left}" y2="${yy}" stroke="#7fa6cf"/><text class="dim" x="${left - 8}" y="${yy + 4}" font-size="10.5" text-anchor="end">${f / 1000}k</text>`; }
    if (p.cutoff) { const yy = y + ph - (p.cutoff / fMax) * ph; s += `<line x1="${left}" y1="${yy}" x2="${left + pw}" y2="${yy}" stroke="#4da3ff" stroke-dasharray="5 4"/><text x="${left + pw - 6}" y="${yy - 5}" font-size="10.5" text-anchor="end" style="fill:#7fb8ff">detected cutoff ${Math.round(p.cutoff / 100) / 10} kHz</text>`; }
  });
  const yb = top + panels.length * (ph + gap) - gap + 18;
  for (let t = 0; t <= seconds; t += 1) { const x = left + (t / seconds) * pw; s += `<line x1="${x}" y1="${yb - 14}" x2="${x}" y2="${yb - 10}" stroke="#7fa6cf"/><text class="dim" x="${x}" y="${yb + 2}" font-size="10.5" text-anchor="middle">${t}s</text>`; }
  fs.writeFileSync(path.join(docs, file), s + '</svg>');
}
function avgFigure(file, lines, cutoff, fMax) {
  const W = 760, H = 330, L = 64, R = 20, T = 40, B = 46, pw = W - L - R, ph = H - T - B, yMin = -110, yMax = -30;
  const X = (f) => L + (f / fMax) * pw, Y = (v) => T + ph - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * ph;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d"><title id="t">Long-term average spectrum before and after</title><desc id="d">Three curves: the wideband original, the same clip low-passed at 8 kHz, and the low-passed clip after sbr-crystalizer.js, which restores energy above the cutoff.</desc>${SVG_STYLE}<rect width="100%" height="100%" rx="10" fill="#0b0f14" stroke="#24364a"/><text x="20" y="26" font-size="14" font-weight="600">Long-term average spectrum (48 kHz, synthetic voice)</text>`;
  for (let v = yMin; v <= yMax; v += 20) s += `<line x1="${L}" y1="${Y(v)}" x2="${L + pw}" y2="${Y(v)}" stroke="#1d2b3b"/><text class="dim" x="${L - 8}" y="${Y(v) + 4}" font-size="10.5" text-anchor="end">${v} dB</text>`;
  for (let f = 0; f <= fMax; f += 4000) s += `<line x1="${X(f)}" y1="${T}" x2="${X(f)}" y2="${T + ph}" stroke="#1d2b3b"/><text class="dim" x="${X(f)}" y="${T + ph + 18}" font-size="10.5" text-anchor="middle">${f / 1000} kHz</text>`;
  s += `<line x1="${X(cutoff)}" y1="${T}" x2="${X(cutoff)}" y2="${T + ph}" stroke="#4da3ff" stroke-dasharray="5 4"/><text x="${X(cutoff) + 6}" y="${T + 14}" font-size="11" style="fill:#7fb8ff">cutoff found: ${Math.round(cutoff / 100) / 10} kHz</text>`;
  const cols = ['#8fa3b8', '#e0675a', '#4da3ff']; let ly = H - 14;
  lines.forEach((l, i) => { s += `<polyline fill="none" stroke="${cols[i]}" stroke-width="2" points="${l.pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}"/>`; });
  lines.forEach((l, i) => { const x = L + i * 215; s += `<rect x="${x}" y="${ly - 9}" width="14" height="4" fill="${cols[i]}"/><text x="${x + 20}" y="${ly - 3}" font-size="11">${l.label}</text>`; });
  fs.writeFileSync(path.join(docs, file), s + '</svg>');
}

// ---------- experiments ----------
const results = { generated: 'synthetic voice, seed 20261016', cases: {} };
const SEC = 8, ORIG_SR = 48000;
const orig48 = synthVoice(ORIG_SR, SEC);

// Case A: 48 kHz, low-passed at 8 kHz
{
  const deg = brick(orig48, 48000, 8000);
  const r = await sbr.process([deg], 48000, {});
  const proc = r.channels[0], N = 1024, fo = stft(orig48, N), fd = stft(deg, N), fp = stft(proc, N), act = activeFrames(fo);
  results.cases.hz48k_lp8k = {
    applied: r.applied, detectedCutoffHz: r.info.cutoffHz, trueCutoffHz: 8000, rebuiltTopHz: 14900,
    bandDb: { original: bandLevelDb(fo, 48000, N, 9000, 14000, act), degraded: bandLevelDb(fd, 48000, N, 9000, 14000, act), processed: bandLevelDb(fp, 48000, N, 9000, 14000, act) },
    lsdDb: { degradedVsOriginal: lsd(fo, fd, 48000, N, 9000, 14000, act), processedVsOriginal: lsd(fo, fp, 48000, N, 9000, 14000, act) },
    belowCutoffMeanAbsDiffDb: belowDiff(fd, fp, 48000, N, 7000, act)
  };
  const mx = Math.max(maxFrameDb(orig48), maxFrameDb(deg), maxFrameDb(proc)), range = 90;
  const P = [['Wideband original', orig48], ['Low-passed at 8 kHz (what we start with)', deg], ['After sbr-crystalizer.js', proc]].map(([label, x]) => ({ label, ...spectrogramPng(x, 48000, mx, range, 24000) }));
  P[1].cutoff = null; P[2].cutoff = r.info.cutoffHz;
  spectrogramFigure('spectrograms-48k.svg', 'Spectrograms, 48 kHz clip low-passed at 8 kHz', 'Three spectrograms of the same synthetic voice clip: the wideband original, the same clip low-passed at 8 kHz, and the low-passed clip after processing, which fills the empty band above the detected cutoff.', P, 48000, 24000, SEC);
  avgFigure('avg-spectrum-48k.svg', [{ label: 'Wideband original', pts: avgSpectrumDb(orig48, 48000) }, { label: 'Low-passed at 8 kHz', pts: avgSpectrumDb(deg, 48000) }, { label: 'After processing', pts: avgSpectrumDb(proc, 48000) }], r.info.cutoffHz, 24000);
}
// Case A2: the same 8 kHz limit but with a GENTLE roll-off (8th-order Butterworth): auto detection should decline, manual works
{
  const deg = lowpass8(orig48, 48000, 8000), N = 1024, fo = stft(orig48, N), fd = stft(deg, N), act = activeFrames(fo);
  const auto = await sbr.process([deg], 48000, {}), man = await sbr.process([deg], 48000, { cutoffMode: 'manual', cutoffHz: 8000 });
  const fm = stft(man.channels[0], N);
  results.cases.hz48k_gentle_rolloff = {
    autoApplied: auto.applied, autoReason: auto.info.reason, manualApplied: man.applied, manualCutoffHz: man.info.cutoffHz,
    lsdDb: { degradedVsOriginal: lsd(fo, fd, 48000, N, 9000, 14000, act), manualProcessedVsOriginal: lsd(fo, fm, 48000, N, 9000, 14000, act) }
  };
}// Case B: 16 kHz, low-passed at 3.8 kHz (telephone-like band)
{
  const ref16 = decimate(brick(orig48, 48000, 7200), 3), deg = decimate(brick(orig48, 48000, 3800), 3);
  const r = await sbr.process([deg], 16000, {});
  const proc = r.channels[0], N = 1024, fo = stft(ref16, N), fd = stft(deg, N), fp = stft(proc, N), act = activeFrames(fo);
  results.cases.hz16k_lp3_8k = {
    applied: r.applied, detectedCutoffHz: r.info.cutoffHz, trueCutoffHz: 3800,
    bandDb: { original: bandLevelDb(fo, 16000, N, 4300, 7000, act), degraded: bandLevelDb(fd, 16000, N, 4300, 7000, act), processed: bandLevelDb(fp, 16000, N, 4300, 7000, act) },
    lsdDb: { degradedVsOriginal: lsd(fo, fd, 16000, N, 4300, 7000, act), processedVsOriginal: lsd(fo, fp, 16000, N, 4300, 7000, act) },
    belowCutoffMeanAbsDiffDb: belowDiff(fd, fp, 16000, N, 3300, act)
  };
  const mx = Math.max(maxFrameDb(ref16), maxFrameDb(deg), maxFrameDb(proc)), range = 90;
  const P = [['Reference (16 kHz, full band to 7.2 kHz)', ref16], ['Telephone-like: low-passed at 3.8 kHz', deg], ['After sbr-crystalizer.js', proc]].map(([label, x]) => ({ label, ...spectrogramPng(x, 16000, mx, range, 8000) }));
  P[2].cutoff = r.info.cutoffHz;
  spectrogramFigure('spectrograms-16k.svg', 'Spectrograms, 16 kHz clip low-passed at 3.8 kHz', 'Three spectrograms of the same synthetic voice clip at a 16 kHz sample rate: the reference, a telephone-like version low-passed at 3.8 kilohertz, and the processed version with the band above the cutoff rebuilt.', P, 16000, 8000, SEC);
}
// Case C: full-band clip -> should pass through untouched
{
  const r = await sbr.process([orig48], 48000, {});
  results.cases.hz48k_fullband = { applied: r.applied, reason: r.info.reason, returnedSameArray: r.channels[0] === orig48 };
}
// Case D: silence / noise only
{
  const rnd = mulberry32(7), noise = new Float32Array(48000 * 4); for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 2 - 1) * 0.001;
  const r = await sbr.process([lowpass8(noise, 48000, 6000)], 48000, {});
  results.cases.hz48k_noise_only = { applied: r.applied, reason: r.info.reason };
}
// Determinism, stereo identity, speed
{
  const deg = brick(orig48, 48000, 8000), a = await sbr.process([deg], 48000), b = await sbr.process([deg], 48000);
  let same = true; for (let i = 0; i < a.channels[0].length; i++) if (a.channels[0][i] !== b.channels[0][i]) { same = false; break; }
  const st = await sbr.process([deg, deg], 48000); let ident = true; for (let i = 0; i < st.channels[0].length; i++) if (st.channels[0][i] !== st.channels[1][i]) { ident = false; break; }
  results.determinism = { identicalOnRepeat: same, identicalChannelsStayIdentical: ident };
  const time = async (x, sr) => { const t = []; for (let i = 0; i < 3; i++) { const s = performance.now(); await sbr.process([x], sr, {}, { yieldFn: async () => {} }); t.push(performance.now() - s); } return Math.round(t.sort((p, q) => p - q)[1]); };
  const v10 = synthVoice(48000, 10), x48 = brick(v10, 48000, 8000), x16 = decimate(brick(v10, 48000, 3800), 3);
  results.speedMs = { sec10_48k_mono: await time(x48, 48000), sec10_16k_mono: await time(x16, 16000) };
}
fs.writeFileSync(path.join(docs, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
