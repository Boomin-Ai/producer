import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const engine=process.argv.includes('--webkit')?webkit:chromium;
const b=await engine.launch(engine===chromium?{channel:'chrome',headless:true}:{});
try{
const p=await b.newPage({viewport:{width:1400,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto('http://127.0.0.1:1420/scripts/json-ui-test.html');const frame=p.frameLocator('iframe').first();await frame.locator('[data-node$="/host-camera"]').waitFor();
assert.equal(await frame.locator('[data-node$="/title"]').evaluate(el=>getComputedStyle(el).letterSpacing),'-1.5px');
const material=await frame.locator('[data-node$="/material-light"]').evaluate(el=>({filter:getComputedStyle(el).filter,blend:getComputedStyle(el).mixBlendMode,clip:getComputedStyle(el).clipPath}));assert.equal(material.filter,'blur(16px)');assert.equal(material.blend,'screen');assert.match(material.clip,/ellipse/);
await p.getByRole('button',{name:'Start show',exact:true}).first().click();await p.waitForTimeout(1600);
assert.equal(await frame.locator('canvas[data-effect="aurora"]').count(),1);assert.ok(await frame.locator('svg').count()>0);
await p.locator('.set-preview').first().screenshot({path:'/private/tmp/'+engine.name()+'-json-ui-motion-landscape.png'});
await p.getByRole('button',{name:'Warm color wash',exact:true}).first().click();await frame.locator('[data-node$="/warm-atmosphere"]').waitFor();assert.equal(await frame.locator('[data-node$="/cool-atmosphere"]').count(),0);
await p.getByRole('button',{name:'Circle cameras',exact:true}).first().click();const radius=await frame.locator('[data-node$="/host-camera"]').evaluate(el=>getComputedStyle(el).borderRadius);assert.notEqual(radius,'24px');
await p.getByRole('button',{name:'Hide names',exact:true}).first().click();assert.equal(await frame.locator('[data-node$="/name-0"]').count(),0);
await p.getByRole('button',{name:'Hide screen',exact:true}).first().click();assert.equal(await frame.locator('[data-node$="/screen-source"]').count(),0);
await p.getByRole('button',{name:'Play media',exact:true}).first().click();await p.waitForTimeout(400);assert.equal(await frame.locator('video').evaluate(el=>el.paused),false);
await p.getByRole('button',{name:'Show names',exact:true}).first().click();await p.getByRole('button',{name:'Show screen',exact:true}).first().click();await p.getByRole('button',{name:'Rectangle cameras',exact:true}).first().click();
await p.getByRole('button',{name:'Studio · portrait',exact:true}).first().click();await p.waitForTimeout(1000);await p.locator('.set-preview').first().screenshot({path:'/private/tmp/'+engine.name()+'-json-ui-motion-portrait.png'});
await p.getByRole('button',{name:'Next',exact:true}).first().click();await p.waitForTimeout(1000);assert.equal(await p.getByTestId('phase').textContent(),'audience');
await p.getByRole('button',{name:'Vote Creative tools',exact:true}).click();await p.getByRole('button',{name:'React 🔥',exact:true}).click();await p.getByRole('button',{name:'New participant',exact:true}).click();await p.getByRole('button',{name:'Vote Creative tools',exact:true}).click();await p.getByRole('button',{name:'Close voting',exact:true}).first().click();await p.getByRole('button',{name:'Reveal result',exact:true}).first().click();
assert.equal(await frame.locator('[data-node$="/votes-total"]').textContent(),'2');assert.match(await frame.locator('[data-node$="/result-text"]').textContent(),/Creative tools/);
await p.locator('.set-preview').first().screenshot({path:'/private/tmp/'+engine.name()+'-json-ui-audience-landscape.png'});await p.getByRole('button',{name:'Audience · portrait',exact:true}).first().click();await p.waitForTimeout(1000);await p.locator('.set-preview').first().screenshot({path:'/private/tmp/'+engine.name()+'-json-ui-audience-portrait.png'});
assert.deepEqual(errors,[]);console.log('PASS four rendered layouts, shaders, Lottie, conditional cameras/names/screen, media playback, votes/reactions/reveal.');
}finally{await b.close();}
