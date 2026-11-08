import type {EndpointInfo} from '../../lib/ipc';
import {isBoomin} from '../../lib/workspace';

const independentLabel='PRODUCER CONNECTIONS';
const boominInvitationOrigins=new Set(['https://boomin.ai','https://www.boomin.ai','https://producer.dev','https://www.producer.dev']);

export function networkProviderLabels(endpoint:EndpointInfo){
 const boomin=isBoomin(endpoint);
 return {eyebrow:boomin?'BOOMIN NETWORK':independentLabel,name:boomin?'Boomin':endpoint.name};
}

/** The destination, not the sending workspace or host's display name, owns
 * invitation branding. This label does not grant identity or room access. */
export function producerInvitationLabel(invitation?:{joinUrl:string;apiBase:string}):string{
 if(!invitation)return independentLabel;
 try{
  const link=new URL(invitation.joinUrl),api=new URL(invitation.apiBase);
  if(!link.username&&!link.password&&!api.username&&!api.password&&boominInvitationOrigins.has(link.origin)&&api.origin==='https://api.boomin.ai')return 'BOOMIN NETWORK';
 }catch{/* Unrecognized issuers keep the neutral Producer label. */}
 return independentLabel;
}
