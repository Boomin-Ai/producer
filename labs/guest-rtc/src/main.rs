mod apm;
mod fixture;
mod queue;
mod transport;

#[tokio::main(worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("apm-fixture") => {
            let dir = args.next().unwrap_or_else(|| "evidence/apm".into());
            let speech = args.next();
            fixture::run(std::path::Path::new(&dir), speech.as_deref().map(std::path::Path::new))
        }
        Some("transport") => {
            let token = args.next().ok_or_else(|| anyhow::anyhow!("Token file required"))?;
            let output = args.next().ok_or_else(|| anyhow::anyhow!("Evidence file required"))?;
            let seconds = args.next().unwrap_or_else(|| "30".into()).parse()?;
            let pressure = args.next().as_deref() == Some("pressure");
            transport::run(std::path::Path::new(&token), std::path::Path::new(&output), seconds, pressure).await
        }
        _ => anyhow::bail!("Usage: producer-guest-rtc-lab apm-fixture <output-directory> | transport <token-file> <evidence-json> [seconds] [pressure]"),
    }
}
