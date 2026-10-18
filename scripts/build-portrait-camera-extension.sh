#!/bin/bash
# A separate vertical camera preserves existing consumers' landscape format.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PRODUCER_VCAM_EXTENSION_ID=ai.boomin.producer.portrait-camera-extension \
PRODUCER_VCAM_NAME="Producer Portrait Camera" \
VCAM_DEVICE_UUID=6D782D10-8F31-4BD0-B6B5-F171B337D328 \
VCAM_SOURCE_UUID=127B3A66-360D-433B-A738-8FC094030C6D \
VCAM_SINK_UUID=39836C0B-C01A-4E44-A66C-8FF17591E346 \
PRODUCER_VCAM_WIDTH=1080 PRODUCER_VCAM_HEIGHT=1920 \
bash scripts/build-camera-extension.sh
