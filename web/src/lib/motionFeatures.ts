// Framer Motion's animation + layout engine, split out of the entry bundle.
// Call sites render the slim `m` components; App's <LazyMotion> loads this
// chunk after first paint, and the tab-bar / segmented-control pills start
// animating once it lands. domMax (not domAnimation) because both pills use
// layoutId.
export { domMax as default } from 'framer-motion'
