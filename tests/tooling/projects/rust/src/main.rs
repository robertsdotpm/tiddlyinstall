extern "C" {
    fn tooling_add(a: i32, b: i32) -> i32;
}

fn say(state: &str, name: &str, detail: &str) {
    println!("TOOL {} {}: {}", state, name, detail);
}

fn main() {
    let mut buf = itoa::Buffer::new();
    say("ok", "cargo-dependency", &format!("itoa from crates.io printed {}", buf.format(42)));
    say("ok", "cc-build-step", &format!("the C helper says {}", unsafe { tooling_add(2, 3) }));
    say("ok", "stdlib", &format!("rust target {}", std::env::consts::ARCH));
    println!("TOOL runtime rust built");
    println!("TOOL end");
}
