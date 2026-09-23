#ifndef TI_RTCHECK_H
#define TI_RTCHECK_H

#define TI_RT_OK 0
#define TI_RT_NONE 1     /* nothing to check: no roots, no such target */
#define TI_RT_BAD 2      /* a claim that does not hold */

/*
 * Is the runtime install script in this plan one we published?
 *
 * `plan` is the plan file's bytes, `pk` the Ed25519 public key the
 * installer carries, `target` the 1-based index of the [target] block
 * the engine selected. `issued` gets the roots document's date.
 *
 * All of it decided from the plan and the key: no network, no
 * catalogue. See src/shared/rtscript.js for what is signed and why.
 */
int ti_rt_check(const unsigned char *plan, unsigned long len,
                const unsigned char pk[32], long target,
                char issued[64], const char **why);

#endif
