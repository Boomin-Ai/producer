//! Authorable resources for the depth-tested geometry profile.
use crate::{validate::valid_id, Id};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GeometryScene {
    pub objects: Vec<MeshInstance>,
    pub camera: Vec<ShotKey>,
    pub portrait_camera: Option<Vec<ShotKey>>,
    pub light_direction: [f32; 3],
    pub light_color: [f32; 3],
    pub ambient: [f32; 3],
    /// Optional digest of a 2:1 equirectangular environment image in the room assets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MeshInstance {
    pub id: Id,
    pub mesh: Mesh,
    pub position: [f32; 3],
    pub scale: [f32; 3],
    pub rotation: [f32; 3],
    pub color: [f32; 3],
    pub roughness: f32,
    pub metallic: f32,
    #[serde(default)]
    pub emission: f32,
    /// UV engraving frequency. Zero selects a smooth surface.
    #[serde(default)]
    pub engraving: [f32; 2],
    /// Minor radius of the torus in units of its major radius.
    #[serde(default = "tube_radius")]
    pub tube: f32,
    /// Slot in the geometry pass's graph inputs, sampled as unlit video.
    pub input: Option<u8>,
    /// Logical aspect ratio for procedural textures. Defaults to the input pixel aspect.
    pub texture_aspect: Option<f32>,
}

fn tube_radius() -> f32 { 0.04 }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Mesh { Sphere, Torus, Panel, Disc, Glb { digest: String }, VertexClip { digest: String, #[serde(default)] phase: f32 } }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ShotKey {
    pub seconds: f32,
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub fov: f32,
}

impl GeometryScene {
    pub fn valid(&self, inputs: usize) -> bool {
        fn bounded(v: &[f32], min: f32, max: f32) -> bool {
            v.iter().all(|x| (min..=max).contains(x))
        }
        fn path(keys: &[ShotKey]) -> bool {
            (2..=32).contains(&keys.len()) && keys[0].seconds == 0.
            && keys.windows(2).all(|p| p[1].seconds - p[0].seconds >= 0.01)
            && keys.iter().all(|k| (0.0..=600.).contains(&k.seconds)
                && (12.0..=110.).contains(&k.fov)
                && bounded(&k.eye,-1000.,1000.) && bounded(&k.target,-1000.,1000.)
                && (0..3).any(|i|(k.eye[i]-k.target[i]).abs()>0.001))
        }
        let mut ids = std::collections::BTreeSet::new();
        self.environment.as_ref().is_none_or(|v|v.len()==64 && v.bytes().all(|b|b.is_ascii_hexdigit()))
        && (1..=64).contains(&self.objects.len()) && path(&self.camera)
        && self.portrait_camera.as_ref().is_none_or(|keys|path(keys))
        && bounded(&self.ambient,0.,1.) && bounded(&self.light_color,0.,4.)
        && bounded(&self.light_direction,-1.,1.) && self.light_direction.iter().any(|v|v.abs()>0.001)
        && self.objects.iter().all(|o| (!matches!(&o.mesh, Mesh::Glb { digest } | Mesh::VertexClip { digest, .. } if digest.len()!=64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()))) && !matches!(&o.mesh,Mesh::VertexClip{phase,..} if !(0.0..=600.0).contains(phase)) && valid_id(&o.id) && ids.insert(&o.id)
            && bounded(&o.position,-1000.,1000.) && bounded(&o.scale,0.001,1000.)
            && bounded(&o.rotation,-3600.,3600.) && bounded(&o.color,0.,1.)
            && (0.0..=1.).contains(&o.metallic) && (0.02..=1.).contains(&o.roughness)
            && (0.0..=2.).contains(&o.emission) && (0.001..=0.8).contains(&o.tube)
            && o.texture_aspect.is_none_or(|a|(0.05..=20.).contains(&a))
            && bounded(&o.engraving,0.,256.) && o.input.is_none_or(|i|usize::from(i)<inputs))
    }
}
