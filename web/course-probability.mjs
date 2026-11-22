const valid = probability => Number.isFinite(probability) && probability >= 0 && probability <= 1
const label = tenths => String(tenths / 10) + '%'

/** Display at most one decimal; this never changes the stored model estimate. */
export function formatCourseProbability(probability, missing = '—') {
  return valid(probability) ? label(Math.round(probability * 1000)) : missing
}

/** Quantize Yes once, then derive No in integer tenths so the pair totals 100%. */
export function courseProbabilityPair(probability, missing = '—') {
  if (!valid(probability)) return { yes: missing, no: missing }
  const yes = Math.round(probability * 1000)
  return { yes: label(yes), no: label(1000 - yes) }
}
