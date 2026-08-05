/**
 * The operator plane's own transport-invariant caps, and the ONE place they are
 * written down.
 *
 * Its own numbers rather than the consumer contract's, because they bound
 * different things: a consumer's page cap is a promise published to third
 * parties, an operator's is an operational choice about how much of a
 * deployment's state one call may move. Coupling them would make a change to one
 * silently move the other.
 *
 * That they currently hold the SAME values as two of the consumer's limits is a
 * coincidence, and a dangerous-looking one — which is exactly why they live in a
 * file of their own. The repository's literal-constant lint exempts this file by
 * name, so the exemption covers fifteen lines that exist to declare two numbers
 * rather than a six-hundred-line module that also happens to contain them.
 */
export const OPERATOR_LIMITS = {
  max_page_size: 200,
  default_page_size: 50
} as const;
