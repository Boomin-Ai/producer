/** Inference adapters own transport/auth only. Producer owns all tools/effects. */
import {Channel, invoke} from '../../lib/nativeInvoke';
export interface AssistantAccount {id: string; email: string; planEnabled: boolean; verified: boolean}
export interface AssistantStatus {accounts: AssistantAccount[]; active: string | null; signIn: {id: string; status: 'waiting' | 'complete' | 'error'; error: string | null; expiresAt?: number} | null}
export interface AssistantModel {slug: string; display_name: string}
export interface AssistantTurn {accountId: string; turnId: string; model: string; instructions: string; input: unknown[]; tools: unknown[]}
export type AssistantEvent = {type: 'text'; text: string} | {type: 'completed'; output: ResponseItem[]} | {type:'transport';stage:'retry'|'failed';kind:string;attempt:number;maxAttempts:number;elapsedMs?:number};
export interface ResponseItem {type: string; name?: string; namespace?: string; arguments?: string; call_id?: string; content?: Array<{type: string; text?: string}>; [key: string]: unknown}
export interface AssistantProvider {
  id: string;
  label: string;
  status(): Promise<AssistantStatus>;
  signIn(accountId?: string): Promise<string>;
  cancelSignIn(): Promise<void>;
  select(accountId: string): Promise<void>;
  disconnect(accountId: string): Promise<boolean>;
  models(accountId: string): Promise<AssistantModel[]>;
  turn(input: AssistantTurn, event: (event: AssistantEvent) => void): Promise<ResponseItem[]>;
  cancel(turnId: string): Promise<void>;
}
const pending=new Map<string,AbortController>();
function retryDelay(signal:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);reject(Error('Assistant stopped.'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},500);
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
}
function recordTransport(value:Extract<AssistantEvent,{type:'transport'}>) {
  // Fixed metadata only, never raw errors, account IDs, input or credentials.
  if(!['retry','failed'].includes(value.stage)||!/^[a-z_]{1,64}$/.test(value.kind)||!Number.isInteger(value.attempt)||!Number.isInteger(value.maxAttempts)||value.attempt<1||value.maxAttempts>3)return;
  const diagnostic={stage:value.stage,kind:value.kind,attempt:value.attempt,maxAttempts:value.maxAttempts,
    ...(typeof value.elapsedMs==='number'&&Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0?{elapsedMs:value.elapsedMs}: {})};
  void invoke('ui_log',{line:'[assistant-transport] '+JSON.stringify(diagnostic)}).catch(()=>{});
}
export const chatgpt: AssistantProvider = {
  id: 'chatgpt-plan', label: 'ChatGPT',
  status: () => invoke('assistant_status'),
  signIn: accountId => invoke('assistant_sign_in', {accountId: accountId ?? null}),
  cancelSignIn: () => invoke('assistant_cancel_sign_in'),
  select: accountId => invoke('assistant_select_account', {accountId}),
  disconnect: accountId => invoke('assistant_disconnect', {accountId}),
  models: accountId => invoke('assistant_models', {accountId}),
  async turn(turn, event) {
    const controller=new AbortController();pending.set(turn.turnId,controller);
    try {
    // Progress channels and command replies can arrive in either order. The
    // command result is authoritative in current hosts; older dev hosts send
    // their completed output through the channel, which must also settle.
    let complete: (output: ResponseItem[]) => void = () => {};
    const legacyOutput = new Promise<ResponseItem[]>(resolve => {complete = resolve;});
    const onEvent = new Channel<AssistantEvent>();
    onEvent.onmessage = value => {
      if(controller.signal.aborted)return;
      if(value.type==='transport')recordTransport(value);
      if (value.type === 'completed' && Array.isArray(value.output)) complete(value.output);
      event(value);
    };
    let output:unknown;
    for(let attempt=0;;attempt++){
      if(controller.signal.aborted)throw Error('Assistant stopped.');
      try {output=await invoke<unknown>('assistant_turn', {turn, onEvent});break;}
      catch(error){
        // Compatibility with the installed pre-diagnostic dev host only. New
        // hosts own bounded transport recovery and return classified failures.
        const message=error instanceof Error?error.message:String(error);
        if(message!=='Could not reach ChatGPT. Check your connection.')throw error;
        if(attempt!==0){const failed={type:'transport',stage:'failed',kind:'legacy_send_failure',attempt:2,maxAttempts:2} as const;recordTransport(failed);event(failed);throw error;}
        const recovery={type:'transport',stage:'retry',kind:'legacy_send_failure',attempt:1,maxAttempts:2} as const;
        recordTransport(recovery);event(recovery);
        await retryDelay(controller.signal);
      }
    }
    if(controller.signal.aborted)throw Error('Assistant stopped.');
    if (Array.isArray(output)) return output as ResponseItem[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([legacyOutput, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('The native completion was not delivered. Retry this request.')), 3000);
      })]);
    } finally {if (timer) clearTimeout(timer);}
    } finally {if(pending.get(turn.turnId)===controller)pending.delete(turn.turnId);}
  },
  cancel: turnId => {pending.get(turnId)?.abort();return invoke('assistant_cancel_turn', {turnId});},
};
export const assistantProviders: readonly AssistantProvider[] = [chatgpt];
