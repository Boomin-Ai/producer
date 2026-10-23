import assert from "node:assert/strict";
import fs from "node:fs";
const { chromium } = await import(
  process.env.PRODUCER_PLAYWRIGHT_MODULE ??
    "/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs"
);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1480, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:1436/labs/sets-v2/");
  await page
    .getByRole("heading", { name: "One audience. Different sets." })
    .waitFor();
  const data = async () =>
    JSON.parse(await page.getByTestId("public-data").textContent());
  assert.equal((await data()).audiencePoll.value.results, null);
  await page.getByRole("button", { name: "Open poll", exact: true }).click();
  for (const name of ["Vote A", "Vote A", "Vote B"])
    await page.getByRole("button", { name, exact: true }).click();
  assert.equal((await data()).audiencePoll.value.results, null);
  await page
    .getByRole("button", { name: "Portrait · 1080×1920", exact: true })
    .click();
  await page.getByRole("button", { name: "Close poll", exact: true }).click();
  await page
    .getByRole("button", { name: "Reveal results", exact: true })
    .click();
  const snapshot = (await data()).audiencePoll.value;
  assert.equal(snapshot.results.total, 3);
  assert.equal(snapshot.results.choices[0].fraction, 2 / 3);
  assert.equal(snapshot.round, 1);
  assert.equal(await page.locator('[data-scene-node="host"]').count(), 2);
  assert.equal(await page.locator('[data-scene-node="poll"]').count(), 2);
  const portraitWidth = await page
    .locator('[data-scene-node="bar0"]')
    .evaluate((el) => parseFloat(el.style.width));
  assert(Math.abs(portraitWidth - (888 * 2) / 3) < 0.01);
  await page.locator("select").selectOption("1080");
  assert.equal((await data()).audiencePoll.value.results.total, 3);
  await page
    .getByRole("button", { name: "Landscape · 1920×1080", exact: true })
    .click();
  assert.equal((await data()).audiencePoll.value.results.total, 3);
  assert(
    Math.abs(
      (await page
        .locator('[data-scene-node="bar0"]')
        .evaluate((el) => parseFloat(el.style.width))) -
        (928 * 2) / 3,
    ) < 0.01,
  );
  await page.screenshot({
    path: "docs/sets-v2/runtime-lab.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert(!JSON.stringify(await data()).includes("member-"));
  await page.getByRole("button", { name: "New round", exact: true }).click();
  assert.equal((await data()).audiencePoll.value.round, 2);
  assert.equal((await data()).audiencePoll.value.results, null);
  console.log(
    "PASS: two visual skins, hidden/revealed results, audience-state continuity across portrait/landscape/output scaling, no ballot identities, no page errors",
  );
} finally {
  await browser.close();
}
