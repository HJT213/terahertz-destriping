/* Browser port of app1.mlapp. See ../README.md for compatibility boundaries. */
(function (root) {
  'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const byte = v => clamp(Math.round(v), 0, 255);
  const plans = new Map();

  function radix2(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len *= 2) {
      const angle = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(angle), wi = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = start + j, b = a + len / 2;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const next = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = next;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function fft(re, im, inverse = false) {
    const n = re.length;
    if (n <= 1) return;
    if (inverse) {
      for (let i = 0; i < n; i++) im[i] = -im[i];
      fft(re, im);
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
      return;
    }
    if ((n & (n - 1)) === 0) { radix2(re, im); return; }
    // Bluestein transform retains the original image size; no resizing/padding of images.
    let plan = plans.get(n);
    if (!plan) {
      let size = 1;
      while (size < n * 2 - 1) size *= 2;
      const cos = new Float64Array(n), sin = new Float64Array(n);
      const br = new Float64Array(size), bi = new Float64Array(size);
      for (let i = 0; i < n; i++) {
        const angle = Math.PI * ((i * i) % (2 * n)) / n;
        cos[i] = Math.cos(angle); sin[i] = Math.sin(angle);
        br[i] = cos[i]; bi[i] = sin[i];
        if (i) { br[size - i] = cos[i]; bi[size - i] = sin[i]; }
      }
      radix2(br, bi);
      plan = { size, cos, sin, br, bi };
      if (plans.size >= 12) plans.clear();
      plans.set(n, plan);
    }
    const ar = new Float64Array(plan.size), ai = new Float64Array(plan.size);
    for (let i = 0; i < n; i++) {
      ar[i] = re[i] * plan.cos[i] + im[i] * plan.sin[i];
      ai[i] = im[i] * plan.cos[i] - re[i] * plan.sin[i];
    }
    radix2(ar, ai);
    for (let i = 0; i < plan.size; i++) {
      const v = ar[i] * plan.br[i] - ai[i] * plan.bi[i];
      ai[i] = ar[i] * plan.bi[i] + ai[i] * plan.br[i]; ar[i] = v;
    }
    radix2(ar, ai, true);
    for (let i = 0; i < n; i++) {
      re[i] = ar[i] * plan.cos[i] + ai[i] * plan.sin[i];
      im[i] = ai[i] * plan.cos[i] - ar[i] * plan.sin[i];
    }
  }

  function fft2(re, im, width, height, inverse = false) {
    const rr = new Float64Array(width), ri = new Float64Array(width);
    for (let y = 0; y < height; y++) {
      rr.set(re.subarray(y * width, (y + 1) * width));
      ri.set(im.subarray(y * width, (y + 1) * width));
      fft(rr, ri, inverse); re.set(rr, y * width); im.set(ri, y * width);
    }
    const cr = new Float64Array(height), ci = new Float64Array(height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) { cr[y] = re[y * width + x]; ci[y] = im[y * width + x]; }
      fft(cr, ci, inverse);
      for (let y = 0; y < height; y++) { re[y * width + x] = cr[y]; im[y * width + x] = ci[y]; }
    }
  }

  function shift(data, width, height, inverse = false) {
    const out = new Float64Array(data.length);
    const sx = inverse ? Math.ceil(width / 2) : Math.floor(width / 2);
    const sy = inverse ? Math.ceil(height / 2) : Math.floor(height / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      out[((y + sy) % height) * width + (x + sx) % width] = data[y * width + x];
    return out;
  }

  function rotate(data, width, height, ccw) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = ccw ? y : height - 1 - y;
      const dy = ccw ? width - 1 - x : x;
      out[dy * height + dx] = data[y * width + x];
    }
    return out;
  }

  function sectorPass(data, width, height, angle, offset, transposeProjection, lowerPeak, warnings) {
    if (angle === 0) return { data: new Uint8Array(data), peak: lowerPeak ?? 0 };
    let re = Float64Array.from(data), im = new Float64Array(data.length);
    fft2(re, im, width, height); re = shift(re, width, height); im = shift(im, width, height);
    // Original second pass sums d(j,i). Preserve this for square images only;
    // its indexing is undefined on rectangular images, where row projection is used.
    const transposed = transposeProjection && width === height;
    const profile = new Float64Array(height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = transposed ? x * width + y : y * width + x;
      profile[y] += Math.log(Math.max(1e-12, Math.hypot(re[index], im[index])));
    }
    let main = 0;
    for (let i = 1; i < height; i++) if (profile[i] > profile[main]) main = i;
    let valley = -1, peak = -1;
    for (let i = Math.min(main - 1, height - 3); i >= 2; i--)
      if ([i-2, i-1, i+1, i+2].every(j => profile[i] < profile[j])) { valley = i; break; }
    for (let i = Math.min(valley - 1, height - 3); i >= 2; i--)
      if ([i-2, i-1, i+1, i+2].every(j => profile[i] > profile[j])) { peak = i; break; }
    if (peak < 0) {
      warnings.push('某方向未找到有效的次峰，该方向保留原图；可调整参数或更换滤波器。');
      return { data: new Uint8Array(data), peak: 0 };
    }
    // MATLAB's loops use one-based indices. Retain their original mask geometry.
    const p = clamp(peak + 1 + offset, 1, Math.floor(height / 2) - 1);
    const lp = clamp(lowerPeak ?? p, 0, Math.floor(height / 2) - 1);
    const tangent = Math.tan(angle * Math.PI / 360);
    const first = Math.max(1, Math.ceil(width / 2 - tangent * Math.abs(p)));
    const last = Math.min(width, Math.floor(width / 2 + tangent * Math.abs(p)));
    for (let i = 1; i <= height; i++) for (let j = first; j <= last; j++) {
      let remove = false;
      if (i <= p) remove = Math.abs((i - p) / (j - width / 2)) >= 1 / tangent;
      if (i >= height - lp) remove ||= Math.abs((i - height + lp) / (j - width / 2)) >= 1 / tangent;
      if (remove) { re[(i-1)*width+j-1] = 0; im[(i-1)*width+j-1] = 0; }
    }
    re = shift(re, width, height, true); im = shift(im, width, height, true);
    fft2(re, im, width, height, true);
    return { data: Uint8Array.from(re, byte), peak: p };
  }

  function sector(data, width, height, p, warnings) {
    const a = sectorPass(data, width, height, p.horizontalAngle, p.horizontalOffset, false, null, warnings);
    const rotated = rotate(a.data, width, height, true);
    if (width !== height) warnings.push('矩形图像使用边界修正后的方向投影；结果不保证与原版逐像素一致。');
    const b = sectorPass(rotated, height, width, p.verticalAngle, p.verticalOffset, true, width === height ? a.peak : null, warnings);
    return rotate(b.data, height, width, false);
  }

  function median(data, width, height, rows, cols) {
    if (rows === 1 && cols === 1) return new Uint8Array(data);
    const out = new Uint8Array(data.length), values = new Array(rows * cols);
    const oy = Math.floor(rows / 2), ox = Math.floor(cols / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let k = 0;
      for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < cols; dx++) {
        const yy = y + dy - oy, xx = x + dx - ox;
        values[k++] = yy < 0 || xx < 0 || yy >= height || xx >= width ? 0 : data[yy * width + xx];
      }
      values.sort((a,b) => a-b);
      const middle = Math.floor(k / 2);
      out[y * width + x] = byte(k % 2 ? values[middle] : (values[middle-1] + values[middle]) / 2);
    }
    return out;
  }

  function artifact(data, width, height, p) {
    const re = Float64Array.from(data), im = new Float64Array(data.length);
    fft2(re, im, width, height);
    // Keep the unshifted multiplication in Button_4Pushed, including its centered U,V grid.
    const f2 = p.f2 * Math.max(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const u = x - Math.floor((width - 1) / 2), v = y - Math.floor((height - 1) / 2);
      const r2 = u*u + v*v;
      const h = Math.exp(-p.f1 * r2) * (1 - Math.exp(-f2 * r2)) *
        (1 - Math.exp(-(1-p.theta)*u*u) * (1-Math.exp(-(1-p.theta)*v*v)));
      const i = y * width + x; re[i] *= h; im[i] *= h;
    }
    fft2(re, im, width, height, true);
    let lo = Infinity, hi = -Infinity;
    for (const v of re) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const normalized = Uint8Array.from(re, v => hi > lo ? byte((v-lo)/(hi-lo)*255) : 0);
    return median(normalized, width, height, 3, 3);
  }

  function enhance(data, width, height, ranges) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const q = (y >= Math.floor(height/2) ? 2 : 0) + (x >= Math.floor(width/2) ? 1 : 0);
      const [lo,hi] = ranges[q], i = y * width + x;
      out[i] = byte((data[i]/255-lo)/(hi-lo)*255);
    }
    return out;
  }

  function otsu(data) {
    const hist = new Float64Array(256);
    for (const v of data) hist[v]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let count = 0, part = 0, best = -1, thresholds = [];
    for (let t = 0; t < 255; t++) {
      count += hist[t]; part += t * hist[t];
      if (!count || count === data.length) continue;
      const diff = part/count - (sum-part)/(data.length-count);
      const score = count * (data.length-count) * diff*diff;
      if (score > best + 1e-7) { best = score; thresholds = [t]; }
      else if (Math.abs(score-best) <= Math.max(1e-7, Math.abs(best)*1e-13)) thresholds.push(t);
    }
    return thresholds.length ? thresholds.reduce((a,b)=>a+b,0)/thresholds.length : 0;
  }

  function structuringElement(shape, size) {
    const offsets = [];
    if (shape === 'square') {
      const origin = Math.floor((size - 1) / 2);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) offsets.push([x-origin,y-origin]);
    } else {
      for (let y = -size; y <= size; y++) for (let x = -size; x <= size; x++)
        if (x*x+y*y <= size*size) offsets.push([x,y]);
    }
    return offsets;
  }

  function morphology(data, width, height, offsets, dilate) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let value = dilate ? 0 : 1;
      for (const [dx,dy] of offsets) {
        const xx = x + (dilate ? -dx : dx), yy = y + (dilate ? -dy : dy);
        const v = xx < 0 || yy < 0 || xx >= width || yy >= height ? (dilate ? 0 : 1) : data[yy*width+xx];
        if (dilate ? v : !v) { value = dilate ? 1 : 0; break; }
      }
      out[y*width+x] = value;
    }
    return out;
  }

  function components(data, width, height, connectivity = 8, minArea = 0) {
    const visited = new Uint8Array(data.length), queue = new Int32Array(data.length);
    const kept = new Uint8Array(data.length), areas = [];
    const neighbors = connectivity === 4 ? [[-1,0],[1,0],[0,-1],[0,1]] :
      [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    for (let start = 0; start < data.length; start++) {
      if (!data[start] || visited[start]) continue;
      let head = 0, tail = 1; queue[0] = start; visited[start] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i/width);
        for (const [dx,dy] of neighbors) {
          const xx = x+dx, yy = y+dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const j = yy*width+xx;
          if (data[j] && !visited[j]) { visited[j] = 1; queue[tail++] = j; }
        }
      }
      if (tail >= minArea) { areas.push(tail); for (let j = 0; j < tail; j++) kept[queue[j]] = 1; }
    }
    return { mask: kept, areas };
  }

  function segment(data, width, height, p) {
    const filtered = median(data, width, height, p.medianRows, p.medianCols);
    const inverted = Uint8Array.from(filtered, v => 255-v), threshold = otsu(inverted);
    let mask = Uint8Array.from(inverted, v => v > threshold ? 1 : 0);
    const opening = structuringElement(p.shape, p.openSize);
    mask = morphology(morphology(mask,width,height,opening,false),width,height,opening,true);
    mask = components(mask,width,height,p.connectivity,p.minArea).mask;
    const closing = structuringElement(p.shape, p.closeSize);
    mask = morphology(morphology(mask,width,height,closing,true),width,height,closing,false);
    if (p.invertMask) mask = Uint8Array.from(mask, v => 1-v);
    // regionprops(binary,'Area') in MATLAB always uses 8-connectivity in 2-D.
    const regions = components(mask,width,height,8);
    const pixels = regions.areas.reduce((a,b)=>a+b,0);
    return { mask: Uint8Array.from(mask, v=>v*255), count: regions.areas.length,
      pixels, areas: regions.areas.sort((a,b)=>b-a), threshold: threshold/255,
      areaMM2: p.mmPerPixel > 0 ? pixels*p.mmPerPixel*p.mmPerPixel : null };
  }

  function validate(width, height, data, p) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 ||
        width > 2048 || height > 2048 || width*height > 2097152 || data.length !== width*height)
      throw new Error('图像须至少 8 × 8，单边不超过 2048，且总像素不超过 200 万。');
    const number = (key,lo,hi,integer=false) => {
      if (!Number.isFinite(p[key]) || p[key] < lo || p[key] > hi || (integer && !Number.isInteger(p[key])))
        throw new Error('参数超出范围：' + key);
    };
    if (!['sector','artifact'].includes(p.algorithm)) throw new Error('请选择有效的滤波器。');
    for (const k of ['horizontalAngle','verticalAngle']) number(k,0,30);
    for (const k of ['horizontalOffset','verticalOffset']) number(k,0,30,true);
    number('f1',0,1); number('f2',0,1); number('theta',0,1);
    for (const k of ['medianRows','medianCols']) number(k,1,9,true);
    if (!['disk','square'].includes(p.shape)) throw new Error('请选择有效的形态学结构。');
    for (const k of ['openSize','closeSize']) number(k,p.shape==='square'?1:0,100,true);
    number('minArea',0,2097152,true); number('mmPerPixel',0,1000);
    if (![4,8].includes(p.connectivity)) throw new Error('连通方式须为 4 或 8。');
    if (!Array.isArray(p.ranges) || p.ranges.length !== 4 || p.ranges.some(r =>
      !Array.isArray(r) || r.length!==2 || !r.every(Number.isFinite) || r[0]<0 || r[1]>1 || r[0]>=r[1]))
      throw new Error('每个区域的灰度下限须小于上限，且均在 0 至 1 之间。');
  }

  function process(data, width, height, p) {
    validate(width,height,data,p);
    const warnings = [];
    const denoised = p.algorithm === 'sector' ? sector(data,width,height,p,warnings) : artifact(data,width,height,p);
    const enhanced = enhance(denoised,width,height,p.ranges);
    const defects = segment(enhanced,width,height,p);
    return { denoised, enhanced, ...defects, warnings: [...new Set(warnings)] };
  }

  root.Denoising = { fft, fft2, shift, rotate, median, otsu, components, enhance, segment,
    sector, artifact, process, validate, byte };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Denoising;
})(typeof globalThis !== 'undefined' ? globalThis : self);
