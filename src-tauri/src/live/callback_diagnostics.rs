//! Best-effort diagnostics for native callbacks. A failed stderr must not
//! panic across an extern C boundary and abort the renderer.
use std::fmt;
use std::io::{self, Write};

pub(super) fn write_stderr(message: fmt::Arguments<'_>) {
    write_line(&mut io::stderr().lock(), message);
}

fn write_line(writer: &mut impl Write, message: fmt::Arguments<'_>) {
    // Deliberately no fallback logging: the fallback could fail recursively.
    let _ = writer.write_fmt(format_args!("{message}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailedSink(io::ErrorKind);
    impl Write for FailedSink {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(self.0))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn failed_diagnostics_do_not_unwind() {
        for kind in [
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::WriteZero,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
        ] {
            write_line(&mut FailedSink(kind), format_args!("draw {}", 600));
        }
    }

    #[test]
    fn successful_diagnostics_keep_message_and_newline() {
        let mut output = Vec::new();
        write_line(&mut output, format_args!("draw {}", 600));
        assert_eq!(output, b"draw 600\n");
    }
}
