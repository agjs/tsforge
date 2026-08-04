/** RFC 6901 JSON Pointer parsing. */

/** Decode one escaped segment. Order matters: `~1` → `/` FIRST, then `~0` → `~`.
 *  Doing it the other way turns `~01` into `/` instead of `~1`. */
export function decodeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Split a pointer into decoded segments. `""` is the whole document. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") {
    return [];
  }

  return pointer.split("/").slice(1).map(decodeSegment);
}
