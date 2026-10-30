import {useEffect,useRef,useState} from 'react';
import type {ControlField} from '../../../shared/set-runtime/control';
import {validateControlValue} from '../../../shared/set-runtime/control';
import type {Scalar} from '../../../shared/set-runtime/contract';

/** Typing is a private draft. Only Apply submits an authoritative room command. */
export function CommittedField({label,field,value,disabled=false,pending=false,onApply}:{label:string;field:ControlField;value:Scalar;disabled?:boolean;pending?:boolean;onApply:(value:Scalar)=>boolean|void|Promise<unknown>}){
 const [draft,setDraft]=useState(String(value)),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false);
 const previous=useRef(value),submitted=useRef<string|undefined>(undefined);
 useEffect(()=>{const old=String(previous.current);previous.current=value;setDraft(text=>text===old||text===submitted.current?String(value):text);},[value]);
 let next:Scalar=field.type==='boolean'?draft==='true':field.type==='number'?Number(draft):draft,valid=true;
 try{if(field.type==='number'&&!draft.trim())throw Error();validateControlValue(field,next);}catch{valid=false;}
 const dirty=draft!==String(value);
 const apply=async()=>{if(disabled||pending||submitting||!dirty||!valid)return;submitted.current=draft;setSubmitting(true);setError('');try{if(await onApply(next)===false)throw Error('The room did not accept this edit.');}catch(e){setError(e instanceof Error?e.message:'The field could not be updated.');}finally{setSubmitting(false);}};
 return <div className="set-committed-field"><label>{label}{field.type==='boolean'?<input type="checkbox" aria-label={label} checked={draft==='true'} disabled={disabled} onChange={e=>setDraft(String(e.target.checked))}/>:<input aria-label={label} type={field.type==='number'?'number':'text'} disabled={disabled} value={draft} {...(field.type==='number'?{min:field.min,max:field.max}:{maxLength:field.maxLength})} onChange={e=>setDraft(e.target.value)}/>}</label><button type="button" aria-label={`Apply ${label}`} disabled={disabled||pending||submitting||!dirty||!valid} onClick={()=>void apply()}>{pending||submitting?'Sending…':'Apply'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
