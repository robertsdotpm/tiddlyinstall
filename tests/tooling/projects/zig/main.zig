// Zig's own tooling. Zig's standard library changes shape every release,
// so this file follows 0.16 (as tests/fidelity does); `zig cc`, which is
// the part other runtimes depend on, is covered across Zig versions by the
// `cc` and `cpp` rows, where C/C++ on Linux and macOS is zig (policy "via").
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var buf: [4096]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(init.io, &buf);
    const out = &stdout.interface;
    try out.print("TOOL ok zig-build-exe: this program was built by `zig build-exe` at install time\n", .{});
    try out.print("TOOL skip zig-fetch: the site builds a single main.zig with build-exe, so there is no build.zig.zon to fetch into\n", .{});
    try out.print("TOOL ok stdlib: zig {s}\n", .{@import("builtin").zig_version_string});
    try out.print("TOOL runtime zig {s}\n", .{@import("builtin").zig_version_string});
    try out.print("TOOL end\n", .{});
    try out.flush();
}
