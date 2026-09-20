#ifndef IB_PLANCHECK_H
#define IB_PLANCHECK_H

#define IB_PLAN_OK 0
#define IB_PLAN_UNSIGNED 1
#define IB_PLAN_BAD 2

/*
 * buf: 64 bytes of scratch space followed by the plan's `len` bytes (the
 * scratch is overwritten). pk: the 32-byte Ed25519 public key. Returns
 * IB_PLAN_OK, IB_PLAN_UNSIGNED (the last line isn't a `sig` line) or
 * IB_PLAN_BAD; *why says why in English.
 */
int ib_plan_check(unsigned char *buf, unsigned long len, const unsigned char pk[32], const char **why);

/*
 * The same for another document signed with the plan key: `head` is what
 * the signed bytes must start with, "ib-plan\t" for a plan and
 * "ib-revocations\t" for a revocation list (docs/format.md section 7), so
 * one kind's signature can never be read as the other's.
 */
int ib_doc_check(unsigned char *buf, unsigned long len, const unsigned char pk[32], const char *head, const char **why);

/* Strict base64 of exactly outlen bytes. 0 on success. */
int ib_b64decode(const unsigned char *in, unsigned long inlen, unsigned char *out, unsigned long outlen);

#endif
