// Fidelity check: Zig's standard library HTTP client over TLS, with the
// system's root certificates (docs/test-results.md, "Real-app fidelity"). Zig 0.16 (std.Io).
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var buf: [4096]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(io, &buf);
    const out = &stdout.interface;
    try out.print("FID start zig {s}\n", .{@import("builtin").zig_version_string});

    var client: std.http.Client = .{ .allocator = init.gpa, .io = io };
    defer client.deinit();
    var body: std.Io.Writer.Allocating = .init(init.gpa);
    defer body.deinit();
    if (client.fetch(.{ .location = .{ .url = "https://ziglang.org/" }, .response_writer = &body.writer })) |res| {
        if (res.status == .ok) {
            try out.print("FID ok https: std.http.Client, {d} bytes\n", .{body.written().len});
        } else {
            try out.print("FID fail https: HTTP {d}\n", .{@intFromEnum(res.status)});
        }
    } else |err| {
        try out.print("FID fail https: {s}\n", .{@errorName(err)});
    }

    const j = try std.json.parseFromSlice(struct { a: []const i64 }, init.gpa, "{\"a\": [1, 2]}", .{});
    defer j.deinit();
    if (j.value.a[1] == 2) try out.writeAll("FID ok json: std.json\n") else try out.writeAll("FID fail json\n");
    try out.writeAll("FID end\n");
    try out.flush();
}
