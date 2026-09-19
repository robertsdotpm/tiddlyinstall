// Fidelity check: a Rust program with C build steps (docs/test-results.md, "Real-app fidelity").
extern "C" {
    fn fid_twice(x: i32) -> i32;
}

fn main() {
    println!("FID start rust {}", std::env::consts::OS);
    let v = unsafe { fid_twice(21) };
    if v == 42 {
        println!("FID ok cc-build-step: native.c compiled by build.rs");
    } else {
        println!("FID fail cc-build-step: got {}", v);
    }
    match rusqlite::Connection::open_in_memory().and_then(|c| c.query_row("select sqlite_version()", [], |r| r.get::<_, String>(0))) {
        Ok(v) => println!("FID ok bundled-sqlite: libsqlite3-sys bundled, SQLite {}", v),
        Err(e) => println!("FID fail bundled-sqlite: {}", e),
    }
    println!("FID end");
}
