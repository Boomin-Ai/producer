import {conversationSuggestions,type ConversationMessage} from './conversationSuggestions';
/** Local UI context only. No media, transcripts, guest identities or room chat. */
export interface AssistantRoomState {
  setOnOutput: boolean;
  screenSharing: boolean;
  guestsConnected: boolean;
}
export type AssistantSuggestion = {id:string;label:string;prompt?:string;action?:'review'|'focus'};
export function roomSuggestions(room:AssistantRoomState|undefined, state:{edited:boolean;started:boolean;design:boolean;canEdit:boolean;messages?:readonly ConversationMessage[];replies?:readonly AssistantSuggestion[]}):AssistantSuggestion[] {
  if(state.started)return conversationSuggestions(state.messages??[],state.replies,state.edited&&state.canEdit);
  if(state.edited&&state.canEdit)return [
    {id:'review',label:'Review changes',action:'review'},
    {id:'continue-editing',label:'Continue editing',action:'focus'},
    {id:'explain-changes',label:'Explain changes',prompt:'Explain the changes in my current private draft and what I should check before showing it on output. Make no edits.'},
  ];
  if(!state.canEdit)return [
    {id:'plan-show',label:'Plan a show',prompt:'Help me plan a show. Ask me about the topic, audience and length first. Do not inspect or edit a Set.'},
    {id:'outline-segment',label:'Outline a segment',prompt:'Help me outline a strong content segment. Ask what I want to teach or discuss first.'},
    {id:'get-started',label:'Help me get started',prompt:'Help me get started producing content. Ask what I want to make and suggest a simple first step.'},
  ];
  if(room?.guestsConnected)return [
    {id:'guest-layout',label:'Create a guest layout',prompt:'Create a private guest-layout draft with appropriate host and guest source roles. Preserve existing content and controls. Do not change the room output.'},
    {id:'interview',label:'Prepare interview questions',prompt:'Help me prepare interview questions for my guests. Ask about the topic and audience first.'},
    {id:'guest-segment',label:'Plan a guest segment',prompt:'Help me plan a guest segment, including an opening question, discussion beats and a strong closing. Ask me for the topic first.'},
  ];
  if(room?.screenSharing)return [
    {id:'teaching-layout',label:'Build a teaching layout',prompt:'Design a private teaching layout using host camera and screen-share source roles, with landscape and vertical variants. Preserve existing content and controls. Do not change live output.'},
    {id:'frame-screen',label:'Frame my screen',prompt:'Refine the screen-share framing and host-camera placement in a private Set draft. Preserve existing controls and content. Do not change live output.'},
    {id:'walkthrough',label:'Plan a walkthrough',prompt:'Help me plan a clear screen-share walkthrough. Ask what I am demonstrating; you do not have access to the screen pixels.'},
  ];
  if(room?.setOnOutput||state.design)return [
    {id:'refine-set',label:'Refine this Set',prompt:'Refine this Set in a private draft with stronger typography and subtle motion. Preserve my sources, controls and configured content.'},
    {id:'add-layout',label:'Add a layout',prompt:'Help me add a layout to this Set. Ask what it should show, preserve existing layouts and controls, and keep edits private.'},
    {id:'live-controls',label:'Design live controls',prompt:'Design a clearer live control surface for this private Set, retaining the existing controls and per-layout flexibility. Do not change room output.'},
  ];
  return [
    {id:'create-set',label:'Create a Set',prompt:'Help me create a Set with landscape and vertical layouts. Ask about my show and visual direction first. Keep it in a private draft.'},
    {id:'plan-show',label:'Plan a show',prompt:'Help me plan a show. Ask about the topic, audience and length first. No Set edits yet.'},
    {id:'get-started',label:'Help me get started',prompt:'Help me get started producing content in Producer. Ask what I want to make and suggest a simple first step.'},
  ];
}
