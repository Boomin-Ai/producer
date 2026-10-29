import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {OperatorPanel} from '../../../shared/set-runtime/OperatorPanel';
import {moduleCall} from './moduleConnections';
import {RoomSetController} from './roomSetController';
import {CommittedField} from './CommittedField';
import '../../../shared/set-runtime/panels.css';

export function RoomSetControls({endpoint,room}:{endpoint:string;room:string}){
 const controller=useMemo(()=>new RoomSetController(endpoint,room,(method,suffix,body)=>moduleCall(endpoint,room,method,suffix,body)),[endpoint,room]);
 const state=useSyncExternalStore(controller.subscribe,controller.snapshot);
 useEffect(()=>{controller.start();return()=>controller.close();},[controller]);
 const locked=state.status!=='ready'||state.pending,show=state.snapshot?.control?.show,catalog=state.control;
 const run=(op:Parameters<typeof controller.control>[0],input?:Parameters<typeof controller.control>[1])=>{void controller.control(op,input).catch(()=>{});};
 return <section className="module-operator-panel" aria-label="Remote Set controls">
  <h3>Set controls</h3>
  <p role="status">{state.status==='loading'?'Connecting to room…':state.status==='empty'?'No Set is installed in this room.':state.pending?'Sending command…':state.committed!==undefined?`Committed · revision ${state.committed}.${state.outputFailures?.program&&(state.outputFailures.program.revision>=state.committed)?' Program output failed.':(state.presented?.program?.revision??-1)<state.committed?' Program confirmation pending.':''}`:state.status==='ready'?'Connected to room controls.':''}</p>
  {state.error&&<p role="alert">{state.error} <button onClick={()=>void controller.refresh()}>Reconnect</button></p>}
  {Object.entries(state.presented??{}).map(([output,receipt])=><p key={output}>Last confirmed {output} output: revision {receipt.revision}</p>)}
  {Object.entries(state.outputFailures??{}).map(([output,receipt])=><p key={`failure:${output}`} role="alert">{output==='program'?'Program':'Portrait'} output failed during {receipt.stage==='prepare'?'preparation':'rendering'} at revision {receipt.revision}. {receipt.error} {state.presented?.[receipt.output]?`Last confirmed frame remains revision ${state.presented[receipt.output]!.revision}.`:'No successful output confirmation has arrived.'}</p>)}
  {catalog&&state.snapshot?.control&&<article className="module-operator-card">
   <label>Layout<select disabled={locked} value={state.snapshot.control.layoutId} onChange={e=>run('layout.select',{layoutId:e.target.value})}>{catalog.layouts.map(id=><option key={id} value={id}>{id.replace(/-/g,' ')}</option>)}</select></label>
   {Object.entries(catalog.fields??{}).map(([key,field])=><CommittedField key={key} label={field.label??key} field={field} value={state.snapshot?.control?.values?.[key]??field.default} disabled={state.status!=='ready'} pending={state.pending} onApply={value=>controller.control('field.set',{key,value})}/>)}
   {catalog.show&&show&&<><p>Segment: {show.phase} · {show.status}</p><div className="module-operator-actions">
    <button disabled={locked||show.status!=='stopped'} onClick={()=>run('show.start')}>Start</button>
    <button disabled={locked||show.status==='stopped'} onClick={()=>run(show.status==='paused'?'show.resume':'show.pause')}>{show.status==='paused'?'Resume':'Pause'}</button>
    <button disabled={locked||show.status!=='running'||!catalog.show.phases.some(p=>p.next===show.phase)} onClick={()=>run('show.previous')}>Previous</button>
    <button disabled={locked||show.status!=='running'||!catalog.show.phases.find(p=>p.id===show.phase)?.next} onClick={()=>run('show.next')}>Next</button>
    <button disabled={locked||show.status==='stopped'} onClick={()=>run('show.stop')}>Stop</button>
   </div></>}
  </article>}
  {state.status==='ready'&&!catalog&&<p>Shared layouts and Show navigation are not enabled for this Set. Its module controls are available below.</p>}
  {state.definition&&state.snapshot&&<OperatorPanel definition={state.definition} snapshot={state.snapshot} segment={show?.phase??state.definition.instances.find(i=>i.owner==='segment'&&state.snapshot?.modules[i.id]?.mounted)?.segment} disabled={locked} send={controller.sendModule} requestAgent={controller.queryModule} searchWeatherLocations={controller.searchWeatherLocations}/>}
 </section>;
}
