// Drives the independent browser peer against an isolated, caller-supplied fixture.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {chromium} = require("playwright-core");

async function main() {
  const [root, out, expectedRevision] = process.argv.slice(2);
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name === "") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(fs.readFileSync(path.join(__dirname, "peer.html")));
    } else if (/^(manifest\.json|production\.json|blobs\/[0-9a-f]{64})$/.test(name) &&
               fs.existsSync(path.join(root, name))) {
      res.end(fs.readFileSync(path.join(root, name)));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true});
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    const results = [];
    for (const [width,orientation] of [[320,"landscape"],[160,"landscape"],[160,"vertical"]]) {
      const result = await page.evaluate(args => window.runVector(...args),[width,orientation,expectedRevision]);
      const {document, manifest, preview, ...proof} = result;
      results.push(proof);
      fs.writeFileSync(path.join(out, orientation + "-" + width + ".png"), Buffer.from(preview.split(",")[1],"base64"));
      fs.writeFileSync(path.join(out,"production.json"),JSON.stringify(document,null,2)+"\n");
      manifest.parent = expectedRevision;
      manifest.author = "fork-editor";
      fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
    }
    fs.writeFileSync(path.join(out,"samples.json"), JSON.stringify(results,null,2));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
