/// A caller's display label is not a file identity. The command owner supplies
/// one nonce shared by both orientations, preserving the Portrait pairing.
pub fn unique_stamp(label: &str, nonce: &str) -> String {
    let mut clean = String::new();
    for c in label
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
        .take(80)
    {
        if clean.len() + c.len_utf8() > 160 {
            break;
        }
        clean.push(c);
    }
    let label = clean;
    let label = label.trim().trim_matches('.');
    format!(
        "{} {}",
        if label.is_empty() { "Recording" } else { label },
        nonce
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_labels_have_independent_paths() {
        assert_ne!(unique_stamp("Arena", "one"), unique_stamp("Arena", "two"));
    }
    #[test]
    fn labels_cannot_supply_paths_or_unbounded_names() {
        let s = unique_stamp("../room\\clip:\n", "nonce");
        assert!(!s.contains('/') && !s.contains('\\') && !s.contains(':') && !s.contains('\n'));
        assert!(unique_stamp(&"😀".repeat(1000), "x").len() <= 162);
        assert_eq!(unique_stamp("...", "x"), "Recording x");
    }
}
