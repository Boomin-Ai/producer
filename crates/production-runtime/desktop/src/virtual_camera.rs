use crate::engine::Handle;
use std::{ffi::{c_char,c_void,CStr}, sync::{Arc,Mutex,mpsc}, thread, time::Duration};

extern "C" {
    fn nr_vcam_open(portrait:bool,error:*mut c_char,cap:usize)->*mut c_void;
    fn nr_vcam_frame(writer:*mut c_void,pixel:*mut c_void,pts:f64)->i32;
    fn nr_vcam_close(writer:*mut c_void);
    fn producer_vcam_installed()->i32;
    fn producer_vcam_activate();
    fn producer_vcam_open_settings();
    fn producer_vcam_state(error:*mut c_char,len:i32)->i32;
}

pub fn install_status()->(String,bool) {
    if unsafe { producer_vcam_installed() } != 0 { return ("Producer Virtual Camera installed".into(),false); }
    let mut bytes=[0;512];
    let state=unsafe { producer_vcam_state(bytes.as_mut_ptr(),512) };
    let detail=unsafe { CStr::from_ptr(bytes.as_ptr()) }.to_string_lossy();
    match state {
        0|4 => (if detail.is_empty() {"Install Producer Virtual Camera".into()} else {format!("Retry installation · {detail}")},true),
        1|3 => ("Waiting for virtual camera registration…".into(),false),
        2 => ("Approve virtual camera in System Settings".into(),true),
        _ => (detail.into_owned(),false),
    }
}
pub fn install() {
    if unsafe { producer_vcam_state(std::ptr::null_mut(),0) } == 2 { unsafe { producer_vcam_open_settings() } }
    else { unsafe { producer_vcam_activate() } }
}

#[derive(Default)]
pub struct Camera {
    worker:Option<(mpsc::Sender<()>,thread::JoinHandle<()>)>,
    status:Arc<Mutex<String>>,
}
impl Camera {
    pub fn active(&self)->bool { self.worker.as_ref().is_some_and(|(_,j)|!j.is_finished()) }
    pub fn status(&self)->String { self.status.lock().unwrap().clone() }
    pub fn stop(&mut self) {
        if let Some((tx,j))=self.worker.take() { let _=tx.send(()); let _=j.join(); }
    }
    pub fn start(&mut self,room:Arc<Handle>,portrait:bool) {
        self.stop();
        let (tx,rx)=mpsc::channel();
        let status=self.status.clone();
        *status.lock().unwrap()="Starting virtual camera…".into();
        let job=thread::spawn(move || {
            let mut error=[0;256];
            let writer=unsafe { nr_vcam_open(portrait,error.as_mut_ptr(),error.len()) };
            if writer.is_null() {
                *status.lock().unwrap()=unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned();
                return;
            }
            let mut previous=None;
            let mut failed=false;
            *status.lock().unwrap()="Waiting for program video…".into();
            while !room.closed.load(std::sync::atomic::Ordering::Acquire) &&
                matches!(rx.recv_timeout(Duration::from_millis(8)),Err(mpsc::RecvTimeoutError::Timeout)) {
                let media=room.media.lock().unwrap().clone();
                let frame=media.and_then(|m|m.frames[if portrait {4} else {3}].lock().unwrap().clone());
                if let Some(f)=frame {
                    if previous==Some(f.at) {continue;}
                    previous=Some(f.at);
                    match unsafe { nr_vcam_frame(writer,f.ptr.as_ptr(),f.at) } {
                        1 => { let mut text=status.lock().unwrap(); if !text.starts_with("Sending") {
                            *text=if portrait {"Sending portrait program"} else {"Sending landscape program"}.into(); } }
                        0 => (),
                        _ => { failed=true; break; }
                    }
                }
            }
            unsafe { nr_vcam_close(writer) };
            *status.lock().unwrap()=if failed {"Virtual camera frame delivery failed. Reconnect the receiver and retry."} else {"Virtual camera stopped"}.into();
        });
        self.worker=Some((tx,job));
    }
}
impl Drop for Camera { fn drop(&mut self){self.stop()} }
