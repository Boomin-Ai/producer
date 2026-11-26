//! Resolve desk paint while constructing a Rune view. Program pixels are separate.
use super::{Color, BG, MINT, MUTED, PANEL, SURFACE, TEXT};
use crate::workspace::DeskTheme;
use std::cell::Cell;
// Classic colors double as identifiers for the desk paint resolver.
pub(super) const ROW: u32 = 0x111b25;
pub(super) const AVATAR: u32 = 0x152635;
pub(super) const TAB_BORDER: u32 = 0x20303d;
pub(super) const SELECTED_HOVER: u32 = 0x224c40;
pub(super) const TOOL_ICON: u32 = 0xaab4c2;
pub(super) const TOOL_SELECTED: u32 = 0x16352e;
pub(super) const TOOL: u32 = 0x0d151f;
pub(super) const TRANSPORT_BORDER: u32 = 0x213343;
pub(super) const TRANSPORT: u32 = 0x14212d;
pub(super) const TRACK_SELECTED: u32 = 0x18342e;
pub(super) const TRACK: u32 = 0x121f29;
pub(super) const SLIDER_RAIL_COMPACT: u32 = 0x2a3d4c;
pub(super) const SLIDER_RAIL: u32 = 0x354857;
pub(super) const SLIDER_VALUE: u32 = 0x99b6c2;
pub(super) const SEAM: u32 = 0x202b35;
pub(super) const GRIP: u32 = 0x47616d;
pub(super) const GRIP_HOVER: u32 = 0x293b47;

thread_local! { static CURRENT: Cell<DeskTheme> = const { Cell::new(DeskTheme::Classic) }; }

pub(super) fn with<T>(theme: DeskTheme, view: impl FnOnce() -> T) -> T {
    let previous = CURRENT.replace(theme);
    let result = view();
    CURRENT.set(previous);
    result
}
pub(super) fn orbital() -> bool { CURRENT.get() == DeskTheme::OrbitalGreen }

pub(super) fn color(token: u32) -> Color {
    let rgb = if orbital() {
        match token {
            BG => 0x060f10,
            PANEL | 0x0b151f | 0x101923 => 0x0b1919,
            SURFACE | 0x111d28 | 0x16232e => 0x192e2c,
            TEXT => 0xecf6f1,
            MUTED => 0x9cb6ac,
            MINT => 0x7be9ad,
            0x193a32 | 0x17372f => 0x155238,
            0x263443 | 0x304151 | 0x273745 | 0x344856 => 0x2c4840,
            0x24343e | 0x21303c => 0x254438,
            ROW => 0x132522,
            AVATAR => 0x223c34,
            TAB_BORDER => 0x29443b,
            SELECTED_HOVER => 0x206747,
            TOOL_ICON => 0xb1c7bc,
            TOOL_SELECTED => 0x194832,
            TOOL => 0x10201c,
            TRANSPORT_BORDER => 0x30493f,
            TRANSPORT => 0x192e28,
            TRACK_SELECTED => 0x194832,
            TRACK => 0x142622,
            SLIDER_RAIL_COMPACT => 0x30483f,
            SLIDER_RAIL => 0x395449,
            SLIDER_VALUE => 0x7be9ad,
            SEAM => 0x21352e,
            GRIP => 0x49695c,
            GRIP_HOVER => 0x2c443a,
            value => value,
        }
    } else { token };
    rune::color::hex(&format!("#{rgb:06x}")).unwrap()
}
