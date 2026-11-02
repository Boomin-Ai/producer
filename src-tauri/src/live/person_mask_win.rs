//! The licensed segmentation model is embedded, so a copied portable app cannot
//! silently lose Cutout's model. ONNX Runtime is staged beside the executable.
#[no_mangle]
extern "C" fn producer_person_mask_model(length: *mut usize) -> *const u8 {
    static MODEL: &[u8] =
        include_bytes!("vendor/pphumanseg/human_segmentation_pphumanseg_2023mar.onnx");
    if length.is_null() {
        return std::ptr::null();
    }
    unsafe {
        *length = MODEL.len();
    }
    MODEL.as_ptr()
}
