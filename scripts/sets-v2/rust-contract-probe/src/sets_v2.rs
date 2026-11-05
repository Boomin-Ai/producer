// Only serializer behavior is under test. Minimal resource type stubs satisfy
// the unrelated Plan fields; validation deliberately rejects those resources.
// This harness makes no claim to exercise chart/3D/transport validation.
mod chart {
    #[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
    pub struct Spec {
        pub id: String,
    }
    pub fn validate(_: &Spec) -> Result<(), String> {
        Err("Charts are outside the pure graphics serializer harness".into())
    }
}
mod scene3d {
    #[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
    pub struct Spec {
        pub id: String,
        pub pass: String,
    }
    pub fn validate(_: &Spec) -> Result<(), String> {
        Err("3D is outside the pure graphics serializer harness".into())
    }
}
#[path = "../../../../src-tauri/src/live/sets_v2/contract.rs"]
mod contract;

#[cfg(test)]
mod tests {
    use super::contract;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn authored_text_cannot_authorize_or_inject_another_script() {
        let text = "</script><script>window.secret='not executable'</script> & \"'";
        let node: contract::Node = serde_json::from_value(json!({
            "id":"label", "kind":"text", "bounds":{"x":0,"y":0,"width":80,"height":24},
            "properties":{"text":text}, "children":[]
        }))
        .unwrap();
        let canonical =
            contract::graphics_document(&[&node], 80, 24, (0., 0.), &HashMap::new()).unwrap();
        let painter = contract::graphics_painter_document(&canonical, 80, 24, &[27; 18]).unwrap();
        assert_eq!(painter.matches("<script>").count(), 1);
        assert!(painter.contains("&lt;/script&gt;&lt;script&gt;"));
        assert!(!painter.contains("<script>window.secret"));
        assert!(painter.contains("default-src 'none'") && painter.contains("base-uri 'none'"));
        assert!(!painter.contains("script-src 'unsafe-inline'"));
        let script = painter.split_once("<script>").unwrap().1;
        assert!(!script.contains("window.secret"));
        assert!(script.contains("const p=[[27, 27, 27]"));
    }

    #[test]
    fn fractional_density_preserves_authored_geometry_and_uses_physical_fence_row() {
        let canonical =
            contract::graphics_document_scaled(&[], 3, 5, (0., 0.), &HashMap::new(), 1.5).unwrap();
        let painter = contract::graphics_painter_document(&canonical, 5, 8, &[51; 18]).unwrap();
        assert!(painter.contains("html,body{margin:0;width:5px;height:9px;"));
        assert!(painter.contains("width:3px;height:5px;zoom:1.5"));
        assert!(painter.contains("top:8px;width:1px;height:1px;background:rgb("));
        assert!(painter.contains("position:fixed"));
        assert!(contract::graphics_painter_document(&canonical, 3, 5, &[51; 18]).is_err());
    }

    #[test]
    fn missing_receipts_and_invalid_bounds_fail_closed() {
        let canonical = contract::graphics_document(&[], 8, 9, (0., 0.), &HashMap::new()).unwrap();
        assert!(contract::graphics_painter_document("<html></html>", 8, 9, &[0; 18]).is_err());
        for (w, h) in [(0, 9), (8, 0), (8193, 9), (8, 8192)] {
            assert!(contract::graphics_painter_document(&canonical, w, h, &[0; 18]).is_err());
        }
        let changed_policy = canonical.replace("default-src 'none'", "default-src *");
        assert!(contract::graphics_painter_document(&changed_policy, 8, 9, &[0; 18]).is_err());
    }
}
