use holomap::Holomap;
use std::time::Instant;

fn main() {
    // 1k points, 50-d — deterministic pseudo-random data
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1000);
    let d = 50;
    let mut state = 0x9e3779b97f4a7c15_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f32 / (1u64 << 53) as f32 - 0.5
    };
    let data: Vec<f32> = (0..n * d).map(|_| next() * 10.0).collect();
    let t0 = Instant::now();
    let emb = Holomap::builder(42).fit_transform(&data, d).unwrap();
    println!(
        "n={n} d={d}: {:.2}s ({} coords)",
        t0.elapsed().as_secs_f64(),
        emb.len()
    );
}
