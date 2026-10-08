const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ?? 'playwright');
import assert from 'node:assert/strict';
const b=await chromium.launch({channel:'chrome'});const p=await b.newPage({viewport:{width:1500,height:500}});
await p.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN ?? 'http://localhost:1420'}/scripts/presentation-browser.html?dock=bottom&constrained`);
await p.getByRole('button',{name:'Set settings',exact:true}).click();await p.getByLabel('Choose set').selectOption('head-to-head');await p.keyboard.press('Escape');
await p.locator('main').evaluate(el=>el.classList.add('rm-dock-bottom','slim'));
const bar=p.getByLabel('Compact show controls');await bar.getByRole('button',{name:'Start show',exact:true}).click();
await bar.getByRole('button',{name:'Pause',exact:true}).click();await bar.getByRole('button',{name:'Resume',exact:true}).click();await bar.getByRole('button',{name:'Next',exact:true}).click();
await bar.getByRole('button',{name:'Close voting',exact:true}).click();assert(await bar.getByRole('button',{name:'Reopen voting',exact:true}).isVisible());await bar.getByRole('button',{name:'Stop run',exact:true}).click();assert(await bar.getByRole('button',{name:'Start show',exact:true}).isVisible());await b.close();console.log('PASS: compact bar starts rehearsal, pauses/resumes, advances segments, closes voting and stops.');
