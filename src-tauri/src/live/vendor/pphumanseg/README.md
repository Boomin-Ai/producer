PPHumanSeg from OpenCV Zoo, commit `25f423d0e04c31a17254620e58febd7386da523b`.

Model: `human_segmentation_pphumanseg_2023mar.onnx`
SHA256: `552d8a984054e59b5d773d24b9b12022b22046ceb2bbc4c9aaeaceb36a9ddf24`

Source: https://github.com/opencv/opencv_zoo/tree/25f423d0e04c31a17254620e58febd7386da523b/models/human_segmentation_pphumanseg

The included Apache 2.0 LICENSE and reference preprocessing implementation
apply. Producer uses RGB float32 NCHW, 192×192, normalized `(value/255-0.5)/0.5`.
Inference runs locally on one CPU thread. No images leave the machine.

ONNX Runtime 1.23.2's unmodified MIT-licensed C API headers live in the adjacent
onnxruntime directory. The pinned runtime and its notices are staged by
scripts/windows-cutout.ps1. Cutout quality selects mask edge refinement and
inference cadence; all Windows modes use this same segmentation network.
