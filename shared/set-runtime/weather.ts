/** Bounded weather values shared by trusted providers, authority and rehearsal. */
export type WeatherCondition='clear'|'cloudy'|'fog'|'rain'|'snow'|'storm';
export interface WeatherLocation {id:string;label:string;latitude:number;longitude:number;timezone:string}
export interface WeatherHour {at:number;temperature:number|null;rainChance:number|null;condition:WeatherCondition|null;isDay:boolean}
export interface WeatherDay {date:string;condition:WeatherCondition|null;high:number|null;low:number|null;rainChance:number|null;precipitation:number|null;sunrise:number|null;sunset:number|null;uv:number|null;wind:number|null}
export interface WeatherForecast {timezone:string;utcOffsetSeconds:number;feelsLike:number|null;humidity:number|null;cloudCover:number|null;gusts:number|null;windDirection:number|null;visibility:number|null;pressure:number|null;hourly:WeatherHour[];daily:WeatherDay[]}
const conditions=['clear','cloudy','fog','rain','snow','storm'];
function record(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))throw Error('Invalid weather fields');return v as Record<string,unknown>;}
function number(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Invalid weather number');return v;}
function optional(v:unknown,min:number,max:number){return v===null?null:number(v,min,max);}
function text(v:unknown,max:number){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid weather text');return v.trim();}
export function weatherTimezone(v:unknown){const zone=text(v,80);try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw Error('Invalid weather timezone');}return zone;}
export function parseWeatherLocation(v:unknown):WeatherLocation{const o=record(v,['id','label','latitude','longitude','timezone']);return {id:text(o.id,80),label:text(o.label,120),latitude:number(o.latitude,-90,90),longitude:number(o.longitude,-180,180),timezone:weatherTimezone(o.timezone)};}
export const weatherLocationKey=(location:Pick<WeatherLocation,'latitude'|'longitude'|'label'|'timezone'>,units:string)=>JSON.stringify([location.latitude,location.longitude,location.label,location.timezone,units]);
function condition(v:unknown){if(v===null)return null;if(typeof v!=='string'||!conditions.includes(v))throw Error('Invalid forecast condition');return v as WeatherCondition;}
export function parseWeatherForecast(v:unknown):WeatherForecast{
 if(JSON.stringify(v).length>14000)throw Error('Forecast exceeds its byte budget');
 const o=record(v,['timezone','utcOffsetSeconds','feelsLike','humidity','cloudCover','gusts','windDirection','visibility','pressure','hourly','daily']);
 if(!Array.isArray(o.hourly)||o.hourly.length>48||!Array.isArray(o.daily)||o.daily.length>7)throw Error('Forecast exceeds its time horizon');
 const hourly=o.hourly.map(raw=>{const h=record(raw,['at','temperature','rainChance','condition','isDay']);if(typeof h.isDay!=='boolean')throw Error('Invalid forecast daylight');return {at:number(h.at,0,1e15),temperature:optional(h.temperature,-150,180),rainChance:optional(h.rainChance,0,100),condition:condition(h.condition),isDay:h.isDay};});
 const daily=o.daily.map(raw=>{const d=record(raw,['date','condition','high','low','rainChance','precipitation','sunrise','sunset','uv','wind']);const date=text(d.date,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)throw Error('Invalid forecast date');const high=optional(d.high,-150,180),low=optional(d.low,-150,180);if(high!==null&&low!==null&&high<low)throw Error('Invalid forecast high/low');return {date,condition:condition(d.condition),high,low,rainChance:optional(d.rainChance,0,100),precipitation:optional(d.precipitation,0,2000),sunrise:optional(d.sunrise,0,1e15),sunset:optional(d.sunset,0,1e15),uv:optional(d.uv,0,30),wind:optional(d.wind,0,500)};});
 if(hourly.some((h,i)=>i>0&&h.at<=hourly[i-1].at)||daily.some((d,i)=>i>0&&d.date<=daily[i-1].date))throw Error('Forecast times must increase');
 return {timezone:weatherTimezone(o.timezone),utcOffsetSeconds:number(o.utcOffsetSeconds,-50400,50400),feelsLike:optional(o.feelsLike,-150,180),humidity:optional(o.humidity,0,100),cloudCover:optional(o.cloudCover,0,100),gusts:optional(o.gusts,0,500),windDirection:optional(o.windDirection,0,360),visibility:optional(o.visibility,0,1000000),pressure:optional(o.pressure,500,1200),hourly,daily};
}
/** Transport remains bounded scalar input; forecast objects cross as checked JSON. */
export function weatherPayload<T extends {forecast?:WeatherForecast;requestKey?:string}>(result:T):Record<string,string|number|boolean>{
 const {forecast,requestKey:_key,...values}=result;
 return {...values as Record<string,string|number|boolean>,...(forecast?{forecast:JSON.stringify(parseWeatherForecast(forecast))}:{})};
}
