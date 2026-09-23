#ifndef TI_SHA256_H
#define TI_SHA256_H
void ti_sha256(const unsigned char *msg, unsigned long len, unsigned char out[32]);
void ti_sha256_hex(const unsigned char *msg, unsigned long len, char out[65]);
#endif
