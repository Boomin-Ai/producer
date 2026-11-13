import {invoke} from './nativeInvoke';
export type StarterAudio={id:string;kind:'music'|'effect';name:string;path:string;sha256:string;duration_ms:number};
let pending:Promise<{version:string;assets:StarterAudio[]}>|undefined;
/** Native worker installs once per profile/version; failed attempts are retryable. */
export function ensureStarterAudio(){
  return pending??=invoke<{version:string;assets:StarterAudio[]}>('starter_audio_install').then(receipt=>{window.dispatchEvent(new Event('producer:soundboard-library'));window.dispatchEvent(new Event('producer:audio-library-ready'));return receipt;}).catch(error=>{pending=undefined;throw error;});
}
