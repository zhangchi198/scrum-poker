/**
 * Tab-title flash for nudges. Remembers the exact previous title (stories may contain " — " or anything else)
 * and restores it verbatim; `setBase` changes the title underneath a running flash without losing the flash.
 */
export function createTitleFlasher(doc: { title: string }, ms = 6000) {
  let base: string | null = null;
  let flash = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    /** Flashes `text` in the title for `ms` (the default, or until `clear()` when Infinity). */
    flash(text: string, forMs = ms) {
      if (base === null) base = doc.title;
      flash = text;
      doc.title = `${text} — ${base}`;
      clearTimeout(timer);
      if (forMs !== Infinity) timer = setTimeout(() => this.clear(), forMs);
    },
    /** Restores the title now. Safe to call when nothing is flashing. */
    clear() {
      clearTimeout(timer);
      if (base !== null) doc.title = base;
      base = null;
    },
    setBase(title: string) {
      if (base === null) doc.title = title;
      else {
        base = title;
        doc.title = `${flash} — ${title}`;
      }
    },
  };
}
