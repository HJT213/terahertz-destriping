'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const numericKeys = ['horizontalAngle','verticalAngle','horizontalOffset','verticalOffset',
    'f1','f2','theta','medianRows','medianCols','openSize','closeSize','minArea','connectivity','mmPerPixel'];
  const canvasIds = ['originalCanvas','denoisedCanvas','enhancedCanvas','maskCanvas'];
  let source = null, result = null, worker = null, busy = false, generation = 0;
  let lastParams = null, synthetic = false;
  const status = (message, kind='') => { $('status').textContent = message; $('status').className = 'status '+kind; };
  function clearResult() {
    result = null; lastParams = null;
    for (const id of canvasIds.slice(1)) {
      $(id).hidden = true; $(id).nextElementSibling.hidden = false;
      document.querySelector(`[data-canvas="${id}"]`).disabled = true;
    }
    for (const id of ['countMetric','areaMetric','ratioMetric','timeMetric']) $(id).textContent = '—';
    $('areaUnit').textContent = 'px · 尚未标定'; $('reportBtn').disabled = true;
  }
  function paint(id, pixels, width, height) {
    const canvas = $(id); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'), image = context.createImageData(width,height);
    for (let i = 0; i < pixels.length; i++) {
      const j = i*4; image.data[j] = image.data[j+1] = image.data[j+2] = pixels[i]; image.data[j+3] = 255;
    }
    context.putImageData(image,0,0); canvas.hidden = false; canvas.nextElementSibling.hidden = true;
    document.querySelector(`[data-canvas="${id}"]`).disabled = false;
  }
  function setBusy(value) {
    busy = value;
    for (const input of $('settings').querySelectorAll('input,select,button')) input.disabled = value;
    $('chooseBtn').disabled = value; $('demoBtn').disabled = value; $('fileInput').disabled = value;
    $('runBtn').disabled = value || !source;
    $('runBtn').firstChild.textContent = value ? '正在计算… ' : '运行分析 ';
    $('reportBtn').disabled = value || !result;
  }
  function adopt(pixels, width, height, name, isSynthetic) {
    source = { pixels,width,height,name }; synthetic = isSynthetic;
    clearResult(); paint('originalCanvas',pixels,width,height);
    $('fileName').textContent = name;
    $('fileMeta').textContent = `${width} × ${height} px · 8 位灰度 · ${isSynthetic ? '合成演示图，非实验数据' : '仅在本地浏览器内处理'}`;
    $('originalNote').textContent = isSynthetic ? '合成演示图 · 非实验结果' : `${width} × ${height} px · 原始灰度图`;
    $('stateBadge').textContent = '准备就绪'; $('runBtn').disabled = false;
    status(isSynthetic ? '演示图已加载。点击“运行分析”体验流程；演示效果不代表真实样品性能。' : '图像已加载。调节参数后点击“运行分析”。');
  }
  async function loadFile(file) {
    if (!file || busy) return;
    const token = ++generation;
    if (file.size > 20*1024*1024) { status('文件超过 20 MB，请先转换或裁剪。','error'); return; }
    if (!/\.(png|jpe?g|bmp|webp)$/i.test(file.name)) { status('请选择 PNG、JPEG、BMP 或 WebP 图像。','error'); return; }
    status('正在读取图像…');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (token !== generation) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (width < 8 || height < 8 || width > 2048 || height > 2048 || width*height > 2097152)
        throw new Error('图像须至少 8 × 8，单边不超过 2048，且总像素不超过 200 万。请先裁剪或缩小。');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d',{willReadFrequently:true});
      context.fillStyle = '#fff'; context.fillRect(0,0,width,height); context.drawImage(image,0,0);
      const rgba = context.getImageData(0,0,width,height).data, pixels = new Uint8Array(width*height);
      for (let i = 0; i < pixels.length; i++) {
        const j = i*4; pixels[i] = Denoising.byte(.2989360213*rgba[j]+.5870430745*rgba[j+1]+.1140209043*rgba[j+2]);
      }
      adopt(pixels,width,height,file.name,false);
    } catch (error) { if (token === generation) status('无法读取：'+error.message,'error'); }
    finally { URL.revokeObjectURL(url); $('fileInput').value = ''; }
  }
  function demo() {
    if (busy) return;
    generation++;
    const width = 384, height = 384, pixels = new Uint8Array(width*height);
    let seed = 19;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed,1664525)+1013904223)>>>0;
      let v = 174 + 17*Math.sin(y*2*Math.PI/13) + 11*Math.cos(x*2*Math.PI/19) + 4*(seed/4294967296-.5);
      v += 8*Math.cos(x/80) + 5*Math.sin(y/60);
      if (((x-124)/37)**2+((y-138)/26)**2 < 1) v -= 85;
      if (((x-265)/24)**2+((y-246)/45)**2 < 1) v -= 95;
      if (x > 70 && x < 105 && y > 267 && y < 300) v -= 75;
      pixels[y*width+x] = Denoising.byte(v);
    }
    adopt(pixels,width,height,'合成太赫兹条纹演示图',true);
  }
  function parameters() {
    const p = {};
    for (const key of numericKeys) {
      if ($(key).value.trim() === '' && key !== 'mmPerPixel') throw new Error('请填写所有处理参数。');
      p[key] = Number($(key).value);
    }
    p.algorithm = $('algorithm').value; p.shape = $('shape').value;
    p.invertMask = $('invertMask').checked;
    p.ranges = [0,1,2,3].map(i=>[Number($(`q${i}lo`).value),Number($(`q${i}hi`).value)]);
    for (const el of $('settings').querySelectorAll('input[type="number"]')) {
      if (el.id !== 'mmPerPixel' && el.value.trim()==='') throw new Error('请填写所有处理参数。');
    }
    return p;
  }
  function makeWorker() {
    if (worker) return worker;
    worker = new Worker('worker.js');
    worker.onmessage = ({data}) => {
      if (data.id !== generation) return;
      setBusy(false);
      if (data.error) { $('stateBadge').textContent = '处理失败'; status(data.error,'error'); return; }
      result = data;
      paint('denoisedCanvas',data.denoised,source.width,source.height);
      paint('enhancedCanvas',data.enhanced,source.width,source.height);
      paint('maskCanvas',data.mask,source.width,source.height);
      $('countMetric').textContent = data.count.toLocaleString('zh-CN');
      $('areaMetric').textContent = data.areaMM2 === null ? data.pixels.toLocaleString('zh-CN') : data.areaMM2.toLocaleString('zh-CN',{maximumFractionDigits:6});
      $('areaUnit').textContent = data.areaMM2 === null ? 'px · 尚未标定' : `mm² · ${lastParams.mmPerPixel} mm / px`;
      $('ratioMetric').textContent = (data.pixels/(source.width*source.height)*100).toFixed(2)+'%';
      $('timeMetric').textContent = (data.elapsed/1000).toFixed(2);
      $('reportBtn').disabled = false; $('stateBadge').textContent = '分析完成';
      status(data.warnings.length ? '分析完成。'+data.warnings.join(' ') : '分析完成。可下载图像和分析记录；候选缺陷需结合原图核验。',data.warnings.length ? 'warning' : '');
    };
    worker.onerror = event => {
      event.preventDefault(); worker.terminate(); worker = null; setBusy(false);
      $('stateBadge').textContent = '处理失败';
      status('计算线程无法启动或已停止。请通过网站地址访问页面，或降低图像尺寸后重试。','error');
    };
    return worker;
  }
  $('settings').addEventListener('submit', event => {
    event.preventDefault(); if (!source || busy) return;
    try {
      const p = parameters(); Denoising.validate(source.width,source.height,source.pixels,p);
      clearResult(); lastParams = p; const id = ++generation;
      setBusy(true); $('stateBadge').textContent = '正在计算'; status('正在进行频域滤波与缺陷分析。计算在本地进行，请稍候…');
      const copy = source.pixels.slice();
      makeWorker().postMessage({id,pixels:copy.buffer,width:source.width,height:source.height,params:p},[copy.buffer]);
    } catch (error) { setBusy(false); status(error.message,'error'); }
  });
  function changed() {
    if (busy) return;
    if (result) clearResult();
    if (source) { $('stateBadge').textContent = '参数已变更'; status('参数已变更，请重新运行分析。'); }
    $('sectorControls').hidden = $('algorithm').value !== 'sector';
    $('artifactControls').hidden = $('algorithm').value !== 'artifact';
    for (const key of ['horizontalAngle','verticalAngle'])
      document.querySelector(`output[for="${key}"]`).textContent = $(key).value+'°';
    for (const key of ['openSize','closeSize']) {
      $(key).min = $('shape').value === 'square' ? '1' : '0';
      if ($('shape').value==='square' && Number($(key).value)<1) $(key).value = 1;
    }
  }
  $('settings').addEventListener('input',changed);
  $('settings').addEventListener('change',changed);
  $('resetBtn').addEventListener('click',()=>{
    const algorithm = $('algorithm').value;
    $('settings').reset();
    $('algorithm').value = algorithm;
    changed();
  });
  $('chooseBtn').addEventListener('click',()=>$('fileInput').click());
  $('fileInput').addEventListener('change',()=>loadFile($('fileInput').files[0]));
  $('demoBtn').addEventListener('click',demo);
  const drop = $('dropzone');
  for (const type of ['dragover','dragenter']) drop.addEventListener(type,event=>{ event.preventDefault(); if(!busy) drop.classList.add('dragging'); });
  for (const type of ['dragleave','drop']) drop.addEventListener(type,event=>{ event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop',event=>loadFile(event.dataTransfer.files[0]));
  function save(blob,name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  for (const button of document.querySelectorAll('.download')) button.addEventListener('click',()=>{
    const names = {originalCanvas:'original-gray',denoisedCanvas:'denoised',enhancedCanvas:'enhanced',maskCanvas:'defect-mask'};
    $(button.dataset.canvas).toBlob(blob=>{
      if (blob) save(blob,`${source.name.replace(/\.[^.]+$/,'')}-${names[button.dataset.canvas]}.png`);
    },'image/png');
  });
  $('reportBtn').addEventListener('click',()=>{
    if (!result) return;
    const report = { software:'Denoising Web Preview',version:'0.1.0',createdAt:new Date().toISOString(),
      source:{name:source.name,width:source.width,height:source.height,syntheticDemo:synthetic,bitDepth:8},
      parameters:lastParams,statistics:{count:result.count,areaPixels:result.pixels,areaMM2:result.areaMM2,
        ratio:result.pixels/source.pixels.length,componentAreasPixels:result.areas,threshold:result.threshold,
        elapsedMilliseconds:result.elapsed},warnings:result.warnings,
      compatibility:'根据 app1.mlapp 迁移；含边界保护、面积单位修正及离散圆盘差异，尚未完成 MATLAB 逐像素一致性验证。',
      interpretation:'白色区域为候选缺陷，需结合原图核验；演示图不代表真实实验性能。' };
    save(new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'}),'denoising-analysis.json');
  });
  for (const id of ['helpBtn','compatBtn']) $(id).addEventListener('click',()=>$('helpDialog').showModal());
  $('closeHelp').addEventListener('click',()=>$('helpDialog').close());
  if (location.protocol==='file:') status('本页面需要通过本地预览服务或正式网站打开；直接双击 HTML 无法启动计算线程。','warning');
})();
