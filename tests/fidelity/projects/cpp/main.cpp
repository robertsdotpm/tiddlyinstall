// Fidelity check: the C++ standard library features a C++17 compiler's
// default standard gives real programs (docs/test-results.md, "Real-app fidelity").
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <variant>
#include <vector>

namespace fs = std::filesystem;

template <typename F>
static void check(const char *name, F fn) {
    try {
        std::string d = fn();
        std::cout << "FID ok " << name << (d.empty() ? "" : ": " + d) << std::endl;
    } catch (const std::exception &e) {
        std::cout << "FID fail " << name << ": " << e.what() << std::endl;
    }
}

int main() {
    std::cout << "FID start cpp " << __VERSION__ << " __cplusplus=" << __cplusplus << std::endl;
    check("threads", [] {
        std::atomic<int> n{0};
        std::mutex m;
        std::vector<std::thread> ts;
        for (int i = 0; i < 4; i++) ts.emplace_back([&] { std::lock_guard<std::mutex> g(m); n += 1; });
        for (auto &t : ts) t.join();
        if (n != 4) throw std::runtime_error("count " + std::to_string(n.load()));
        return std::string("4 std::threads");
    });
    check("filesystem", [] {
        fs::path d = fs::temp_directory_path() / "fidcpp";
        fs::create_directories(d);
        { std::ofstream(d / "a.txt") << "hello"; }
        auto size = fs::file_size(d / "a.txt");
        fs::remove_all(d);
        if (size != 5) throw std::runtime_error("size");
        return std::string("std::filesystem");
    });
    check("cxx17", [] {
        std::optional<int> o = 3;
        std::variant<int, std::string> v = std::string("x");
        std::string_view sv = "abc";
        auto [a, b] = std::pair<int, int>(1, 2);
        if (!o || std::get<std::string>(v) != "x" || sv.size() != 3 || a + b != 3) throw std::runtime_error("wrong");
        return std::string("optional, variant, string_view, structured bindings");
    });
    check("regex-iostream", [] {
        std::regex re("(\\w+)@(\\w+)");
        std::smatch m;
        std::string s = "me@example";
        if (!std::regex_search(s, m, re) || m[2] != "example") throw std::runtime_error("regex");
        std::ostringstream os;
        os << 1.5 << ' ' << std::hex << 255;
        if (os.str() != "1.5 ff") throw std::runtime_error(os.str());
        auto p = std::make_unique<std::map<std::string, int>>();
        (*p)["a"] = 1;
        return std::string("regex, iostreams, containers");
    });
    check("exceptions", [] {
        try {
            throw std::out_of_range("x");
        } catch (const std::out_of_range &) {
            return std::string("thrown and caught");
        }
        return std::string("not caught");
    });
    std::cout << "FID end" << std::endl;
    return 0;
}
