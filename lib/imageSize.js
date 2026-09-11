/**
 * Dependency-free image header reader.
 *
 * The only consumer is the 场景图 waterfall's height reservation, so this reads
 * a header and nothing else — no decoding, no image library, no new dependency.
 * PNG / GIF / JPEG / WebP are covered, which is every format the store accepts.
 *
 * Returning `null` is a first-class answer, not a failure: the caller must treat
 * it as "unknown" and draw the photo at its natural ratio. Guessing a ratio is
 * exactly what stretches an image, so a guess is never an acceptable fallback.
 */

/** PNG: 8-byte signature, then the IHDR chunk carries the size. */
function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** GIF: "GIF87a"/"GIF89a", then the logical screen descriptor. */
function gifSize(buffer) {
  if (buffer.length < 10) return null;
  if (buffer.toString("latin1", 0, 3) !== "GIF") return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/** JPEG: walk the segment chain to the first Start-Of-Frame marker. */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15 minus the three markers in that range that are not frames.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP: RIFF container; the three chunk variants each store the size differently. */
function webpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") return null;
  const format = buffer.toString("latin1", 12, 16);
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    return {
      width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
      height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1
    };
  }
  return null;
}

/**
 * @param {Buffer} buffer leading bytes of an image file (a header is plenty).
 * @returns {{width: number, height: number}|null} `null` when the format is
 *   unsupported, the bytes are truncated, or the size is not positive.
 */
function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  let size = null;
  try {
    size = pngSize(buffer) || gifSize(buffer) || jpegSize(buffer) || webpSize(buffer);
  } catch (error) {
    // A truncated or hostile header must degrade to "unknown", never throw:
    // this runs over file bytes the store did not author.
    return null;
  }
  if (!size) return null;
  if (!(size.width > 0) || !(size.height > 0)) return null;
  return { width: size.width, height: size.height };
}

module.exports = { readImageSize };
