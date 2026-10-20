//! JSON-lines loop: one Request per stdin line, one Response per stdout
//! line, until EOF. Errors are per-line responses, never process aborts —
//! the TS worker treats a dead peripheral as a cycle failure, a per-line
//! error as a data failure.
use std::io::{self, BufRead, Write};

use holomap_clusterer::pipeline::run_pipeline;
use holomap_clusterer::protocol::{Response, PROTOCOL_VERSION};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(_) => break,
        };
        let response = match serde_json::from_str(&line) {
            Ok(request) => run_pipeline(&request),
            Err(e) => Response {
                protocol_version: PROTOCOL_VERSION,
                assignments: vec![],
                probabilities: None,
                error: Some(format!("bad request: {e}")),
            },
        };
        let out = serde_json::to_string(&response).expect("response serialises");
        writeln!(stdout, "{out}").expect("stdout write");
    }
}
