//! Only an explicitly chosen, downsampled preview enters a model request.
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};
use producer_production_contract::{Asset, AssetKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Cursor, Read, Write}, path::{Path,PathBuf}};

#[derive(Clone)]
pub struct Attachment {
    pub name: String,
    pub asset: Option<(String,Asset)>,
    preview: String,
}
impl Attachment {
    pub fn content(&self)->[Value;2] {
        let asset=self.asset.as_ref().map(|(id,_)|id);
        [json!({"type":"input_text","text":json!({"name":self.name,"purpose":if asset.is_some(){"production"}else{"inspiration"},"assetId":asset}).to_string()}),
         json!({"type":"input_image","image_url":self.preview,"detail":"auto"})]
    }
}
pub fn load(path:PathBuf,production:bool,root:&Path)->Result<Attachment>{
    let limit=12*1024*1024;
    let mut bytes=Vec::new();
    fs::File::open(&path)?.take(limit+1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64<=limit,"Choose an image smaller than 12 MB.");
    let format=image::guess_format(&bytes)?;
    ensure!(matches!(format,ImageFormat::Png|ImageFormat::Jpeg|ImageFormat::WebP|ImageFormat::Gif),"Choose a PNG, JPEG, WebP or GIF image.");
    let (w,h)=image::ImageReader::with_format(Cursor::new(&bytes),format).into_dimensions()?;
    ensure!(u64::from(w)*u64::from(h)<=24_000_000,"Image is too large to preview.");
    if production {ensure!(w<=4096 && h<=4096 && u64::from(w)*u64::from(h)<=8_388_608,"This image exceeds the set texture budget.");}
    let decoded=image::load_from_memory_with_format(&bytes,format)?;
    let preview=decoded.thumbnail(768,768).to_rgb8();
    let mut jpeg=Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg,70).encode_image(&preview)?;
    ensure!(jpeg.len()<=256*1024,"Choose a smaller image for the assistant preview.");
    let asset=if production{
        if format!=ImageFormat::Png {
            let mut out=Cursor::new(Vec::new());DynamicImage::ImageRgba8(decoded.to_rgba8()).write_to(&mut out,ImageFormat::Png)?;
            bytes=out.into_inner();
        }
        ensure!(bytes.len()<=16*1024*1024,"Decoded texture exceeds 16 MB.");
        let hash=format!("{:x}",Sha256::digest(&bytes));
        let dir=root.join("assets");fs::create_dir_all(&dir)?;
        let path=dir.join(format!("{hash}.png"));
        let mut temp=tempfile::NamedTempFile::new_in(&dir)?;temp.write_all(&bytes)?;temp.persist(path)?;
        Some((format!("img-{}",&hash[..24]),Asset{hash,kind:AssetKind::Image,available:None}))
    }else{None};
    Ok(Attachment{name:path.file_name().context("Missing image name")?.to_string_lossy().into_owned(),asset,preview:format!("data:image/jpeg;base64,{}",STANDARD.encode(jpeg))})
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn reference_stays_private_and_asset_round_trips(){
        let room=tempfile::tempdir().unwrap();
        let path=room.path().join("studio.png");
        DynamicImage::new_rgba8(40,30).save(&path).unwrap();
        let reference=load(path.clone(),false,room.path()).unwrap();
        assert!(reference.asset.is_none() && !room.path().join("assets").exists());
        assert_eq!(reference.content()[1]["type"],"input_image");
        let production=load(path.clone(),true,room.path()).unwrap();
        let (id,asset)=production.asset.unwrap();
        use producer_production_core::commands::{Command,Operation};
        let mut project=crate::model::RoomProject::demo();
        project.command(Command::Transaction{operations:vec![Operation::AddAsset{id:id.clone(),value:asset.clone()}]}).unwrap();
        let set=project.production.sets.get("studio").unwrap();
        let mut candidate=serde_json::to_value(set).unwrap();
        candidate["layouts"]["landscape"]["root"]["style"]=json!({"fill":{"kind":"image","asset":id,"fit":"contain"}});
        let candidate=serde_json::from_value(candidate).unwrap();
        crate::engine::set_edit_project(&project,"studio",&candidate).unwrap().compile().unwrap();
        assert_eq!(fs::read(room.path().join("assets").join(format!("{}.png",asset.hash))).unwrap(),fs::read(path).unwrap());
    }
}
