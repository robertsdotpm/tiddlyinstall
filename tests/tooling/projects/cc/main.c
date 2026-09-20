/* The C toolchain's basic job: several translation units, the maths
   library, and a link that produces a program that runs. */
#include <stdio.h>
#include <math.h>

extern int tooling_add(int a, int b);

int main(void) {
    printf("TOOL ok compile-link: two translation units linked into one program\n");
    printf("TOOL ok libm: sqrt(2) = %.5f\n", sqrt(2.0));
    printf("TOOL ok helper: 2 + 3 = %d\n", tooling_add(2, 3));
    printf("TOOL runtime cc built\n");
    printf("TOOL end\n");
    return 0;
}
