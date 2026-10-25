#!/bin/bash
# Deactivation requests require the retired identifier in the requesting app.
# This bundle is never activated and its provider publishes zero devices.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PRODUCER_VCAM_EXTENSION_ID=ai.boomin.producer.portrait-camera-extension \
PRODUCER_VCAM_NAME="Producer Camera Migration" PRODUCER_VCAM_RETIRED=1 \
bash scripts/build-camera-extension.sh
