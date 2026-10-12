// Diagnostic only: forward every encoded frame unchanged. No media payload is
// read, retained or transmitted by this observer. Capture time stays absent
// when the browser does not expose it; task wake time is never substituted.
self.postMessage({ worker_ready: true, transform_event_supported: 'onrtctransform' in self });
self.onrtctransform = ({ transformer }) => {
  const { kind, publication } = transformer.options;
  const report = { kind, publication, frames: 0, capture_time_present: 0,
    capture_time_missing: 0, capture_time_regressions: 0, rtp_timestamp_present: 0,
    worker_time_origin_ms: performance.timeOrigin, samples: [], sample_capacity: 16 };
  let previousCapture, lastReport = -Infinity;
  self.postMessage({ kind, publication, transform_event_received: true });
  transformer.readable.pipeThrough(new TransformStream({
    transform(frame, controller) {
      const metadata = frame.getMetadata();
      const capture = metadata.captureTime;
      const rtp = metadata.rtpTimestamp ?? frame.timestamp;
      const capturePresent = typeof capture === 'number' && Number.isFinite(capture);
      const rtpPresent = Number.isInteger(rtp) && rtp >= 0 && rtp <= 0xffffffff;
      ++report.frames;
      if (capturePresent) {
        ++report.capture_time_present;
        if (previousCapture !== undefined && capture < previousCapture) ++report.capture_time_regressions;
        previousCapture = capture;
      } else ++report.capture_time_missing;
      if (rtpPresent) ++report.rtp_timestamp_present;
      if (report.samples.length < report.sample_capacity) report.samples.push({
        capture_time_ms: capturePresent ? capture : null,
        rtp_timestamp: rtpPresent ? rtp : null,
        ssrc: Number.isInteger(metadata.synchronizationSource) ? metadata.synchronizationSource : null,
        metadata_fields: Object.keys(metadata).sort(),
      });
      controller.enqueue(frame);
      if (performance.now() - lastReport >= 500) {
        lastReport = performance.now();
        self.postMessage(report);
      }
    },
  })).pipeTo(transformer.writable).catch(error => self.postMessage({
    kind, publication, error: String(error),
  }));
};
