import {ApiError} from "./errors";

/** Per-room DO queue. Keep DB stage writes, clocks and fanout in order. */
export class RoomMutations {
  private tail:Promise<unknown>=Promise.resolve();
  private pending=0;
  run<T>(work:()=>Promise<T>):Promise<T>{
    if(this.pending>=64)return Promise.reject(new ApiError(429,"room_busy","Room control is busy. Try again."));
    this.pending++;
    const result=this.tail.then(work,work).finally(()=>{this.pending--;});
    this.tail=result.catch(()=>{});return result;
  }
}
