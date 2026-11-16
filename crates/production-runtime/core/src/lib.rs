//! Isolated headless runtime. Never linked into the production app in Phase 1.
pub use producer_production_contract as contract;
pub mod bounded;
pub mod commands;
pub mod compile;
pub mod coordinator;
pub mod drivers;
pub mod incremental;
pub mod lifecycle;
pub mod resources;
pub mod storage;
pub mod timeline;
pub mod transport;
pub mod workspace;
