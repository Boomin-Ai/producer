import assert from "node:assert/strict";
const tabs = await (await fetch("http://127.0.0.1:9337/json")).json();
const ws = new WebSocket(
  tabs.find((t) => t.type === "page").webSocketDebuggerUrl,
);
await new Promise((resolve) =>
  ws.addEventListener("open", resolve, { once: true }),
);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const rect = (label) =>
  evaluate(
    `(()=>{const e=document.querySelector('[aria-label="${label}"]'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,w:r.width,h:r.height,padding:s.padding,border:s.borderWidth};})()`,
  );
const mouse = (type, x, y) =>
  call("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
try {
  await call("Page.navigate", {
    url: "http://127.0.0.1:1420/scripts/dj-slider-browser.html",
  });
  for (let n = 0; n < 100; n++) {
    if (await evaluate('!!document.querySelector(".dj-slider")')) break;
    await sleep(50);
  }
  const r = await rect("Level");
  assert.equal(r.padding, "0px");
  assert.equal(r.border, "0px");
  assert.ok(r.w > 40 && r.w < 100);
  for (const [fraction, expected] of [
    [1, 1],
    [0, 0],
  ]) {
    const x = r.x + Math.max(1, Math.min(r.w - 1, r.w * fraction)),
      y = r.y + r.h / 2;
    await mouse("mousePressed", x, y);
    await mouse("mouseMoved", x, y);
    await mouse("mouseReleased", x, y);
    await sleep(450);
    assert.equal(
      await evaluate(
        'Number(document.querySelector("[aria-label=Level]").getAttribute("aria-valuenow"))',
      ),
      expected,
      "level endpoint",
    );
  }
  await mouse("mousePressed", r.x + 6, r.y + r.h / 2);
  for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
    await mouse("mouseMoved", r.x + 6 + (r.w - 12) * fraction, r.y + r.h / 2);
    const current = await evaluate(
      'Number(document.querySelector("[aria-label=Level]").getAttribute("aria-valuenow"))',
    );
    assert.ok(
      Math.abs(current - fraction) < 0.02,
      `thumb did not follow pointer: ${current}`,
    );
  }
  await mouse("mouseReleased", r.x + r.w - 6, r.y + r.h / 2);
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Home",
    code: "Home",
    windowsVirtualKeyCode: 36,
  });
  assert.equal(
    await evaluate(
      'Number(document.querySelector("[aria-label=Level]").getAttribute("aria-valuenow"))',
    ),
    0,
  );
  const s = await rect("Seek"),
    x = s.x + s.w * 0.85,
    y = s.y + s.h / 2;
  await mouse("mousePressed", x, y);
  await mouse("mouseMoved", x, y);
  await sleep(500);
  assert.ok(
    await evaluate(
      'Number(document.querySelector("[aria-label=Seek]").getAttribute("aria-valuenow"))>200000',
    ),
    "playback poll moved drag",
  );
  assert.equal(
    await evaluate("window.seeks.length"),
    0,
    "seek fired during drag",
  );
  await mouse("mouseReleased", x, y);
  await sleep(450);
  assert.equal(
    await evaluate("window.seeks.length"),
    1,
    "seek should commit once",
  );
  assert.ok(await evaluate("window.seeks[0]>200000"), "wrong seek target");
  await call("Page.navigate", {
    url: "http://127.0.0.1:1420/scripts/dj-browser.html",
  });
  let result = "";
  for (let n = 0; n < 150; n++) {
    result = await evaluate(
      'document.getElementById("result")?.textContent||""',
    );
    if (result.startsWith("PASS:") || result.startsWith("FAIL:")) break;
    await sleep(40);
  }
  assert.ok(result.startsWith("PASS:"), result);
  console.log(
    "PASS: actual pointer drags reach 0/100%, zero slider insets, stable drag through playback polls, one seek on release.",
  );
  console.log(result);
} finally {
  ws.close();
}
