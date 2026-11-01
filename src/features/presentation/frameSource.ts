import lottie from './vendor/lottie-light.js?raw';
import frame from './frame.js?raw';
import chartPreview from './chart-preview.js?raw';
import scene3dRenderer from './vendor/scene3d-renderer.js?raw';
import shaderKernel from './shader-kernel.glsl?raw';
import shaderPreview from './shader-preview.js?raw';

/** Same isolated document for visible previews and offscreen authoring checks. */
export function previewFrameSource(){
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: http://127.0.0.1:*; media-src data: http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#100f15;font-family:system-ui,sans-serif}*{box-sizing:border-box}#canvas{position:absolute;transform-origin:top left;overflow:hidden}div.slot{display:flex;align-items:center;justify-content:center;color:#b6aebd;font-size:20px}</style><style id="motion"></style></head><body><div id="canvas"></div><script nonce="${nonce}">const PRODUCER_SHADER_KERNEL=${JSON.stringify(shaderKernel)};\n${chartPreview}\n${shaderPreview}\n${lottie}\n${scene3dRenderer}\n${frame}</script></body></html>`;
}
