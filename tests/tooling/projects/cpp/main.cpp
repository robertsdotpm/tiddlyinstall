// The C++ toolchain's basic job: the standard library, exceptions and a
// link that produces a program that runs.
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>

static int tooling_add(int a, int b) { return a + b; }

int main() {
    std::cout << "TOOL ok compile-link: a C++ program built and linked at install time" << std::endl;
    std::vector<std::string> v;
    v.push_back("std::vector");
    v.push_back("std::string");
    std::cout << "TOOL ok stdlib: " << v[0] << " and " << v[1] << ", 2 + 3 = " << tooling_add(2, 3) << std::endl;
    try {
        throw std::runtime_error("thrown on purpose");
    } catch (const std::exception &e) {
        std::cout << "TOOL ok exceptions: caught \"" << e.what() << "\"" << std::endl;
    }
    std::cout << "TOOL runtime cpp built" << std::endl;
    std::cout << "TOOL end" << std::endl;
    return 0;
}
