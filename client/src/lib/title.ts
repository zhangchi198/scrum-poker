/**
 * Tab-title flash for nudges. Remembers the exact previous title (stories may contain " — " or anything else)
 * and restores it verbatim; `setBase` changes the title underneath a running flash without losing the flash.
 */
export function createTitleFlasher(doc: { title: string }, ms = 6000) {
  let base: string | null = null;
  let flash = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    flash(text: string) {
      if (base === null) base = doc.title;
      flash = text;
      doc.title = `${text} — ${base}`;
      clearTimeout(timer);
      timer = setTimeout(() => {
        doc.title = base ?? doc.title;
        base = null;
      }, ms);
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
