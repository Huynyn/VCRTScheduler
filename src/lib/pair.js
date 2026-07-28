// Helpers for canonical ordering of a two-person avoidance pair.
// Kept in a non-JSX file so both the React context and the pure
// solver modules (and Node-based tests) can import it.
export function makePair(a, b) {
  return a < b ? [a, b] : [b, a];
}
export function pairKey(pair) {
  return `${pair[0]}::${pair[1]}`;
}
