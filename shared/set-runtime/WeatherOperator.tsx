import {useEffect,useRef,useState} from 'react';
import type {Result,ModuleState} from './runtime';
import type {Scalar} from './contract';
import type {WeatherLocation} from './weather';

/** City choices configure this module instance, never its workspace connection. */
export function WeatherOperator({module,disabled,search,send,refresh}:{module:ModuleState;disabled:boolean;search?:(query:string)=>Promise<WeatherLocation[]>;send:(op:string,input?:Record<string,Scalar>)=>Promise<Result>;refresh?:(force?:boolean)=>Promise<void>}){
 const [query,setQuery]=useState(''),[locations,setLocations]=useState<WeatherLocation[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0);useEffect(()=>()=>{generation.current++;},[]);
 useEffect(()=>{if(module.dataStatus==='fresh')setError('');},[module.weather?.at,module.dataStatus]);
 const find=async()=>{if(!search||busy)return;const version=++generation.current;setBusy(true);setError('');try{const result=await search(query.trim());if(version!==generation.current)return;setLocations(result);if(!result.length)setError('No matching city. Include a state or country.');}catch(e){if(version===generation.current)setError(e instanceof Error?e.message:'City lookup failed');}finally{if(version===generation.current)setBusy(false);}};
 const select=async(location?:WeatherLocation)=>{setBusy(true);setError('');try{const result=await send(location?'weather.selectLocation':'weather.clearLocation',location?{location:JSON.stringify(location)}:{});if(result.status==='rejected')throw Error(result.error);setLocations([]);setQuery('');await refresh?.();}catch(e){setError(e instanceof Error?e.message:'Weather request failed');}finally{setBusy(false);}};
 const locked=disabled||busy||module.execution!=='running';
 return <div className="module-weather-controls">
  <form onSubmit={e=>{e.preventDefault();void find();}}>
   <label>City<input type="search" aria-label="Search city" value={query} placeholder="Search a city" maxLength={100} disabled={disabled||busy||!search} onChange={e=>{setQuery(e.target.value);setLocations([]);setError('');}}/></label>
   <button type="submit" disabled={disabled||busy||!search||query.trim().length<2}>{busy?'Loading…':'Find city'}</button>
  </form>
  {locations.length>0&&<ul aria-label="Matching cities">{locations.map(location=><li key={location.id}><button type="button" disabled={locked} onClick={()=>void select(location)}>{location.label}</button></li>)}</ul>}
  <p className="module-weather-location">{module.weatherLocation?.label??module.weather?.location??'Using the saved connection city'}</p>
  <div className="module-operator-actions"><button type="button" disabled={locked||!refresh} onClick={()=>{setBusy(true);setError('');void refresh?.(true).catch(e=>setError(e instanceof Error?e.message:'Weather request failed')).finally(()=>setBusy(false));}}>Refresh weather</button>{module.weatherLocation&&<button type="button" disabled={locked} onClick={()=>void select()}>Use saved city</button>}</div>
  <p>{module.dataStatus==='empty'?'Waiting for weather data':module.dataStatus==='fresh'?'Weather updated':module.dataStatus==='stale'?'Showing the last available forecast':'Weather unavailable'}</p>
  {(error||module.error)&&<p role="alert">{error||module.error}</p>}
 </div>;
}
