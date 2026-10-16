// Real browser worklet smoke, generated tone only, no microphone/SFU/voice file.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const server=http.createServer(async(req,res)=>{
 if(req.url==='/voice-review-worklet.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('./voice-review-worklet.js',import.meta.url)));}
 else res.end('<title>Silent recorder graph test</title>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const context=new AudioContext({sampleRate:48000});await context.audioWorklet.addModule('/voice-review-worklet.js');await context.resume();
  const capture=new AudioWorkletNode(context,'voice-review',{numberOfInputs:1,numberOfOutputs:1,channelCount:1,channelCountMode:'explicit',outputChannelCount:[1],processorOptions:{limitSamples:48000}});
  const oscillator=context.createOscillator();oscillator.frequency.value=997;
  const gain=context.createGain();gain.gain.value=0.25;oscillator.connect(gain);gain.connect(capture);
  const analyser=context.createAnalyser();capture.connect(analyser);analyser.connect(context.destination);
  let samples=0,peak=0,chunks=0;
  const finished=new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('Worklet timeout')),5000);
   capture.port.onmessage=event=>{
    if(event.data.kind==='pcm'){samples+=event.data.pcm.length;chunks++;for(const n of event.data.pcm)peak=Math.max(peak,Math.abs(n));}
    else {clearTimeout(timeout);resolve(event.data);}
   };
  });
  oscillator.start();const outcome=await finished;const output=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(output);
  oscillator.stop();capture.disconnect();await context.close();
  return {outcome,samples,peak,chunks,outputPeak:Math.max(...output.map(Math.abs))};
 });
 assert.equal(result.outcome.error,null);assert.equal(result.samples,48000);assert.equal(result.outcome.rate,48000);assert.ok(result.peak>7000);assert.equal(result.outputPeak,0);
 console.log(JSON.stringify({test:'real-browser-decoded-capture-generated-tone',...result,microphone_used:false,voice_recorded:false}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
