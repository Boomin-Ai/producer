//! Trusted, bounded GPU presets. Packages select parameters, never shader code.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderEffect {
    pub effect: String,
    pub colors: Vec<String>,
    pub speed: f64,
    pub intensity: f64,
    pub scale: f64,
    pub opacity: f64,
    pub radius: f64,
    pub quality: String,
    pub clock: String,
}
impl ShaderEffect {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.effect.as_str(),
            "aurora"
                | "edgeGlow"
                | "lightSweep"
                | "plasma"
                | "silk"
                | "rings"
                | "grid"
                | "stars"
                | "petals"
                | "contours"
                | "prism"
                | "borderFlare"
        ) || !matches!(self.quality.as_str(), "low" | "medium")
            || !matches!(self.clock.as_str(), "show" | "segment")
            || self.colors.len() != 3
            || self.colors.iter().any(|c| {
                c.len() != 7
                    || !c.starts_with('#')
                    || !c[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
            || ![
                self.speed,
                self.intensity,
                self.scale,
                self.opacity,
                self.radius,
            ]
            .iter()
            .all(|v| v.is_finite())
            || !(0.0..=4.0).contains(&self.speed)
            || !(0.0..=2.0).contains(&self.intensity)
            || !(0.25..=4.0).contains(&self.scale)
            || !(0.0..=1.0).contains(&self.opacity)
            || !(0.0..=960.0).contains(&self.radius)
        {
            return Err("Invalid shader preset or parameters".into());
        }
        Ok(())
    }
}
pub fn native_effect() -> String {
    let body = include_str!("../../../src/features/presentation/shader-kernel.glsl")
        .replace("vec2", "float2")
        .replace("vec3", "float3")
        .replace("vec4", "float4")
        .replace("mix(", "lerp(")
        .replace("fract(", "frac(")
        .replace("atan(", "atan2(");
    format!("uniform float4x4 ViewProj;\nuniform float clockTime;uniform float effectType;uniform float speed;uniform float intensity;uniform float frequency;uniform float radius;uniform float alpha;uniform float2 extent;uniform float4 paletteA;uniform float4 paletteB;uniform float4 paletteC;\nstruct VertData {{float4 pos:POSITION;float2 uv:TEXCOORD0;}};\nVertData VSDefault(VertData v){{VertData o;o.pos=mul(float4(v.pos.xyz,1.0),ViewProj);o.uv=v.uv;return o;}}\n{body}\nfloat4 PSDefault(VertData v):TARGET{{return shade(v.uv);}}\ntechnique Draw{{pass{{vertex_shader=VSDefault(v);pixel_shader=PSDefault(v);}}}}\n")
}
#[cfg(have_engine)]
pub unsafe fn create(
    config: &ShaderEffect,
    width: f32,
    height: f32,
) -> Result<*mut super::ffi::obs_source_t, String> {
    config.validate()?;
    let mut data = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let o = data.as_object_mut().unwrap();
    o.insert("width".into(), serde_json::json!(width));
    o.insert("height".into(), serde_json::json!(height));
    for (i, name) in ["colorA", "colorB", "colorC"].iter().enumerate() {
        o.insert(name.to_string(), serde_json::json!(config.colors[i]));
    }
    let settings = std::ffi::CString::new(data.to_string()).unwrap();
    let effect = std::ffi::CString::new(native_effect()).unwrap();
    let source = super::ffi::producer_shader_create(settings.as_ptr(), effect.as_ptr());
    if source.is_null() {
        Err("Native shader compilation failed".into())
    } else if super::ffi::obs_source_get_width(source) == 0
        || super::ffi::obs_source_get_height(source) == 0
    {
        super::ffi::obs_source_release(source);
        Err("Native shader compilation failed".into())
    } else {
        Ok(source)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_presets() {
        let mut s = ShaderEffect {
            effect: "aurora".into(),
            colors: vec!["#000000".into(); 3],
            speed: 1.,
            intensity: 1.,
            scale: 1.,
            opacity: 1.,
            radius: 20.,
            quality: "low".into(),
            clock: "segment".into(),
        };
        assert!(s.validate().is_ok());
        s.intensity = 3.;
        assert!(s.validate().is_err());
        s.intensity = 1.;
        s.effect = "imported-code".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn shared_kernel() {
        let s = native_effect();
        assert!(s.contains("float4 shade(float2 uv)"));
        assert!(!s.contains("vec2"));
        assert!(!s.contains("texture2d"));
    }
}
