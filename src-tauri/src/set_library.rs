use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

const MAX_BYTES:u64=40*1024*1024;
fn folder(app:&tauri::AppHandle)->Result<std::path::PathBuf,String>{
    Ok(app.path().document_dir().map_err(|e|e.to_string())?.join("boomin/docs/shows"))
}
#[derive(Serialize)]
pub struct Entry{file:String,id:String,name:String}
fn read(path:&std::path::Path)->Result<String,String>{
    if std::fs::symlink_metadata(path).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Set file must not be a symbolic link".into());}
    let file=std::fs::File::open(path).map_err(|e|e.to_string())?;
    use std::io::Read;
    let mut bytes=Vec::new();file.take(MAX_BYTES+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() as u64>MAX_BYTES{return Err("Set package exceeds 40 MB".into());}
    String::from_utf8(bytes).map_err(|e|e.to_string())
}
fn identity(text:&str)->Result<(String,String),String>{
    let doc:Value=serde_json::from_str(text).map_err(|e|e.to_string())?;
    if !doc.get("set").is_some_and(Value::is_object){return Err("Not a set package".into());}
    Ok((doc["id"].as_str().ok_or("Set ID missing")?.into(),doc["name"].as_str().ok_or("Set name missing")?.into()))
}
fn safe_file(file:&str)->bool{!file.contains('/')&&!file.contains('\\')&&file.ends_with(".json")&&file!=".json"}
#[tauri::command]
pub fn set_library_list(app:tauri::AppHandle)->Result<Vec<Entry>,String>{
    let root=folder(&app)?;std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let mut entries=Vec::new();
    for item in std::fs::read_dir(root).map_err(|e|e.to_string())?{
        let Ok(item)=item else{continue};let file=item.file_name().to_string_lossy().into_owned();
        if !safe_file(&file){continue;}
        if let Ok(text)=read(&item.path()){if let Ok((id,name))=identity(&text){entries.push(Entry{file,id,name});}}
    }
    entries.sort_by(|a,b|a.name.cmp(&b.name).then(a.file.cmp(&b.file)));Ok(entries)
}
#[tauri::command]
pub fn set_library_read(app:tauri::AppHandle,file:String)->Result<String,String>{
    if !safe_file(&file){return Err("Invalid set filename".into());}read(&folder(&app)?.join(file))
}
#[tauri::command]
pub fn set_library_save(app:tauri::AppHandle,text:String)->Result<(),String>{
    if text.len() as u64>MAX_BYTES{return Err("Set package exceeds 40 MB".into());}
    let (id,_)=identity(&text)?;
    let slug:String=id.chars().filter(|c|c.is_ascii_alphanumeric()||*c=='-'||*c=='_').take(160).collect();
    if slug.is_empty(){return Err("Invalid set ID".into());}
    let root=folder(&app)?;std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let path=root.join(format!("{slug}.json"));
    if std::fs::symlink_metadata(&path).is_ok_and(|m|m.file_type().is_symlink()){return Err("Set file must not be a symbolic link".into());}
    let temporary=root.join(format!(".{}.tmp",uuid::Uuid::new_v4()));
    std::fs::write(&temporary,text).map_err(|e|e.to_string())?;std::fs::rename(temporary,path).map_err(|e|e.to_string())
}
