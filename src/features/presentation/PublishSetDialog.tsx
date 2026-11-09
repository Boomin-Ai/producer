import {useEffect,useRef,useState,type MouseEvent} from 'react';
import {createPortal} from 'react-dom';
import {openUrl} from '@tauri-apps/plugin-opener';
import {ipc} from '../../lib/ipc';
import {activeEndpointId,isBoomin,WORKSPACE_EVENT} from '../../lib/workspace';
import {copyText} from '../../lib/roomLink';
import {PUBLIC_THUMBNAIL_BYTES,validatePublicPackageText} from './publication';
import {createPublicationClient,createPublicationUpload,publicationLinks,publicationMetadataIssue,PublicationError,type PublishedSet,type PublicationUpload,type PublisherProfile,type PublicationVisibility} from './publicationClient';
import type {PresentationPackage} from './schema';
import './publication.css';

/** Publishing snapshots only the configured package. No session/output/device
 * controller enters this dialog or the network client. */
export function PublishSetDialog({doc,endpointId,onClose,returnFocus}:{doc:PresentationPackage;endpointId:string;onClose:()=>void;returnFocus?:HTMLElement|null}){
 const dialog=useRef<HTMLDialogElement>(null),alive=useRef(true),context=useRef(true),epoch=useRef(0),running=useRef(false),close=useRef(onClose);close.current=onClose;
 const [client]=useState(()=>createPublicationClient(endpointId));
 const [upload]=useState(()=>createPublicationUpload(client));
 const [validated]=useState(()=>validatePublicPackageText(JSON.stringify(doc)));
 const [profile,setProfile]=useState<PublisherProfile|null>(null),[rows,setRows]=useState<PublishedSet[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[changed,setChanged]=useState(false);
 const [selected,setSelected]=useState(''),[title,setTitle]=useState(doc.name),[slug,setSlug]=useState(doc.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80));
 const [description,setDescription]=useState(''),[visibility,setVisibility]=useState<PublicationVisibility>('private'),[consent,setConsent]=useState(false);
 const [thumbnail,setThumbnail]=useState<PublicationUpload['thumbnail']>(),[thumbnailName,setThumbnailName]=useState('');
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const current=(generation=epoch.current)=>alive.current&&context.current&&generation===epoch.current&&activeEndpointId()===endpointId;
 const failure=(reason:unknown)=>reason instanceof PublicationError?reason.message:'The request could not be confirmed. Try again without changing workspaces.';
 const lock=loading||busy||pending||changed;
 const item=rows.find(row=>row.id===selected);
 const links=item?publicationLinks(item):null;
 const metadataIssue=publicationMetadataIssue({title,description});
 const visit=(event:MouseEvent<HTMLAnchorElement>)=>{event.preventDefault();void openUrl(event.currentTarget.href).catch(()=>{if(current())setError('Could not open this link. Copy its address and open it in your browser.');});};
 const load=async()=>{
  const generation=epoch.current;
  setLoading(true);setError('');
  try{
   const endpoints=await ipc.listEndpoints();if(!current(generation))return;
   if(!isBoomin(endpoints.find(endpoint=>endpoint.id===endpointId)))throw new PublicationError('unavailable');
   const [nextProfile,nextRows]=await Promise.all([client.profile(),client.list()]);
   if(current(generation)){setProfile(nextProfile);setRows(nextRows);}
  }catch(reason){if(current(generation))setError(failure(reason));}
  finally{if(current(generation))setLoading(false);}
 };
 useEffect(()=>{
  alive.current=true;context.current=true;epoch.current++;dialog.current?.showModal();void load();
  const workspaceChanged=()=>{if(activeEndpointId()!==endpointId){context.current=false;epoch.current++;setChanged(true);setLoading(false);setBusy(false);setError('Workspace changed. Close this window and publish from the selected workspace.');}};
  window.addEventListener(WORKSPACE_EVENT,workspaceChanged);
  return()=>{alive.current=false;epoch.current++;window.removeEventListener(WORKSPACE_EVENT,workspaceChanged);dialog.current?.close();returnFocus?.focus();};
  // The endpoint and configured document are intentionally captured on open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 function choose(id:string){
  if(lock)return;setSelected(id);setConsent(false);setError('');setNotice('');
  const next=rows.find(row=>row.id===id);setTitle(next?.title??doc.name);setDescription(next?.description??'');setVisibility(next?.visibility??'private');
 }
 async function perform(work:()=>Promise<PublishedSet>){
  if(running.current||!current()||changed)return;
  const generation=epoch.current;
  running.current=true;setBusy(true);setError('');setNotice('');
  try{
   const next=await work();if(!current(generation))return;
   setRows(old=>[next,...old.filter(row=>row.id!==next.id)]);setSelected(next.id);setPending(false);setConsent(false);
   setNotice(next.status==='withdrawn'?'Set withdrawn. Public viewing and downloads are disabled.':next.visibility==='private'?'Private Set saved. It is not publicly downloadable.':next.status==='draft'?'Draft saved. Publish the saved version when you are ready to share it.':'Set published. Your link is ready.');
  }catch(reason){if(current(generation)){setError(failure(reason));setPending(upload.hasPending());}}
  finally{running.current=false;if(current(generation))setBusy(false);}
 }
 function submit(){
  if(lock||!profile||!validated.ok||metadataIssue||visibility!=='private'&&!consent)return;
  const value:PublicationUpload&{slug?:string;expected_revision?:number}={title:title.trim(),description:description.trim(),visibility,package_text:validated.text,...(thumbnail?{thumbnail}:{}),
   ...(item?{expected_revision:item.revision}:{slug:slug.trim()})};
  void perform(()=>upload.start(value,item?.id));
 }
 async function pickPreview(file:File|undefined){
  if(!file||lock)return;setError('');
  const generation=epoch.current;
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>PUBLIC_THUMBNAIL_BYTES){setError('Choose a PNG or JPEG preview up to 512 KiB.');return;}
  setBusy(true);running.current=true;
  try{
   const bytes=new Uint8Array(await file.arrayBuffer());if(!current(generation))return;
   let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
   setThumbnail({mime_type:file.type as 'image/png'|'image/jpeg',data_base64:btoa(binary)});setThumbnailName(file.name);
  }catch{if(current(generation))setError('Could not read this preview image.');}
  finally{running.current=false;if(current(generation))setBusy(false);}
 }
 const dismiss=()=>{if(changed||!busy&&!pending)close.current();};
 return createPortal(<dialog ref={dialog} className="set-publication-dialog" aria-label="Publish Set to producer.dev" onCancel={event=>{event.preventDefault();dismiss();}}>
  <header><div><strong>Publish to producer.dev</strong><p>{profile?`${profile.name} · @${profile.handle}`:'Your Boomin workspace'}</p></div><button type="button" disabled={!changed&&(busy||pending)} onClick={dismiss}>Close</button></header>
  <div className="set-publication-body">
   <p>Share a downloadable Set package. This does not apply it to the room or change your camera, microphone or output.</p>
   {loading&&<p role="status">Loading your publications…</p>}
   {!validated.ok&&<div role="alert" className="set-publication-error"><strong>This Set cannot be published yet.</strong><ul>{validated.errors.slice(0,6).map((issue,index)=><li key={index}>{issue.path}: {issue.message}</li>)}</ul></div>}
   {validated.ok&&<p className="set-publication-note">{validated.summary.layout_count} layouts · {validated.summary.orientations.join(', ')} · {Math.ceil(new TextEncoder().encode(validated.text).length/1024)} KiB / 8 MiB. Configured text, values and embedded assets are included. Live account connections, room state and source bindings are excluded.</p>}
   {profile&&<>
    <form onSubmit={event=>{event.preventDefault();submit();}}>
     <fieldset disabled={lock}><legend>Set publication</legend>
      <label>Destination<select aria-label="Destination" value={selected} onChange={event=>choose(event.target.value)}><option value="">Create a new publication</option>{rows.map(row=><option key={row.id} value={row.id}>{row.title} · {row.slug} · v{row.version} · {row.status}</option>)}</select></label>
      <label>Title<input value={title} maxLength={160} required onChange={event=>setTitle(event.target.value)}/></label>
      {!selected&&<label>Set address<input value={slug} required maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" onChange={event=>setSlug(event.target.value)}/><small>producer.dev/{profile.handle}/set/{slug||'your-set'}</small></label>}
      <label>Description<textarea aria-label="Description" value={description} maxLength={2000} rows={3} onChange={event=>setDescription(event.target.value)}/></label>
      {metadataIssue&&<p role="alert" className="set-publication-error">{metadataIssue}</p>}
      <label>Visibility<select aria-label="Visibility" value={visibility} onChange={event=>{setVisibility(event.target.value as PublicationVisibility);setConsent(false);}}><option value="private">Private — only your workspace</option><option value="unlisted">Unlisted — anyone with the link</option><option value="public">Public — listed on your profile</option></select></label>
      <label>Choose preview image (optional)<input type="file" accept="image/png,image/jpeg" onChange={event=>void pickPreview(event.target.files?.[0])}/></label>
      {thumbnailName&&<p className="set-publication-note">Preview: {thumbnailName} <button type="button" onClick={()=>{setThumbnail(undefined);setThumbnailName('');}}>Remove</button></p>}
      <p className="set-publication-note">PNG or JPEG, up to 512 KiB. A new version keeps its saved preview unless you choose a replacement. New publications without artwork use a metadata preview. Removing a selection only clears the new image. No live camera image is captured.</p>
      {visibility!=='private'&&<label className="set-publication-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>I want this package and its embedded assets to be downloadable by anyone with the link. Downloaded copies cannot be recalled.</label>}
     </fieldset>
     <button type="submit" disabled={lock||!validated.ok||!profile||!!metadataIssue||visibility!=='private'&&!consent}>{busy?'Saving…':selected?'Upload new version':visibility==='private'?'Save private Set':'Publish Set'}</button>
    </form>
    {item&&<section aria-label="Publication link" className="set-publication-links"><strong>{item.status==='withdrawn'?'Withdrawn':item.status==='draft'?'Draft':item.visibility==='private'?'Private':item.visibility==='unlisted'?'Unlisted':'Public'} · Version {item.version} · Revision {item.revision}</strong>
     <p>{links!.url}</p>{item.status==='published'&&item.visibility!=='private'&&<div><a href={links!.url} onClick={visit} target="_blank" rel="noopener noreferrer">View Set ↗</a><a href={links!.download_url} onClick={visit} target="_blank" rel="noopener noreferrer">Download Set ↗</a><button type="button" onClick={()=>void copyText(links!.url).then(ok=>{if(current())setNotice(ok?'Link copied.':'Could not copy the link.');})}>Copy link</button></div>}
     {item.status==='published'?<button type="button" disabled={lock} onClick={()=>{if(window.confirm('Withdraw this Set? Public viewing and new downloads will stop. Existing downloaded copies remain.'))void perform(()=>upload.changeStatus(item,'withdrawn'));}}>Withdraw Set</button>:
      <><p className="set-publication-note">This action publishes the saved version with the visibility selected above.</p><button type="button" disabled={lock||visibility!=='private'&&!consent} onClick={()=>void perform(()=>upload.changeStatus(item,'published',visibility))}>{item.status==='draft'?'Publish saved version':'Restore publication'}</button></>}
    </section>}
    <details className="set-publication-profile"><summary>Profile and handle</summary><p>Uses your existing Boomin handle. Changing it moves your public profile and Set links; old addresses are not promised redirects.</p><a href={`https://producer.dev/${encodeURIComponent(profile.handle)}`} onClick={visit} target="_blank" rel="noopener noreferrer">View profile ↗</a>{' '}
     {profile.editable&&<a href={`https://boomin.ai/brand/${encodeURIComponent(profile.handle)}/settings`} onClick={visit} target="_blank" rel="noopener noreferrer">Manage handle on Boomin ↗</a>}
    </details>
   </>}
   {error&&<p role="alert" className="set-publication-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {pending&&!busy&&<div className="set-publication-retry"><p>The request may already have been saved. Retry sends the exact same operation, package and request key. Discarding a retry does not undo a saved version.</p><button type="button" disabled={changed} onClick={()=>void perform(upload.retry)}>Retry same request</button><button type="button" disabled={changed} onClick={()=>{upload.discard();setPending(false);void load();}}>Discard retry and reload publications</button></div>}
   {!loading&&!busy&&!profile&&!changed&&<button type="button" onClick={()=>void load()}>Retry loading</button>}
  </div>
 </dialog>,document.body);
}
