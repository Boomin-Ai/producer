import assert from "node:assert/strict";
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const base = "http://127.0.0.1:1420";
try {
  await page.goto(`${base}/scripts/dj-slider-browser.html`);
  const level = page.getByRole("slider", { name: "Level", exact: true });
  const r = await level.boundingBox();
  await page.mouse.move(r.x + 6, r.y + r.height / 2);
  await page.mouse.down();
  for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const x = r.x + 6 + (r.width - 12) * fraction;
    await page.mouse.move(x, r.y + r.height / 2);
    assert.ok(
      Math.abs(Number(await level.getAttribute("aria-valuenow")) - fraction) <
        0.02,
    );
    const thumb = await level.locator(".dj-slider-thumb").boundingBox();
    assert.ok(
      Math.abs(thumb.x + thumb.width / 2 - x) < 1,
      "visible thumb does not follow pointer",
    );
  }
  await page.mouse.up();
  await level.press("Home");
  assert.equal(await level.getAttribute("aria-valuenow"), "0");
  await level.press("End");
  assert.equal(await level.getAttribute("aria-valuenow"), "1");
  const seek = page.getByRole("slider", { name: "Seek", exact: true });
  const s = await seek.boundingBox();
  await page.mouse.move(s.x + s.width * 0.8, s.y + s.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.seeks.length), 0);
  assert.ok(Number(await seek.getAttribute("aria-valuenow")) > 190000);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.seeks.length), 1);
  console.log(
    "PASS: WebKit pointer movement, visible thumb position, endpoints, keyboard and seek commits.",
  );
  await page.goto(`${base}/scripts/dj-browser.html?design`);
  await page.waitForSelector(".dj-deck");
  for (const [width, dock, mini] of [
    [200, "left", false],
    [240, "right", false],
    [400, "left", false],
    [600, "bottom", false],
    [900, "bottom", false],
    [240, "top", true],
    [700, "top", true],
  ]) {
    await page.evaluate(
      ([w, d, m]) => window.renderDJ(w, d, m),
      [width, dock, mini],
    );
    await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".rm-panel-dj");
      const content = document.querySelector(".dj-panel,.dj-mini");
      const bounds = panel.getBoundingClientRect();
      const overflowing = [
        ...content.querySelectorAll(
          "button,[role=slider],select,input,.dj-deck",
        ),
      ]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            (r.right > bounds.right + 1 || r.left < bounds.left - 1)
          );
        })
        .map(
          (e) => e.getAttribute("aria-label") || e.className || e.textContent,
        );
      return {
        scroll: content.scrollWidth,
        width: content.clientWidth,
        overflowing,
      };
    });
    assert.ok(
      geometry.scroll <= geometry.width + 1,
      `${width}/${dock}: horizontal overflow ${JSON.stringify(geometry)}`,
    );
    assert.deepEqual(
      geometry.overflowing,
      [],
      `${width}/${dock}: clipped controls`,
    );
  }
  await page.evaluate(() => window.renderDJ(240, "left", false));
  await page.waitForSelector(".deck-a .dj-platter img");
  assert.equal(
    await page
      .locator(".deck-a .dj-platter img")
      .evaluate((e) => getComputedStyle(e).animationPlayState),
    "running",
  );
  assert.equal(
    await page
      .locator(".deck-b .dj-platter img")
      .evaluate((e) => getComputedStyle(e).animationPlayState),
    "paused",
  );
  await page
    .locator(".deck-a")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".deck-a .dj-platter img"))
        .animationPlayState === "paused",
  );
  await page.evaluate(() => window.renderDJ(900, "bottom", false));
  await page.waitForSelector(".dj-tracklist");
  await page.evaluate(() => {
    document.querySelector(".rm-panel-dj").style.height = "280px";
  });
  assert.equal(
    await page.locator('[aria-label="Search tracks"]').count(),
    0,
    "search should start collapsed",
  );
  await page.getByRole("button", { name: "Find a track", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search tracks" });
  await search.fill("712PM");
  await page.waitForFunction(
    () => document.querySelectorAll(".dj-track").length === 1,
  );
  await search.press("Escape");
  await page.waitForFunction(
    () => document.querySelectorAll(".dj-track").length > 50,
  );
  assert.equal(await page.locator('[aria-label="Search tracks"]').count(), 0);
  await page.locator(".deck-b .dj-track-info strong").click();
  assert.equal(
    await page
      .getByRole("button", { name: "Select deck B", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  const callsBefore = await page.evaluate(() => window.djCalls.length);
  await page.locator(".dj-track-title").first().click();
  await page.waitForFunction(() =>
    document.querySelector(".deck-b strong")?.textContent.includes("712PM"),
  );
  const commands = await page.evaluate(
    (n) => window.djCalls.slice(n),
    callsBefore,
  );
  assert.ok(
    commands.some((a) => a.kind === "load" && a.deck === 1),
    "track did not load selected deck B",
  );
  assert.ok(
    !commands.some((a) => a.kind === "play"),
    "loading selected deck unexpectedly started music",
  );
  await page.getByRole("button", { name: "Mix", exact: true }).click();
  await page.getByRole("button", { name: "Mix", exact: true }).click();
  const fader = page.getByRole("slider", { name: "Crossfader", exact: true });
  assert.equal(
    await fader.getAttribute("aria-valuenow"),
    "0.5",
    "Mix did not start at center",
  );
  await page
    .locator(".deck-a")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".deck-a .dj-platter")
      .classList.contains("spinning"),
  );
  assert.equal(
    await fader.getAttribute("aria-valuenow"),
    "0.5",
    "Play moved the Mix balance",
  );
  assert.equal(
    await fader
      .locator(".dj-slider-fill")
      .evaluate((e) => getComputedStyle(e).display),
    "none",
    "crossfader still looks like a progress bar",
  );
  const volume = page.locator('.dj-master-volume [role="slider"]');
  assert.equal(await volume.getAttribute("aria-orientation"), "vertical");
  const vr = await volume.boundingBox();
  await page.mouse.move(vr.x + vr.width / 2, vr.y + vr.height - 6);
  await page.mouse.down();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const y = vr.y + vr.height - 6 - (vr.height - 12) * fraction;
    await page.mouse.move(vr.x + vr.width / 2, y);
    assert.ok(
      Math.abs(Number(await volume.getAttribute("aria-valuenow")) - fraction) <
        0.02,
      "vertical volume drag value",
    );
    const thumb = await volume.locator(".dj-slider-thumb").boundingBox();
    assert.ok(
      Math.abs(thumb.y + thumb.height / 2 - y) < 1,
      "vertical volume thumb did not follow pointer",
    );
  }
  await page.mouse.up();
  const deckBounds = await page.locator(".dj-console").boundingBox();
  const libraryBounds = await page.locator(".dj-library").boundingBox();
  assert.ok(
    vr.x + vr.width < deckBounds.x && vr.x < libraryBounds.x,
    "volume is not at the far left",
  );
  const list = page.locator(".dj-tracklist");
  const position = await page.locator(".deck-a").boundingBox();
  const bounds = await list.boundingBox();
  assert.ok(
    await list.evaluate((e) => e.scrollHeight > e.clientHeight),
    "library has no independent scroll area",
  );
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.wheel(0, 450);
  await page.waitForFunction(
    () => document.querySelector(".dj-tracklist").scrollTop > 0,
  );
  const after = await page.locator(".deck-a").boundingBox();
  assert.equal(position.y, after.y, "library scroll moved decks");
  assert.equal(
    await page.locator(".dj-panel").evaluate((e) => e.scrollTop),
    0,
    "library scroll moved entire panel",
  );
  console.log(
    "PASS: collapsed search/filter/reset, selected deck loads paused, centered crossfader preserved, vertical volume follows drag at far left, independent library scroll.",
  );
  console.log(
    "PASS: side/bottom/mini docks at 200–900px without clipped controls; cover spins only while playing.",
  );
} finally {
  await browser.close();
}
