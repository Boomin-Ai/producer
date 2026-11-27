//! Native GLB profile: one baked mesh, indexed or unindexed triangles, material factors.
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use producer_production_contract::geometry::{GeometryScene, Mesh};
use sha2::{Digest, Sha256};

pub fn prepare(root: &std::path::Path, scene: &GeometryScene) -> Result<Vec<u8>> {
    let mut json = serde_json::to_value(scene)?;
    if let Some(hash) = &scene.environment {
        ensure!(hash.len()==64 && hash.bytes().all(|b|b.is_ascii_hexdigit()), "Invalid environment digest");
        let bytes=std::fs::read(root.join("assets").join(format!("{hash}.png")))?;
        ensure!(bytes.len()<=2_097_152 && format!("{:x}",Sha256::digest(&bytes))==*hash,"Invalid environment map");
        let reader=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format()?;
        let (width,height)=reader.into_dimensions()?;
        ensure!(width<=1024 && height<=512 && height*2==width,"Expected a bounded 2:1 environment map");
        let rgba=image::load_from_memory(&bytes)?.to_rgba8();
        json["probe"]=serde_json::json!({"width":width,"height":height,"pixels":STANDARD.encode(rgba.as_raw())});
    }
    let mut clip_ids = std::collections::BTreeMap::new();
    let mut clip_bytes = 0usize;
    let mut total = 0usize;
    for (i, object) in scene.objects.iter().enumerate() {
        if let Mesh::VertexClip {digest,phase} = &object.mesh {
            ensure!(digest.len()==64 && digest.bytes().all(|b|b.is_ascii_hexdigit()),"Invalid vertex clip digest");
            json["objects"][i]["mesh"]="vertexClip".into();
            json["objects"][i]["phase"]=(*phase).into();
            if let Some(previous)=clip_ids.insert(digest,i) {
                json["objects"][i]["sharedBuffer"]=serde_json::json!(previous);
                continue;
            }
            let path=root.join("assets").join(format!("{digest}.vclip"));
            let len=usize::try_from(std::fs::metadata(&path)?.len())?;
            clip_bytes=clip_bytes.checked_add(len).context("Clip size overflow")?;
            ensure!(len>=16 && clip_bytes<=32*1024*1024,"Vertex clip budget exceeded");
            let bytes=std::fs::read(path)?;
            ensure!(bytes.len()==len && format!("{:x}",Sha256::digest(&bytes))==*digest,"Invalid vertex clip");
            let word=|offset:usize|u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize;
            let (v,n,frames,fps)=(word(0),word(4),word(8),word(12));
            ensure!((3..=65535).contains(&v) && (3..=300000).contains(&n) && n%3==0 &&
                (2..=600).contains(&frames) && (1..=120).contains(&fps),"Invalid vertex clip header");
            ensure!(16+n*4+v*4+v*frames*16==len,"Invalid vertex clip length");
            ensure!((0..n).all(|i|word(16+4*i)<v),"Invalid vertex clip triangle");
            json["objects"][i]["vertices"]=STANDARD.encode(bytes).into();
            continue;
        }
        let Mesh::Glb { digest } = &object.mesh else { continue };
        ensure!(digest.len()==64 && digest.bytes().all(|b|b.is_ascii_hexdigit()), "Invalid GLB digest");
        let path = root.join("assets").join(format!("{digest}.glb"));
        ensure!(std::fs::metadata(&path)?.len() <= 8_388_608, "GLB exceeds import budget");
        let bytes = std::fs::read(path)?;
        ensure!(format!("{:x}", Sha256::digest(&bytes)) == *digest, "GLB digest mismatch");
        let glb = gltf::Gltf::from_slice(&bytes)?;
        ensure!(glb.meshes().count()==1 && glb.buffers().count()==1 && glb.textures().count()==0, "Expected a single baked material-factor GLB");
        let identity=[[1.,0.,0.,0.],[0.,1.,0.,0.],[0.,0.,1.,0.],[0.,0.,0.,1.]];
        ensure!(glb.nodes().count()==1 && glb.nodes().all(|node|node.mesh().is_some() && node.transform().matrix()==identity && node.skin().is_none())
                && glb.animations().count()==0,"Bake GLB node transforms and animation before importing");
        let blob = glb.blob.as_deref().context("Expected embedded GLB buffer")?;
        let mut vertices = Vec::new();
        for prim in glb.meshes().next().unwrap().primitives() {
            ensure!(prim.mode()==gltf::mesh::Mode::Triangles, "Expected triangle mesh");
            let reader = prim.reader(|_|Some(blob));
            let accessor=prim.get(&gltf::Semantic::Positions).context("Missing positions")?;
            ensure!(accessor.count()<=300_000,"GLB position budget exceeded");
            ensure!(prim.material().alpha_mode()==gltf::material::AlphaMode::Opaque && prim.morph_targets().len()==0,
                "Expected opaque static geometry");
            let positions: Vec<_> = reader.read_positions().context("Missing positions")?.collect();
            let normals: Vec<_> = reader.read_normals().context("Missing normals")?.collect();
            let pbr = prim.material().pbr_metallic_roughness();
            let color = pbr.base_color_factor();
            let emission = prim.material().emissive_factor();
            let count = reader.read_indices().map_or(positions.len(), |x|x.into_u32().len());
            total = total.checked_add(count).context("Vertex count overflow")?;
            ensure!(count%3==0 && total<=300_000, "GLB triangle budget exceeded");
            let indices: Vec<u32> = reader.read_indices().map_or_else(||(0..positions.len() as u32).collect(), |x|x.into_u32().collect());
            for index in indices {
                let p = positions.get(index as usize).context("Invalid vertex")?;
                let n = normals.get(index as usize).context("Invalid normal")?;
                for value in [p[0],p[1],p[2],1., n[0],n[1],n[2],pbr.roughness_factor(),color[0],color[1],color[2],pbr.metallic_factor(),emission[0],emission[1],emission[2],0.] {
                    ensure!(value.is_finite(), "Invalid GLB component");
                    vertices.extend(value.to_le_bytes());
                }
            }
        }
        ensure!(!vertices.is_empty(),"Empty GLB");
        json["objects"][i]["vertices"] = serde_json::Value::String(STANDARD.encode(vertices));
        json["objects"][i]["mesh"] = "glb".into();
    }
    Ok(serde_json::to_vec(&json)?)
}
