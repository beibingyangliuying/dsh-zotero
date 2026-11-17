// The entities and tags that arrive inside bibliographic text.
//
// Crossref serves text the way publishers deposited it, which is not the way it should be read: a
// journal named "Reliability Engineering & System Safety" arrives as "Reliability Engineering &amp;
// System Safety", and an abstract arrives as JATS markup. Stored verbatim, `&amp;` becomes five
// characters in the title and then in every citation built from it. Decoding belongs next to the
// reading, so this module holds the one implementation the metadata reader and the write tool share.

/**
 * Decode the HTML entities a bibliographic string may carry.
 *
 * Named entities are limited to the ones that appear in real deposits; an unknown entity is left
 * exactly as it came, because turning `&alpha;` into a guess would corrupt text this module cannot
 * verify. Numeric entities are decoded, since their meaning needs no table.
 *
 * @param {unknown} text The field as it arrived.
 * @returns {string} The same text with `&amp;`, `&#38;` and the like replaced.
 */
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return String(text ?? '').replace(/&(#?[a-z0-9]+);/gi, (match, body) => {
    if (body.startsWith('#')) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[body.toLowerCase()] ?? match
  })
}
