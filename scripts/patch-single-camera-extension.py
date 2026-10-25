"""Apply the single-device, dual-format contract to a temporary OBS source copy."""
from pathlib import Path
import sys
root=Path(sys.argv[1])
p=root/'OBSCameraDeviceSource.swift';s=p.read_text()
s=s.replace('    private var _videoDescription: CMFormatDescription!', '''    private let formatLock = NSRecursiveLock()
    private var selectedFormatIndex = 0
    private var descriptions: [CMFormatDescription] = []
    private var pools: [CVPixelBufferPool] = []
    var activeFormatIndex: Int {
        formatLock.lock(); defer { formatLock.unlock() }
        return selectedFormatIndex
    }
    func selectFormat(_ index: Int, fromSink: Bool) throws {
        guard (0..<2).contains(index) else {
            throw NSError(domain: "ProducerCamera", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported camera format"])
        }
        formatLock.lock()
        // A receiver cannot silently override the active Producer canvas.
        if !fromSink && sinkStarted && index != selectedFormatIndex {
            formatLock.unlock()
            throw NSError(domain: "ProducerCamera", code: 2, userInfo: [NSLocalizedDescriptionKey: "Reconnect the camera using Producer's selected orientation"])
        }
        if fromSink && index != selectedFormatIndex && _streamingCounter > 0 {
            formatLock.unlock()
            throw NSError(domain: "ProducerCamera", code: 3, userInfo: [NSLocalizedDescriptionKey: "Stop the receiving camera before changing orientation"])
        }
        let changed = selectedFormatIndex != index
        selectedFormatIndex = index
        _videoDescription = descriptions[index]
        _bufferPool = pools[index]
        formatLock.unlock()
        if changed {
            let state = CMIOExtensionPropertyState<AnyObject>(value: NSNumber(value: index))
            _streamSource.stream.notifyPropertiesChanged([.streamActiveFormatIndex: state])
            _streamSink.stream.notifyPropertiesChanged([.streamActiveFormatIndex: state])
        }
    }
    private var _videoDescription: CMFormatDescription!''',1)
a=s.index('        let dimensions = CMVideoDimensions(');b=s.index('        _bufferAuxAttributes =',a)
s=s[:a]+'''        var videoStreamFormats: [CMIOExtensionStreamFormat] = []
        for dimensions in [CMVideoDimensions(width: 1920, height: 1080), CMVideoDimensions(width: 1080, height: 1920)] {
            var description: CMFormatDescription?
            CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
                width: dimensions.width, height: dimensions.height, extensions: nil, formatDescriptionOut: &description)
            guard let description = description else { fatalError("Cannot create camera format") }
            var pool: CVPixelBufferPool?
            let attributes: NSDictionary = [kCVPixelBufferWidthKey: dimensions.width, kCVPixelBufferHeightKey: dimensions.height,
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferIOSurfacePropertiesKey: [CFString: CFTypeRef]()]
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes, &pool)
            guard let pool = pool else { fatalError("Cannot create camera buffer pool") }
            descriptions.append(description); pools.append(pool)
            videoStreamFormats.append(CMIOExtensionStreamFormat(formatDescription: description,
                maxFrameDuration: CMTime(value: 1, timescale: Int32(OBSCameraFrameRate)),
                minFrameDuration: CMTime(value: 1, timescale: Int32(OBSCameraFrameRate)), validFrameDurations: nil))
        }
        _videoDescription = descriptions[0]; _bufferPool = pools[0]
''' +s[b:]
s=s.replace('streamFormat: videoStreamFormat,','streamFormats: videoStreamFormats,')
s=s.replace('''        _placeholderTimer!.setEventHandler {
            if self.sinkStarted''','''        _placeholderTimer!.setEventHandler {
            self.formatLock.lock(); defer { self.formatLock.unlock() }
            if self.sinkStarted''')
s=s.replace('''            if sampleBuffer != nil {
                self.lastTimingInfo''','''            if let sampleBuffer = sampleBuffer, let image = CMSampleBufferGetImageBuffer(sampleBuffer) {
                self.formatLock.lock(); defer { self.formatLock.unlock() }
                let dimensions = CMVideoFormatDescriptionGetDimensions(self.descriptions[self.selectedFormatIndex])
                guard CVPixelBufferGetWidth(image) == dimensions.width && CVPixelBufferGetHeight(image) == dimensions.height else { return }
                self.lastTimingInfo''')
s=s.replace('sampleBuffer!,','sampleBuffer,').replace('sampleBuffer!.presentationTimeStamp','sampleBuffer.presentationTimeStamp')
# Do not replace a timer when a second consumer attaches.
s=s.replace('''        _streamingCounter += 1

        _placeholderTimer''','''        _streamingCounter += 1
        if _streamingCounter > 1 { return }

        _placeholderTimer''')
s=s.replace('''        if _streamingCounter > 1 {
            _streamingSinkCounter -= 1''','''        if _streamingSinkCounter > 1 {
            _streamingSinkCounter -= 1''')
for method in ['startStreaming()', 'stopStreaming()', 'startStreamingSink(client: CMIOExtensionClient)', 'stopStreamingSink()']:
 s=s.replace('    func '+method+' {', '    func '+method+' {\n        formatLock.lock(); defer { formatLock.unlock() }')
s=s.replace('        _streamingSinkCounter += 1\n        self.sinkStarted = true', '        _streamingSinkCounter += 1\n        if _streamingSinkCounter > 1 { return }\n        self.sinkStarted = true')
s=s.replace('        self.sinkStarted = false\n\n        if _streamingSinkCounter > 1', '        if _streamingSinkCounter > 1')
s=s.replace('            _streamingSinkCounter = 0\n            if let timer', '            _streamingSinkCounter = 0\n            self.sinkStarted = false\n            if let timer')
p.write_text(s)
for name,sink in [('OBSCameraStreamSource.swift',False),('OBSCameraStreamSink.swift',True)]:
 p=root/name;s=p.read_text().replace('private let _streamFormat: CMIOExtensionStreamFormat','private let _streamFormats: [CMIOExtensionStreamFormat]')
 s=s.replace('streamFormat: CMIOExtensionStreamFormat,','streamFormats: [CMIOExtensionStreamFormat],').replace('self._streamFormat = streamFormat','self._streamFormats = streamFormats').replace('return [_streamFormat]','return _streamFormats')
 a=s.index('    var activeFormatIndex: Int = 0 {');b=s.index('\n    var availableProperties:',a)
 s=s[:a]+'''    var activeFormatIndex: Int {
        return (device.source as! OBSCameraDeviceSource).activeFormatIndex
    }
''' +s[b:]
 s=s.replace('streamProperties.activeFormatIndex = 0','streamProperties.activeFormatIndex = activeFormatIndex')
 s=s.replace('self.activeFormatIndex = activeFormatIndex',f'try (device.source as! OBSCameraDeviceSource).selectFormat(activeFormatIndex, fromSink: {str(sink).lower()})')
 p.write_text(s)
