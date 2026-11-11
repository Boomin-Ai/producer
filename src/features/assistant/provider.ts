/** Inference adapters own transport/auth only. Producer owns all tools/effects. */
import {Channel, invoke} from '../../lib/nativeInvoke';
export interface AssistantAccount {id: string; email: string; planEnabled: boolean; verified: boolean}
export interface AssistantStatus {accounts: AssistantAccount[]; active: string | null; signIn: {id: string; status: 'waiting' | 'complete' | 'error'; error: string | null} | null}
export interface AssistantModel {slug: string; display_name: string}
export interface AssistantTurn {accountId: string; turnId: string; model: string; instructions: string; input: unknown[]; tools: unknown[]}
export type AssistantEvent = {type: 'text'; text: string} | {type: 'completed'; output: ResponseItem[]};
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
  turn(input: AssistantTurn, event: (event: AssistantEvent) => void): Promise<void>;
  cancel(turnId: string): Promise<void>;
}
export const chatgpt: AssistantProvider = {
  id: 'chatgpt-plan', label: 'ChatGPT',
  status: () => invoke('assistant_status'),
  signIn: accountId => invoke('assistant_sign_in', {accountId: accountId ?? null}),
  cancelSignIn: () => invoke('assistant_cancel_sign_in'),
  select: accountId => invoke('assistant_select_account', {accountId}),
  disconnect: accountId => invoke('assistant_disconnect', {accountId}),
  models: accountId => invoke('assistant_models', {accountId}),
  async turn(turn, event) {const onEvent = new Channel<AssistantEvent>(); onEvent.onmessage = event; await invoke('assistant_turn', {turn, onEvent});},
  cancel: turnId => invoke('assistant_cancel_turn', {turnId}),
};
export const assistantProviders: readonly AssistantProvider[] = [chatgpt];
