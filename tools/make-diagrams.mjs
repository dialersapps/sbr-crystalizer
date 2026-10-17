// Static diagrams for the README and the blog post. node tools/make-diagrams.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const STYLE = '<style>text{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;fill:#e6ecf5}.dim{fill:#9fb4cc}.box{fill:#14202e;stroke:#3b5a7c;stroke-width:1.5}.ok{fill:#1a2c1f;stroke:#4f8a5e;stroke-width:1.5}.no{fill:#2c1a1a;stroke:#8a4f4f;stroke-width:1.5}.arrow{stroke:#7fa6cf;stroke-width:2;fill:none;marker-end:url(#a)}</style><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7fa6cf"/></marker></defs><rect width="100%" height="100%" rx="10" fill="#0b0f14" stroke="#24364a"/>';
const wrap = (vb, id, title, desc, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-labelledby="t d"><title id="t">${title}</title><desc id="d">${desc}</desc>${STYLE}${body}</svg>`;
const box = (x, y, w, h, l1, l2, cls = 'box') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><text x="${x + w / 2}" y="${y + (l2 ? h / 2 - 3 : h / 2 + 5)}" text-anchor="middle" font-size="13.5" font-weight="600">${l1}</text>${l2 ? `<text class="dim" x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle" font-size="11">${l2}</text>` : ''}`;

// 1) how it works
fs.writeFileSync(path.join(docs, 'pipeline.svg'), wrap('0 0 760 330', 'p', 'How sbr-crystalizer.js processes a clip', 'Pass one analyses the whole clip: average spectrum, frame energies, cutoff. Pass two works frame by frame: the real spectrum below the cutoff is kept, a speech-shaped band is synthesised above it from the level under the cutoff, a tilt, a speech floor, the texture just below the cutoff and deterministic noise phases, gated by frame energy and tapered at the top, then an inverse FFT and overlap-add.',
  `<text x="20" y="26" font-size="14" font-weight="600">How it works</text>
  <text class="dim" x="20" y="52" font-size="12">Pass 1 - whole clip</text>
  ${box(20, 62, 150, 58, 'STFT analysis', 'sqrt-Hann, 75% overlap')}<path class="arrow" d="M170,91 L206,91"/>
  ${box(208, 62, 170, 58, 'Average spectrum', 'pooled over all channels')}<path class="arrow" d="M378,91 L414,91"/>
  ${box(416, 62, 160, 58, 'Find the cutoff', 'steepest cliff, or manual')}<path class="arrow" d="M576,91 L612,91"/>
  ${box(614, 62, 126, 58, 'Frame energies', 'for the noise gate')}
  <text class="dim" x="20" y="154" font-size="12">Pass 2 - every frame</text>
  ${box(20, 164, 150, 58, 'Keep real spectrum', 'everything below cutoff')}
  ${box(190, 164, 190, 58, 'Level just under cutoff', 'smoothed between frames')}<path class="arrow" d="M380,193 L406,193"/>
  ${box(408, 164, 170, 58, 'Extend upward', 'tilt 11 dB/oct + speech floor')}<path class="arrow" d="M578,193 L604,193"/>
  ${box(606, 164, 134, 58, 'Shape + noise', 'texture, hashed phases')}
  <path class="arrow" d="M673,222 L673,246"/>
  ${box(470, 248, 270, 58, 'Gate by frame energy, taper top', 'no hiss in silence', 'ok')}<path class="arrow" d="M470,277 L394,277"/>
  ${box(214, 248, 180, 58, 'Inverse FFT', 'overlap-add', 'ok')}<path class="arrow" d="M214,277 L178,277"/>
  ${box(20, 248, 158, 58, 'Output channels', 'same rate (or 2x)', 'ok')}`));

// 2) when it applies
fs.writeFileSync(path.join(docs, 'when-it-applies.svg'), wrap('0 0 760 370', 'w', 'When sbr-crystalizer.js changes the audio', 'It passes the audio through untouched unless the sample rate is 8 to 48 kilohertz, the clip is long enough, it contains speech, and a steep cutoff is found in the average spectrum or a manual cutoff is given. Only then does it rebuild the band above the cutoff.',
  `<text x="20" y="26" font-size="14" font-weight="600">When it changes the audio (and when it leaves it alone)</text>
  ${box(20, 50, 150, 52, 'Your channels', 'Float32Array each')}<path class="arrow" d="M170,76 L200,76"/>
  ${box(202, 50, 170, 52, 'Rate 8-48 kHz?', 'and at least 2 frames long')}<path class="arrow" d="M372,76 L402,76"/>
  ${box(404, 50, 170, 52, 'Speech present?', 'not just silence or noise')}<path class="arrow" d="M574,76 L604,76"/>
  ${box(606, 50, 134, 52, 'Cutoff found?', 'cliff, or manual')}
  <path class="arrow" d="M287,102 L287,150"/><path class="arrow" d="M489,102 L489,150"/><path class="arrow" d="M673,102 L673,150"/>
  ${box(202, 152, 170, 52, 'No: unchanged', 'applied: false', 'no')}${box(404, 152, 170, 52, 'No: unchanged', 'applied: false', 'no')}${box(606, 152, 134, 52, 'No: unchanged', 'full-band audio', 'no')}
  
  <text class="dim" x="20" y="236" font-size="12">All three checks pass</text>
  <path class="arrow" d="M673,204 L673,252" style="stroke-dasharray:5 4"/>
  ${box(470, 254, 270, 56, 'Yes: rebuild the band above the cutoff', 'up to the taper end (default 14.9 kHz)', 'ok')}
  <text class="dim" x="20" y="342" font-size="11.5">Auto-detect needs a steep cutoff (at least 15 dB over about 375 Hz), as left by codecs and resampling.</text>
  <text class="dim" x="20" y="360" font-size="11.5">A gentle filter roll-off is not detected; give it the cutoff with { cutoffMode: 'manual', cutoffHz }.</text>`));

// 3) banner
fs.writeFileSync(path.join(docs, 'banner.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 260" role="img" aria-labelledby="bt bd"><title id="bt">sbr-crystalizer.js</title><desc id="bd">sbr-crystalizer.js: artificially add fidelity to low-quality voice recordings. Pure JavaScript, no WebAssembly, MIT licensed.</desc><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14202e"/><stop offset="1" stop-color="#0b0f14"/></linearGradient></defs><rect width="1000" height="260" rx="16" fill="url(#g)" stroke="#24364a"/>
<g transform="translate(48,60)"><rect width="84" height="84" rx="18" fill="#14202e" stroke="#4da3ff" stroke-width="3"/><g fill="#4da3ff"><rect x="14" y="50" width="6" height="20" rx="2"/><rect x="26" y="38" width="6" height="32" rx="2"/><rect x="38" y="26" width="6" height="44" rx="2"/></g><g fill="#e6ecf5" opacity=".55"><rect x="50" y="34" width="6" height="14" rx="2"/><rect x="62" y="40" width="6" height="8" rx="2"/></g><g fill="#7fb8ff" opacity=".9"><rect x="50" y="22" width="6" height="8" rx="2"/><rect x="62" y="16" width="6" height="6" rx="2"/></g></g>
<text x="160" y="104" font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="52" font-weight="800" fill="#e6ecf5">sbr-crystalizer.js</text>
<text x="160" y="146" font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="24" fill="#9fb4cc">Artificially add fidelity to low-quality voice recordings</text>
<g font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="18" font-weight="600" fill="#e6ecf5"><rect x="48" y="188" width="196" height="38" rx="19" fill="#1a2c1f" stroke="#4f8a5e"/><text x="146" y="213" text-anchor="middle">no WebAssembly</text><rect x="260" y="188" width="196" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="358" y="213" text-anchor="middle">~6 KB gzipped</text><rect x="472" y="188" width="250" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="597" y="213" text-anchor="middle">browser, Worker, Node</text><rect x="738" y="188" width="120" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="798" y="213" text-anchor="middle">MIT</text></g></svg>`);
console.log('diagrams written');