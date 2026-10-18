"""Patch only the temporary copy of the pinned OBS camera plugin."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
s = path.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, f"Virtual camera source changed: {old[:90]}"
    s = s.replace(old, new, 1)

replace('    bool running;\n', '    bool running;\n    bool portrait;\n')
replace('    vcam->output = output;\n',
        '    vcam->output = output;\n    vcam->portrait = obs_data_get_bool(settings, "portrait");\n')
replace('static bool producer_vcam_device_present(void)',
        'static bool producer_vcam_device_present(bool portrait)')
replace('CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75")',
        '(portrait ? CFSTR("6D782D10-8F31-4BD0-B6B5-F171B337D328") : CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75"))')
replace('producer_vcam_device_present())', 'producer_vcam_device_present(false))')
replace('@"7626645E-4425-469E-9D8B-97E0FA59AC75";',
        '@"7626645E-4425-469E-9D8B-97E0FA59AC75";')
replace('    vcam->videoInfo.output_width = 1920;\n    vcam->videoInfo.output_height = 1080;', '''    if (vcam->portrait && (uint64_t) selected->width * 16 != (uint64_t) selected->height * 9) {
        obs_output_set_last_error(vcam->output, "Choose Producer's Portrait output before starting the portrait camera.");
        return false;
    }
    vcam->videoInfo.output_width = vcam->portrait ? 1080 : 1920;
    vcam->videoInfo.output_height = vcam->portrait ? 1920 : 1080;''')
# Both CMIO devices advertise BGRA. A stable four-channel format also lets
# live mirroring switch without renegotiating or restarting the camera.
replace('    vcam->videoInfo.output_format = selected->format;',
        '    vcam->videoInfo.output_format = VIDEO_FORMAT_BGRA;')
replace('#include <obs-module.h>', '#include <obs-module.h>\n#include "virtualcam-mirror.h"')
replace('    bool portrait;\n', '    bool portrait;\n    int32_t mirrored;\n')
replace('    vcam->portrait = obs_data_get_bool(settings, "portrait");\n',
        '    vcam->portrait = obs_data_get_bool(settings, "portrait");\n    __atomic_store_n(&vcam->mirrored, obs_data_get_bool(settings, "mirrored"), __ATOMIC_RELAXED);\n')
replace('static bool virtualcam_output_start(void *data)', """static void virtualcam_output_update(void *data, obs_data_t *settings)
{
    struct virtualcam_data *vcam = (struct virtualcam_data *) data;
    __atomic_store_n(&vcam->mirrored, obs_data_get_bool(settings, "mirrored"), __ATOMIC_RELAXED);
}

static bool virtualcam_output_start(void *data)""")
replace('    if (planeCount == 0) {', """    if (planeCount == 0 && __atomic_load_n(&vcam->mirrored, __ATOMIC_RELAXED)) {
        vImage_Error reflected = producer_mirror_bgra(frame->data[0], frame->linesize[0],
            CVPixelBufferGetBaseAddress(frameRef), CVPixelBufferGetBytesPerRow(frameRef),
            CVPixelBufferGetWidth(frameRef), CVPixelBufferGetHeight(frameRef));
        if (reflected != kvImageNoError) {
            CVPixelBufferUnlockBaseAddress(frameRef, 0);
            CVPixelBufferRelease(frameRef);
            return;
        }
    } else if (planeCount == 0) {""")
replace('    .raw_video = virtualcam_output_raw_video,',
        '    .raw_video = virtualcam_output_raw_video,\n    .update = virtualcam_output_update,')
# Retire the old portrait device using the supported macOS deactivation API.
# A separate delegate must not change activation state of the surviving camera.
replace('static bool virtualcam_output_start(void *data)', """@interface ProducerRetiredCameraDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end
@implementation ProducerRetiredCameraDelegate
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request
    actionForReplacingExtension:(OSSystemExtensionProperties *)existing withExtension:(OSSystemExtensionProperties *)ext
{ return OSSystemExtensionReplacementActionReplace; }
- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error
{ blog(LOG_WARNING, "Retired portrait camera cleanup: %s", error.localizedDescription.UTF8String); }
- (void)request:(OSSystemExtensionRequest *)request didFinishWithResult:(OSSystemExtensionRequestResult)result
{ blog(LOG_INFO, "Retired portrait camera cleanup result: %ld", (long) result); }
- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request
{ blog(LOG_INFO, "macOS approval required to remove the retired portrait camera."); }
@end
static void producer_retire_portrait_camera(void)
{
    if (!producer_vcam_device_present(true)) return;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        dispatch_async(dispatch_get_main_queue(), ^{
            static ProducerRetiredCameraDelegate *delegate = [ProducerRetiredCameraDelegate new];
            OSSystemExtensionRequest *request = [OSSystemExtensionRequest
                deactivationRequestForExtension:@"ai.boomin.producer.portrait-camera-extension" queue:dispatch_get_main_queue()];
            request.delegate = delegate;
            [[OSSystemExtensionManager sharedManager] submitRequest:request];
        });
    });
}
static bool virtualcam_output_start(void *data)""")
# The selected canvas changes the sink format on the existing camera device.
# Verify readback so an older installed extension cannot silently distort frames.
replace('        OSStatus result = CMIODeviceStartStream(vcam->deviceID, vcam->streamID);', """        CMIOObjectPropertyAddress formatAddress = {kCMIOStreamPropertyFormatDescription,
            kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
        OSStatus formatResult = CMIOObjectSetPropertyData(vcam->streamID, &formatAddress, 0, NULL,
            sizeof(vcam->formatDescription), &vcam->formatDescription);
        CMFormatDescriptionRef actualFormat = NULL;
        UInt32 actualSize = sizeof(actualFormat);
        OSStatus readResult = CMIOObjectGetPropertyData(vcam->streamID, &formatAddress, 0, NULL,
            actualSize, &actualSize, &actualFormat);
        CMVideoDimensions actualDimensions = actualFormat ? CMVideoFormatDescriptionGetDimensions(actualFormat) : CMVideoDimensions{0, 0};
        if (actualFormat) CFRelease(actualFormat);
        if (formatResult != noErr || readResult != noErr ||
            actualDimensions.width != vcam->videoInfo.output_width || actualDimensions.height != vcam->videoInfo.output_height) {
            obs_output_set_last_error(vcam->output, "Allow Producer's camera extension update in macOS, then reconnect the camera using the selected orientation.");
            return false;
        }
        producer_retire_portrait_camera();
        OSStatus result = CMIODeviceStartStream(vcam->deviceID, vcam->streamID);""")
path.write_text(s)
