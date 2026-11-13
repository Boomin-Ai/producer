import {useRef, useState} from 'react';
import type {SetOutputControls} from './useSetOutput';
import {SetSourceCreator} from './SetSourceCreator';
import {sourceRecoveries, type SourceRecovery} from './sourceRecovery';
import type {PresentationPackage} from './schema';

export function SetSourceRecovery({slots,output,names,blocked=false,issues:provided,compact=false,retryLayouts}: {slots:PresentationPackage['set']['slots'];output:SetOutputControls;names:Record<string,string>;blocked?:boolean;issues?:SourceRecovery[];compact?:boolean;retryLayouts?:readonly string[]}) {
  const issues = provided??sourceRecoveries(slots,output.bindings,output.sources);
  const [choices,setChoices] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const working = useRef(false);
  const reconnect = async (issue:SourceRecovery,source:string) => {
    if (working.current || blocked || output.busy) return;
    working.current=true;setBusy(true);setError('');
    try {
      // One removed source may be shared by several orientations or slot roles.
      for (const slot of issue.slots) output.bind(slot.id,source);
      output.retryPreparation?.(retryLayouts);
      // Respect an intentional room-scene selection. Retry only an existing
      // on-air Set or a failed explicit Show set attempt.
      if (output.active || output.error) await output.apply();
    } catch (e) { setError(String(e)); }
    finally {working.current=false;setBusy(false);}
  };
  if (!issues.length) return null;
  return <section className={`set-source-recovery${compact?' is-compact':''}`} aria-label={compact?'Choose Set sources':'Reconnect Set sources'}>
    {!compact&&<div><strong>Reconnect {issues.length === 1 ? 'a source' : 'sources'}</strong><p>This Set uses {issues.length === 1 ? 'a source that was' : 'sources that were'} removed. Choose {issues.length === 1 ? 'its replacement' : 'their replacements'} to restore the affected layouts.</p></div>}
    {issues.map(issue => {
      const selected = issue.candidates.some(item=>item.id === choices[issue.sourceId]) ? choices[issue.sourceId] : issue.suggested?.id ?? '';
      const label = issue.slots.map(slot=>slot.label).join(' / ');
      const name = issue.candidates.find(item=>item.id === selected);
      return <div key={issue.sourceId} className="set-source-recovery-item">
        <label>{label}<select aria-label={`Replacement for ${label}`} value={selected} disabled={blocked||busy||output.busy} onChange={event=>setChoices(old=>({...old,[issue.sourceId]:event.target.value}))}>
          <option value="">Choose a room source…</option>
          {issue.candidates.map(item=><option key={item.id} value={item.id}>{names[item.id]??item.label}{!item.has_frame?' · starting…':''}</option>)}
        </select></label>
        <button type="button" disabled={!selected||blocked||busy||output.busy} onClick={()=>void reconnect(issue,selected)}>{busy?'Reconnecting…':name?`Use ${names[name.id]??name.label}`:'Reconnect'}</button>
        {!blocked&&!busy&&!output.busy&&output.createSource&&<SetSourceCreator slot={issue.slots[0].id} label={issue.slots[0].label} create={async(slot,spec,label)=>{
          const id=await output.createSource!(slot,spec,label,false);
          if(id)await reconnect(issue,id);
          return id;
        }}/>}
      </div>;
    })}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
