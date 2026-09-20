// A crate with a C build step, so the C toolchain is exercised too
// (cc-rs is what ring, libsqlite3-sys and zstd-sys use).
fn main() {
    cc::Build::new().file("src/helper.c").compile("helper");
}
