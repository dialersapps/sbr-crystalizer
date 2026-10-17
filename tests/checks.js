/* Shared checks for sbr-crystalizer.js: used by test.html (browser) and tests/run.mjs (Node).
   Signals are synthetic and seeded, so every run is identical. */
(function (root) {
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // Voiced-speech-like signal: harmonics of a moving pitch with a syllabic envelope, content only below `topHz`.
  function voice(sr, seconds, topHz) {
    const n = Math.round(sr * seconds), x = new Float32Array(n), rnd = mulberry32(42);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, f0 = 110 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
      phase += (2 * Math.PI * f0) / sr;
      const env = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t)) ** 0.6;
      let s = 0;
      for (let h = 1; h * f0 < topHz; h++) {
        const f = h * f0, formant = 1 / (1 + ((f - 700) / 500) ** 2) + 0.6 / (1 + ((f - 2400) / 700) ** 2) + 0.15 / (1 + ((f - 5000) / 1500) ** 2);
        s += (formant / h ** 0.5) * Math.sin(h * phase);
      }
      x[i] = 0.3 * env * s + 1e-5 * (rnd() - 0.5);
    }
    return x;
  }
  function whiteNoise(n, seed) { const r = mulberry32(seed), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.2 * (r() * 2 - 1); return x; }

  // Mean power (dB) in a band, from a plain Hann-windowed DFT of a few spaced probe frequencies.
  function bandDb(x, sr, f0, f1) {
    const N = 4096; let acc = 0, cnt = 0;
    for (let start = 0; start + N <= x.length; start += N * 2) {
      for (let f = f0; f <= f1; f += (f1 - f0) / 12) {
        let re = 0, im = 0; const w = 2 * Math.PI * f / sr;
        for (let i = 0; i < N; i++) { const a = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N), v = x[start + i] * a; re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
        acc += re * re + im * im; cnt++;
      }
    }
    return 10 * Math.log10(acc / cnt / (N * N) + 1e-20);
  }

  async function run(sbr, report) {
    let passed = 0, failed = 0;
    const ok = (name, cond, detail) => { cond ? passed++ : failed++; report(name, !!cond, detail || ''); };
    const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

    ok('exports version, process, defaults, limits, normalizeOptions',
      typeof sbr.version === 'string' && typeof sbr.process === 'function' && sbr.defaults && sbr.limits && typeof sbr.normalizeOptions === 'function', sbr.version);
    const norm = sbr.normalizeOptions({ strength: 99, tilt: 'x', cutoffMode: 'weird' });
    ok('normalizeOptions clamps and defaults', norm.strength === sbr.limits.strength[1] && norm.tilt === sbr.defaults.tilt && norm.cutoffMode === 'auto');

    // 1. band-limited voice at 48 kHz
    const sr = 48000, x = voice(sr, 4, 7600);
    const xCopy = x.slice();
    const r = await sbr.process([x], sr);
    ok('48 kHz band-limited voice: applied', r.applied === true, 'reason ' + r.info.reason);
    const fc = r.info.cutoffHz || r.info.detectedCutoffHz;
    ok('cutoff found near 7.6 kHz', typeof fc === 'number' && fc > 6500 && fc < 8200, 'detected ' + fc);
    ok('output has same length and sample rate', r.channels[0].length === x.length && r.sampleRate === sr);
    let finite = true; for (const v of r.channels[0]) if (!Number.isFinite(v) || Math.abs(v) > 4) { finite = false; break; }
    ok('output is finite and not clipping wildly', finite);
    const before = bandDb(x, sr, 9500, 13500), after = bandDb(r.channels[0], sr, 9500, 13500);
    ok('9.5-13.5 kHz band gains at least 25 dB', after - before > 25, before.toFixed(1) + ' dB -> ' + after.toFixed(1) + ' dB');
    const lowBefore = bandDb(x, sr, 300, 3000), lowAfter = bandDb(r.channels[0], sr, 300, 3000);
    ok('300-3000 Hz band unchanged (within 0.5 dB)', Math.abs(lowAfter - lowBefore) < 0.5, lowBefore.toFixed(2) + ' vs ' + lowAfter.toFixed(2) + ' dB');
    ok('input arrays are not modified', maxAbsDiff(x, xCopy) === 0);

    // 2. determinism and stereo
    const r2 = await sbr.process([x], sr);
    ok('deterministic: same input gives identical output', maxAbsDiff(r.channels[0], r2.channels[0]) === 0);
    const st = await sbr.process([x, x], sr);
    ok('identical stereo channels stay identical', st.applied && maxAbsDiff(st.channels[0], st.channels[1]) === 0);
    ok('stereo result equals the mono result', maxAbsDiff(st.channels[0], r.channels[0]) === 0);

    // 3. leaves things alone
    const full = whiteNoise(sr * 3, 7), rn = await sbr.process([full], sr);
    ok('full-band noise is passed through', rn.applied === false && rn.channels[0] === full, 'reason ' + rn.info.reason);
    const silent = new Float32Array(sr * 2), rs = await sbr.process([silent], sr);
    ok('silence is passed through', rs.applied === false);
    const rShort = await sbr.process([new Float32Array(100)], sr);
    ok('too-short clip is passed through', rShort.applied === false && rShort.info.reason === 'short');
    const r96 = await sbr.process([x], 96000), r4 = await sbr.process([x], 4000);
    ok('rates outside 8-48 kHz are passed through', !r96.applied && !r4.applied && r96.info.reason === 'rate');
    const rEmpty = await sbr.process([], sr);
    ok('no channels is passed through', rEmpty.applied === false);

    // 4. manual cutoff and options
    const x16 = voice(16000, 3, 3600);
    const rm = await sbr.process([x16], 16000, { cutoffMode: 'manual', cutoffHz: 3600 });
    ok('16 kHz clip with manual cutoff: applied', rm.applied === true, 'reason ' + rm.info.reason);
    const b16 = bandDb(x16, 16000, 4300, 7000), a16 = bandDb(rm.channels[0], 16000, 4300, 7000);
    ok('4.3-7 kHz band gains at least 20 dB', a16 - b16 > 20, b16.toFixed(1) + ' -> ' + a16.toFixed(1) + ' dB');
    const r0 = await sbr.process([x16], 16000, { cutoffMode: 'manual', cutoffHz: 3600, strength: 0, floor: 0 });
    ok('strength 0 and floor 0 adds (almost) nothing', bandDb(r0.channels[0], 16000, 4300, 7000) < b16 + 10, bandDb(r0.channels[0], 16000, 4300, 7000).toFixed(1) + ' dB');
    const rd = await sbr.process([x16], 16000, { cutoffMode: 'manual', cutoffHz: 3600, doubleRate: true });
    ok('doubleRate: 2x sample rate and 2x length', rd.sampleRate === 32000 && rd.channels[0].length === x16.length * 2, rd.sampleRate + ' Hz, ' + rd.channels[0].length + ' samples');

    // 5. hooks
    let yields = 0; await sbr.process([x16], 16000, { cutoffMode: 'manual', cutoffHz: 3600 }, { yieldFn: async () => { yields++; } });
    ok('yieldFn is called while working', yields > 0, yields + ' yields');
    let aborted = false;
    try { await sbr.process([x], sr, {}, { signal: { aborted: true } }); } catch (e) { aborted = e && e.name === 'AbortError'; }
    ok('an aborted signal throws AbortError', aborted);

    report('', true, passed + ' passed, ' + failed + ' failed', true);
    return { passed, failed };
  }
  const api = { run, voice, whiteNoise, bandDb };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.sbrChecks = api;
}(typeof self !== 'undefined' ? self : this));