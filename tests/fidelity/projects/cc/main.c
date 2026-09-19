/* Fidelity check: a C program linking zlib (vendored source), threads and
   libm (docs/test-results.md, "Real-app fidelity"). Prints one "FID <ok|fail> <check>" line
   per check, then "FID end". */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "zlib.h"

static void *worker(void *arg) {
    int *n = (int *)arg;
    *n = *n * 2;
    return NULL;
}

int main(void) {
    printf("FID start cc %s\n", __VERSION__);

    const char *text = "hello hello hello hello hello hello hello hello";
    unsigned char packed[256], back[256];
    uLongf plen = sizeof packed, blen = sizeof back;
    if (compress(packed, &plen, (const Bytef *)text, strlen(text) + 1) == Z_OK &&
        uncompress(back, &blen, packed, plen) == Z_OK && strcmp((char *)back, text) == 0 &&
        crc32(0, (const Bytef *)"a", 1) == 0xe8b7be43UL)
        printf("FID ok zlib: zlib %s, %lu -> %lu bytes\n", zlibVersion(), (unsigned long)strlen(text) + 1, (unsigned long)plen);
    else
        printf("FID fail zlib: round trip\n");

    pthread_t t[4];
    int vals[4] = {1, 2, 3, 4}, ok = 1;
    for (int i = 0; i < 4; i++)
        if (pthread_create(&t[i], NULL, worker, &vals[i])) ok = 0;
    for (int i = 0; i < 4; i++) pthread_join(t[i], NULL);
    if (ok && vals[0] == 2 && vals[3] == 8) printf("FID ok threads: 4 pthreads\n");
    else printf("FID fail threads\n");

    volatile double x = 2.0;
    double r = sqrt(x) * cos(0.0);
    if (fabs(r - 1.41421356) < 1e-6) printf("FID ok libm: sqrt(2) = %.6f\n", r);
    else printf("FID fail libm: %f\n", r);

    printf("FID end\n");
    return 0;
}
