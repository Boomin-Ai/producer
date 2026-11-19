//! Bounded newline framing for inherited local pipes. An over-limit frame is
//! terminal: never keep draining an unbounded peer or reinterpret its suffix.
use crate::{fail, FRAME_BYTES};
use producer_production_core::contract::Result;
use std::io::{BufRead, Read};
pub fn read(input: &mut impl BufRead) -> Result<Option<Box<[u8]>>> {
    let mut bytes = Vec::new();
    let n = Read::by_ref(input)
        .take((FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| fail("STDIO", "transport read failed"))?;
    if n == 0 {
        return Ok(None);
    }
    if n > FRAME_BYTES {
        return Err(fail(
            "RAW_LIMIT",
            "RPC envelope too large; transport closed",
        ));
    }
    Ok(Some(bytes.into_boxed_slice()))
}
