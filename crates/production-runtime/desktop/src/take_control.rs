//! Local operation journal. Never issue another activation for an existing key,
//! including when the process stopped between render adoption and receipt sync.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{fs::{self,File},io::Write,path::{Path,PathBuf},sync::Mutex};

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Key {
    pub operation_id:String,
    pub expected_program_revision:u64,
    pub permission_epoch:u64,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Receipt {
    #[serde(flatten)]
    pub key:Key,
    pub status:String,
    pub effective_revision:Option<u64>,
    pub detail:Option<String>,
}
#[derive(Serialize,Deserialize)]
pub struct Grant { pub epoch:u64, pub enabled:bool }
pub struct Journal { dir:PathBuf, grant:Mutex<Grant> }
pub(crate) fn save(path:&Path, value:&impl Serialize)->Result<()> {
    let tmp=path.with_extension("pending");
    let mut file=File::create(&tmp)?;
    serde_json::to_writer(&mut file,value)?;
    file.flush()?;file.sync_all()?;
    fs::rename(tmp,path)?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
impl Journal {
    pub fn open(root:&Path)->Result<Self> {
        let dir=root.join("take-operations");fs::create_dir_all(&dir)?;
        File::open(root)?.sync_all()?;
        let path=dir.join("grant.json");
        let grant=if path.exists(){serde_json::from_slice(&fs::read(path)?)?}else{
            let initial=Grant{epoch:1,enabled:true};save(&path,&initial)?;initial
        };
        Ok(Self{dir,grant:Mutex::new(grant)})
    }
    fn path(&self,id:&str)->Result<PathBuf>{
        ensure!(!id.is_empty() && id.len()<=96 && id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'),"Invalid Take ID");
        Ok(self.dir.join(format!("op-{id}.json")))
    }
    pub fn outcome(&self,id:&str)->Result<Receipt>{
        Ok(serde_json::from_slice(&fs::read(self.path(id)?)?)?)
    }
    pub fn permission(&self,permission:&str,epoch:u64,enable:bool)->Result<serde_json::Value>{
        ensure!(permission=="program.take","Unknown permission");
        let mut g=self.grant.lock().unwrap();
        ensure!(epoch==g.epoch,"Permission epoch changed");
        if g.enabled!=enable {
            let next=Grant{epoch:g.epoch.checked_add(1).ok_or_else(||anyhow::anyhow!("Grant epoch exhausted"))?,enabled:enable};
            save(&self.dir.join("grant.json"),&next)?;*g=next;
        }
        Ok(serde_json::json!({"ok":true,"permissionEpoch":g.epoch,"enabled":g.enabled}))
    }
    pub fn legacy<T>(&self, apply:impl FnOnce()->Result<T>)->Result<T>{
        let g=self.grant.lock().unwrap();ensure!(g.enabled,"Take permission revoked");apply()
    }
    pub fn execute<T>(&self,key:&Key,revision:u64,prepare:impl FnOnce()->Result<T>,activate:impl FnOnce(T,u64)->Result<()>)->Result<Receipt>{
        let path=self.path(&key.operation_id)?;
        let mut r=Receipt{key:key.clone(),status:"preparing".into(),effective_revision:None,detail:None};
        {
            let g=self.grant.lock().unwrap();
            if path.exists(){
                let mut old=self.outcome(&key.operation_id)?;
                ensure!(&old.key==key,"Operation ID reused with different preconditions");
                // Only the serial program-control owner enters execute. A nonterminal
                // record seen here survived a stopped or interrupted owner.
                if old.status=="preparing" || old.status=="activating" {
                    old.status=if old.status=="preparing"{"interrupted"}else{"indeterminate"}.into();
                    save(&path,&old)?;
                }
                return Ok(old);
            }
            if !g.enabled||g.epoch!=key.permission_epoch {r.status="revoked".into();}
            else if revision!=key.expected_program_revision {r.status="revisionConflict".into();}
            save(&path,&r)?;
        }
        if r.status!="preparing"{return Ok(r)}
        let prepared=match prepare(){Ok(p)=>p,Err(e)=>{r.status="failed".into();r.detail=Some(e.to_string());save(&path,&r)?;return Ok(r)}};
        let g=self.grant.lock().unwrap();
        if !g.enabled||g.epoch!=key.permission_epoch{r.status="revoked".into();save(&path,&r)?;return Ok(r)}
        let next=revision.checked_add(1).ok_or_else(||anyhow::anyhow!("Program revision exhausted"))?;
        r.status="activating".into();save(&path,&r)?;
        match activate(prepared,next){
            Ok(())=>{
                #[cfg(debug_assertions)]
                {
                    // One-shot local qualification fault for this exact operation.
                    // Keep rendering long enough for both segment writers to checkpoint;
                    // the applied receipt cannot be synced while this thread is parked.
                    let arm = self.dir.join(format!("p0-crash-after-render-{}",key.operation_id));
                    if arm.is_file() {
                        fs::remove_file(arm)?;
                        save(&self.dir.join("p0-render-return.json"), &serde_json::json!({
                            "operationId":key.operation_id,"rendererAcknowledgedRevision":next,
                            "pid":std::process::id(),"checkpointWaitMs":3200
                        }))?;
                        std::thread::sleep(std::time::Duration::from_millis(3200));
                        unsafe { libc::raise(libc::SIGKILL); }
                        std::process::abort();
                    }
                }
                r.status="applied".into();r.effective_revision=Some(next);
            }
            Err(e)=>{r.status="indeterminate".into();r.detail=Some(e.to_string());}
        }
        save(&path,&r)?;Ok(r)
    }
}
