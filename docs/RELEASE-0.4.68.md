# Producer v0.4.68

Apple Silicon cutout now copies the current camera analysis frame asynchronously on the Metal command queue before Apple Vision inference. Local M1 preview tests reduced sampled mask input age from approximately 67 ms to 34 ms while maintaining approximately 30 mask updates per second.

Cutout adds Auto, Fast, Balanced and Accurate quality choices and an Edge refinement slider. New/unspecified refinement settings default to 0.65; existing explicit settings are preserved. Zero disables refinement. Image-guided upsampling refines mask edges, with erosion adjusted toward the finer grid to preserve thin features. Higher-resolution Accurate masks retain their original detail.

Validation: matched live native preview measurements, 60 real-GPU asynchronous handoff checks, real Metal shader confidence/edge/thin-feature checks, frontend build, native build and bundle signature checks. The user confirmed responsive preview and generally good cutout appearance. These checks do not establish universal hair/matte accuracy or four-camera/recording performance. See [cutout lab notes](CUTOUT-VISION-LAB.md).

Apple Silicon builds include the updated engine and follow Developer ID signing, notarization and stapling. Windows keeps its existing Live engine; Intel macOS and Linux retain engine-less builds. Previous-frame scheduling remains available when the renderer lacks the optional API or `PRODUCER_CUTOUT_CURRENT_FRAME=0` is set. Diagnostic logs remain opt-in.
