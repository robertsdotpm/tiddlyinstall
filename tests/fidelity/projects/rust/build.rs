// A C build step, as crates with native code have: compile native.c with the `cc` crate.
fn main() {
    println!("cargo:rerun-if-changed=native.c");
    cc::Build::new().file("native.c").compile("fidnative");
}
