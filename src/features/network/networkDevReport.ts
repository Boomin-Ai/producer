/** Network developer reports share one native output file. Keep their writes
 * serial without changing the application's general IPC or report payloads. */
import {invoke} from '../../lib/nativeInvoke';

type WriteReport=(result:unknown)=>Promise<unknown>;

/** A rejected (or synchronously throwing) write rejects only its own caller;
 * the next queued report still runs after that write has finished. */
export function createNetworkDevReportWriter(write:WriteReport):WriteReport {
 let tail:Promise<unknown>=Promise.resolve();
 return result=>{
  const pending=tail.then(()=>write(result));
  tail=pending.catch(()=>{});
  return pending;
 };
}

// Both passive diagnostics and the paired-run launcher import this singleton.
// Their existing DEV/explicit opt-in/bundle checks remain the entry guards.
export const reportNetworkDevResult=createNetworkDevReportWriter(result=>invoke('live_set_v2_report',{result}));
