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
replace('activationRequestForExtension:@"com.obsproject.obs-studio.mac-camera-extension"',
        'activationRequestForExtension:(vcam->portrait ? @"ai.boomin.producer.portrait-camera-extension" : @"com.obsproject.obs-studio.mac-camera-extension")')
replace('    vcam->output = output;\n',
        '    vcam->output = output;\n    vcam->portrait = obs_data_get_bool(settings, "portrait");\n')
replace('static bool producer_vcam_device_present(void)',
        'static bool producer_vcam_device_present(bool portrait)')
replace('CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75")',
        '(portrait ? CFSTR("6D782D10-8F31-4BD0-B6B5-F171B337D328") : CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75"))')
replace('producer_vcam_device_present())', 'producer_vcam_device_present(vcam->portrait))')
replace('@"7626645E-4425-469E-9D8B-97E0FA59AC75";',
        '(vcam->portrait ? @"6D782D10-8F31-4BD0-B6B5-F171B337D328" : @"7626645E-4425-469E-9D8B-97E0FA59AC75");')
replace('    vcam->videoInfo.output_width = 1920;\n    vcam->videoInfo.output_height = 1080;', '''    if (vcam->portrait && (uint64_t) selected->width * 16 != (uint64_t) selected->height * 9) {
        obs_output_set_last_error(vcam->output, "Choose Producer's Portrait output before starting the portrait camera.");
        return false;
    }
    vcam->videoInfo.output_width = vcam->portrait ? 1080 : 1920;
    vcam->videoInfo.output_height = vcam->portrait ? 1920 : 1080;''')
# Match the portrait extension's advertised pixel format as well as its size.
replace('    vcam->videoInfo.output_format = selected->format;',
        '    vcam->videoInfo.output_format = vcam->portrait ? VIDEO_FORMAT_BGRA : selected->format;')
path.write_text(s)
