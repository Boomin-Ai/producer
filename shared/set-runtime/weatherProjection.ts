import type {ModuleState} from './runtime';
import type {Scalar} from './contract';
const symbols:Record<string,string>={clear:'☀',cloudy:'☁',rain:'☂',snow:'❄',fog:'≋',storm:'ϟ'};
const title=(v:string)=>v?v[0].toUpperCase()+v.slice(1):'—';
const number=(value:number|null|undefined,suffix='',digits=0)=>value===null||value===undefined?'—':value.toFixed(digits)+suffix;
export function weatherOutputTypes():Record<string,'text'|'number'|'boolean'>{
 const types:Record<string,'text'|'number'|'boolean'>={hasWeather:'boolean',hasForecast:'boolean'};
 for(const key of ['locationShort','conditionLabel','conditionSymbol','weatherCue','feelsLikeLabel','humidityLabel','cloudCoverLabel','windLabel','gustsLabel','windDirectionLabel','visibilityLabel','pressureLabel','highLabel','lowLabel','uvLabel','rainChanceLabel','sunriseLabel','sunsetLabel','updatedLabel','timezoneLabel','sourceLabel','temperatureUnit','temperatureChart','rainChart','chartRangeLabel'])types[key]='text';
 for(let i=0;i<24;i++){for(const suffix of ['Time','Temperature','Rain','Condition','Symbol'])types['hour'+i+suffix]='text';types['hour'+i+'Available']='boolean';types['hour'+i+'Height']='number';}
 for(let i=0;i<7;i++){for(const suffix of ['Day','Date','High','Low','Rain','Condition','Symbol'])types['day'+i+suffix]='text';types['day'+i+'Available']='boolean';}
 return types;
}
/** Stable projection of the last committed provider response, with explicit gaps. */
export function weatherFields(m:ModuleState):Record<string,Scalar>{
 const w=m.weather,f=w?.forecast,unit=w?.units==='fahrenheit'?'°F':'°C',zone=f?.timezone??'UTC';
 const clock=(at:number|null|undefined)=>at==null?'—':new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(at));
 const fields:Record<string,Scalar>={locationShort:(m.weatherLocation?.label??w?.location??'Choose a city').split(',')[0].slice(0,44),hasWeather:!!w,hasForecast:!!f?.daily.length,conditionLabel:w?(!w.isDay&&w.condition==='clear'?'Clear night':title(w.condition)):'Waiting for weather',conditionSymbol:w?(!w.isDay&&w.condition==='clear'?'☾':symbols[w.condition]):'—',weatherCue:w?(!w.isDay?'night':w.condition):'neutral',feelsLikeLabel:number(f?.feelsLike,unit),humidityLabel:number(f?.humidity,'%'),cloudCoverLabel:number(f?.cloudCover,'%'),windLabel:w?number(w.wind,' km/h',1):'—',gustsLabel:number(f?.gusts,' km/h',1),windDirectionLabel:number(f?.windDirection,'°'),visibilityLabel:f?.visibility==null?'—':number(f.visibility/1000,' km',1),pressureLabel:number(f?.pressure,' hPa'),highLabel:number(f?.daily[0]?.high,'°'),lowLabel:number(f?.daily[0]?.low,'°'),uvLabel:number(f?.daily[0]?.uv,'',1),rainChanceLabel:number(f?.daily[0]?.rainChance,'%'),sunriseLabel:clock(f?.daily[0]?.sunrise),sunsetLabel:clock(f?.daily[0]?.sunset),updatedLabel:w?clock(w.observedAt):'Waiting for data',timezoneLabel:zone,sourceLabel:'Weather data: Open-Meteo · Model forecast'};
 const page=Math.max(0,Math.min(3,Number(m.values.hourPage)||0)),hours=(f?.hourly??[]).slice(page*6,page*6+24);
 const scope=String(m.weatherLocationRevision??0)+':'+(w?.units??'')+':'+String((w?.location??'').split('').reduce((h,c)=>(Math.imul(h,31)+c.charCodeAt(0))|0,0));
 fields.temperatureUnit=unit;fields.temperatureChart=JSON.stringify({scope,points:hours.map(h=>({x:h.at,y:h.temperature}))});fields.rainChart=JSON.stringify({scope,points:hours.map(h=>({x:h.at,y:h.rainChance}))});fields.chartRangeLabel=hours.length?clock(hours[0].at)+' – '+clock(hours[hours.length-1].at):'Waiting for forecast';
 const temperatures=(f?.hourly??[]).flatMap(h=>h.temperature===null?[]:[h.temperature]),min=Math.min(...temperatures),max=Math.max(...temperatures);
 for(let i=0;i<24;i++){const h=f?.hourly[i],prefix='hour'+i;Object.assign(fields,{[prefix+'Available']:!!h,[prefix+'Time']:h?new Intl.DateTimeFormat('en-US',{hour:'numeric',timeZone:zone}).format(new Date(h.at)):'—',[prefix+'Temperature']:number(h?.temperature,'°'),[prefix+'Rain']:number(h?.rainChance,'%'),[prefix+'Condition']:title(h?.condition??''),[prefix+'Symbol']:h?.condition?(!h.isDay&&h.condition==='clear'?'☾':symbols[h.condition]):'—',[prefix+'Height']:h?.temperature==null?0:Math.round(24+76*(h.temperature-min)/Math.max(1,max-min))});}
 for(let i=0;i<7;i++){const d=f?.daily[i],prefix='day'+i;Object.assign(fields,{[prefix+'Available']:!!d,[prefix+'Day']:d?(i===0?'Today':new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'UTC'}).format(new Date(d.date+'T12:00:00Z'))):'—',[prefix+'Date']:d?.date??'',[prefix+'High']:number(d?.high,'°'),[prefix+'Low']:number(d?.low,'°'),[prefix+'Rain']:number(d?.rainChance,'%'),[prefix+'Condition']:title(d?.condition??''),[prefix+'Symbol']:d?.condition?symbols[d.condition]:'—'});}
 return fields;
}
