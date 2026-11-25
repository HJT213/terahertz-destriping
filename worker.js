importScripts('processing.js');
self.onmessage = ({data}) => {
  try {
    const start = performance.now();
    const result = Denoising.process(new Uint8Array(data.pixels), data.width, data.height, data.params);
    self.postMessage({id: data.id, ...result, elapsed: performance.now()-start},
      [result.denoised.buffer, result.enhanced.buffer, result.mask.buffer]);
  } catch (error) { self.postMessage({id:data.id, error:error.message}); }
};
