import type { DataContract } from './dataOperation';
import { parseWeatherForecast, parseWeatherLocation, type WeatherForecast, type WeatherLocation } from './weather';
export interface WeatherQuery { location?: WeatherLocation }
export interface WeatherObservation {
  observedAt: number; temperature: number; condition: 'clear'|'cloudy'|'fog'|'rain'|'snow'|'storm';
  isDay: boolean; wind: number; precipitation: number; provider: string; location: string;
  units: 'celsius'|'fahrenheit'; forecast?: WeatherForecast; requestKey?: string;
}
export interface AgentQuestion { question: string; mode: 'answer'|'factCheck'; instructions?: string }
export interface AgentAnswer { response: string; citations: {title: string; url: string; start?: number; end?: number}[]; researched: boolean; model: string }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Object required');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(k => !required.includes(k) && !optional.includes(k)) || required.some(k => !Object.prototype.hasOwnProperty.call(o,k))) throw Error('Fields');
  return o;
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim())) throw Error('Text');
  return v;
}
function num(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Error('Number');
  return v;
}
export const weatherQueryContract: DataContract<WeatherQuery> = {
  id: 'weather.location-query@1', maxBytes: 4096,
  parse(value) { const o = object(value, [], ['location']); return o.location === undefined ? {} : { location: parseWeatherLocation(o.location) }; },
};
export const weatherObservationContract: DataContract<WeatherObservation> = {
  id: 'weather.observation@1', maxBytes: 32768,
  parse(value) {
    const o = object(value, ['observedAt','temperature','condition','isDay','wind','precipitation','provider','location','units'], ['forecast','requestKey']);
    if (!['clear','cloudy','fog','rain','snow','storm'].includes(o.condition as string) || typeof o.isDay !== 'boolean' || !['celsius','fahrenheit'].includes(o.units as string)) throw Error('Weather enum');
    return { observedAt: num(o.observedAt,0,1e15), temperature: num(o.temperature,-150,180), condition: o.condition as WeatherObservation['condition'], isDay: o.isDay,
      wind: num(o.wind,0,500), precipitation: num(o.precipitation,0,1000), provider: text(o.provider,80), location: text(o.location,120), units: o.units as WeatherObservation['units'],
      ...(o.forecast === undefined ? {} : {forecast: parseWeatherForecast(o.forecast)}), ...(o.requestKey === undefined ? {} : {requestKey:text(o.requestKey,512)}) };
  },
};
export const agentQuestionContract: DataContract<AgentQuestion> = {
  id: 'agent.question@1', maxBytes: 16384,
  parse(value) {
    const o = object(value, ['question','mode'], ['instructions']);
    if (o.mode !== 'answer' && o.mode !== 'factCheck') throw Error('Mode');
    return {question:text(o.question,1000),mode:o.mode,...(o.instructions===undefined?{}:{instructions:text(o.instructions,1000)})};
  },
};
export const agentAnswerContract: DataContract<AgentAnswer> = {
  id: 'agent.answer@1', maxBytes: 262144,
  parse(value) {
    const o = object(value, ['response','citations','researched','model']), response = text(o.response,16000);
    if (typeof o.researched !== 'boolean' || !Array.isArray(o.citations) || o.citations.length > 20 || (o.researched && !o.citations.length)) throw Error('Evidence');
    const citations = o.citations.map(raw => {
      const c = object(raw,['title','url'],['start','end']), url = new URL(text(c.url,2000));
      if (url.protocol !== 'https:' || url.username || url.password) throw Error('Citation URL');
      if ((c.start === undefined) !== (c.end === undefined)) throw Error('Citation range');
      let range = {};
      if (c.start !== undefined) {
        const start = num(c.start,0,response.length), end = num(c.end,0,response.length);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw Error('Citation range');
        range = {start,end};
      }
      return {title:text(c.title,160,true),url:url.href,...range};
    });
    return {response,citations,researched:o.researched,model:text(o.model,120)};
  },
};
