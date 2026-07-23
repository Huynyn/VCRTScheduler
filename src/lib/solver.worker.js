// Runs the (synchronous, sometimes multi-second) schedule solve off the main
// thread so the UI stays responsive and the progress bar keeps moving. Posts
// periodic { type: 'progress', fraction } messages and a final
// { type: 'result', result } message.
import { generateSchedules } from './scheduler.js';

self.onmessage = (e) => {
  const { responders, options } = e.data || {};
  try {
    const result = generateSchedules(responders, {
      ...options,
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
