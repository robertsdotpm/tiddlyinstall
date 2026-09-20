#ifndef TI_PLANCHECK_H
#define TI_PLANCHECK_H

#define TI_PLAN_OK 0
#define TI_PLAN_UNSIGNED 1
#define TI_PLAN_BAD 2

/*
 * buf: 64 bytes of scratch space followed by the plan's `len` bytes (the
 * scratch is overwritten). pk: the 32-byte Ed25519 public key. Returns
 * TI_PLAN_OK, TI_PLAN_UNSIGNED (the last line isn't a `sig` line) or
 * TI_PLAN_BAD; *why says why in English.
 */
int ti_plan_check(unsigned char *buf, unsigned long len, const unsigned char pk[32], const char **why);

/*
 * The same for another document signed with the plan key: `head` is what
 * the signed bytes must start with, "ti-plan\t" for a plan and
 * "ti-revocations\t" for a revocation list (docs/format.md section 7), so
 * one kind's signature can never be read as the other's.
 */
int ti_doc_check(unsigned char *buf, unsigned long len, const unsigned char pk[32], const char *head, const char **why);

/* Strict base64 of exactly outlen bytes. 0 on success. */
int ti_b64decode(const unsigned char *in, unsigned long inlen, unsigned char *out, unsigned long outlen);

#endif
