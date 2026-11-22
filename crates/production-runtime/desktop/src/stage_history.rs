//! Host-observed membership in the live program. Output layouts run concurrently.
use crate::{model::RoomProject, take_control::save};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::{Path,PathBuf}, time::{Duration,Instant,SystemTime,UNIX_EPOCH}};

pub fn new_id()->Result<String>{
    let mut bytes=[0u8;16];fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|v|format!("{v:02x}")).collect())
}
pub fn participant(root:&Path)->Result<String>{
    let path=root.join("rtc-participant.json");
    if path.exists(){return Ok(serde_json::from_slice(&fs::read(path)?)?);}
    let id=new_id()?;save(&path,&id)?;Ok(id)
}
pub fn name(value:Option<&str>)->String{
    let text:String=value.unwrap_or("").trim().chars().filter(|c|!c.is_control() && !matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')).take(48).collect();
    if text.is_empty(){"Guest".into()}else{text}
}
fn wall()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
#[derive(Clone,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct OutputLayout {id:String,width:u32,height:u32,path:String}
#[derive(Clone,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Program {room:String,scene:String,set_id:Option<String>,composition:String,revision:u64,layouts:[OutputLayout;2]}
impl Program {
    fn live(p:&RoomProject,revision:u64)->Self{
        Self {room:p.room.clone(),scene:p.active_scene.clone(),set_id:if p.scene=="room-scene"{None}else{Some(p.scene.clone())},
            layouts:p.output_layouts().map(|(id,size)|OutputLayout{id:id.into(),width:size.width,height:size.height,path:format!("sets/{}/layouts/{id}",p.scene)}),composition:p.scene.clone(),revision}
    }
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Interval {
    id:String,session_id:String,participant_id:String,display_name:String,on_stage:bool,program:Program,
    start_unix_ms:u64,end_unix_ms:u64,duration_ms:u64,end_reason:String,
}
pub struct History {origin:Instant,epoch_ms:u64,dir:PathBuf,active:Option<(Interval,Instant)>,last_save:Instant,session:String,closed_stage_ms:u64}
impl History {
    pub fn open(root:&Path)->Result<Self>{
        let dir=root.join("stage-history");fs::create_dir_all(&dir)?;
        let current=dir.join("current.json");
        if current.exists(){
            let mut span:Interval=serde_json::from_slice(&fs::read(&current)?)?;
            if span.end_reason=="observed"{span.end_reason="interruptedAtLastObservation".into();}
            save(&current,&span)?;fs::rename(&current,dir.join(format!("{}.json",span.id)))?;
        }
        Ok(Self{origin:Instant::now(),epoch_ms:wall(),dir,active:None,last_save:Instant::now(),session:String::new(),closed_stage_ms:0})
    }
    pub fn observe(&mut self,rtc:&Value,staged:bool,p:&RoomProject,revision:u64)->Result<()>{
        if rtc["role"]!="host" || rtc["phase"]!="connected"{return self.finish("disconnected");}
        let session=rtc["sessionId"].as_str().context("Missing RTC session identity")?;
        let context=Program::live(p,revision);
        let now=Instant::now();
        if self.active.as_ref().is_some_and(|(a,_)|a.session_id==session && a.on_stage==staged && a.program==context){
            if self.last_save.elapsed()>=Duration::from_secs(1){self.checkpoint(now,"observed")?;}
            return Ok(())
        }
        self.close(now,"transition")?;
        if session!=self.session {self.session=session.to_owned();self.closed_stage_ms=0;}
        let start=self.epoch_ms+now.duration_since(self.origin).as_millis() as u64;
        let span=Interval{id:format!("{start:016}-{}",new_id()?),session_id:session.into(),participant_id:rtc["participantId"].as_str().unwrap_or(session).into(),
            display_name:name(rtc["displayName"].as_str()),on_stage:staged,program:context,start_unix_ms:start,end_unix_ms:start,duration_ms:0,end_reason:"observed".into()};
        save(&self.dir.join("current.json"),&span)?;self.active=Some((span,now));self.last_save=now;Ok(())
    }
    fn checkpoint(&mut self,now:Instant,reason:&str)->Result<()>{
        if let Some((s,start))=&mut self.active{s.duration_ms=now.duration_since(*start).as_millis() as u64;
            s.end_unix_ms=s.start_unix_ms+s.duration_ms;s.end_reason=reason.into();save(&self.dir.join("current.json"),s)?;}
        self.last_save=now;Ok(())
    }
    fn close(&mut self,now:Instant,reason:&str)->Result<()>{
        if self.active.is_none(){return Ok(())}
        self.checkpoint(now,reason)?;
        let s=&self.active.as_ref().unwrap().0;
        fs::rename(self.dir.join("current.json"),self.dir.join(format!("{}.json",s.id)))?;
        fs::File::open(&self.dir)?.sync_all()?;
        if s.on_stage{self.closed_stage_ms+=s.duration_ms;}
        self.active=None;Ok(())
    }
    pub fn finish(&mut self,reason:&str)->Result<()>{self.close(Instant::now(),reason)}
    pub fn elapsed_ms(&self)->u64{self.closed_stage_ms+self.active.as_ref().filter(|(s,_)|s.on_stage).map_or(0,|(_,t)|t.elapsed().as_millis() as u64)}
    pub fn list(&self,who:Option<&str>,before:Option<&str>)->Result<Value>{
        let mut rows=Vec::new();
        for file in fs::read_dir(&self.dir)?{
            let path=file?.path();if path.extension().and_then(|v|v.to_str())!=Some("json"){continue;}
            let row:Interval=serde_json::from_slice(&fs::read(path)?)?;
            if who.is_some_and(|p|p!=row.participant_id)||before.is_some_and(|id|row.id.as_str()>=id){continue;}
            rows.push(row);
        }
        rows.sort_unstable_by(|a,b|b.id.cmp(&a.id));let more=rows.len()>100;rows.truncate(100);
        Ok(json!({"ok":true,"nextBefore":if more{rows.last().map(|r|&r.id)}else{None},"intervals":rows}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_session_stops_at_checkpoint_and_preserves_both_layouts() -> Result<()> {
        let root = std::env::temp_dir().join(format!("producer-stage-{}", new_id()?));
        fs::create_dir(&root)?;
        let mut project = RoomProject::demo();
        let identity = json!({"role":"host","phase":"connected","sessionId":"admission",
                              "participantId":"person","displayName":"Alex"});
        let mut history = History::open(&root)?;
        history.observe(&identity, true, &project, 1)?;
        project.scaffold_set("interview", "Interview")?;
        project.scene = "interview".into();
        history.observe(&identity, true, &project, 2)?;
        history.checkpoint(Instant::now(), "observed")?;
        let saved: Interval = serde_json::from_slice(&fs::read(root.join("stage-history/current.json"))?)?;
        drop(history);
        let recovered = History::open(&root)?;
        let rows = recovered.list(Some("person"), None)?;
        let spans = rows["intervals"].as_array().unwrap();
        assert_eq!(spans.len(), 2);
        let last = spans.iter().find(|r|r["program"]["setId"]=="interview").unwrap();
        assert_eq!(last["endReason"],"interruptedAtLastObservation");
        assert_eq!(last["durationMs"],saved.duration_ms);
        assert_eq!(last["program"]["layouts"][0]["path"],"sets/interview/layouts/landscape");
        assert_eq!(last["program"]["layouts"][1]["path"],"sets/interview/layouts/vertical");
        assert_eq!(recovered.list(Some("different"),None)?["intervals"],json!([]));
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
