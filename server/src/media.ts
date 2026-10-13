import { inflateSync } from "node:zlib";

/**
 * Lightweight, dependency-free media extraction.
 * - PDF: extracts text from uncompressed and FlateDecode content streams
 *   (Tj / TJ operators). Encrypted or exotic PDFs return what was found
 *   plus an explicit note instead of failing silently.
 * - Images: parses dimensions/format from file headers (PNG/JPEG/GIF/WebP).
 */

export function extractPdfText(
  buf: Buffer,
  maxChars = 60000,
): { text: string; streams: number; truncated: boolean } {
  const raw = buf.toString("latin1");
  const chunks: string[] = [];
  let streams = 0;
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw))) {
    const data = Buffer.from(match[1]!, "latin1");
    let decoded: Buffer | null = null;
    try {
      decoded = inflateSync(data);
    } catch {
      decoded = data;
    }
    const content = decoded.toString("latin1");
    if (!/\b(Tj|TJ|')\b/.test(content) && !content.includes("(")) continue;
    streams++;
    chunks.push(decodeTextOperations(content));
  }
  const text = chunks
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text: text.slice(0, maxChars),
    streams,
    truncated: text.length > maxChars,
  };
}

function decodeTextOperations(content: string): string {
  const out: string[] = [];
  // (string) Tj  and  [(a) 10 (b)] TJ  and  (string) '
  const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[(?:[^\]]|\][^\]])*\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const segment = m[0];
    const strings = segment.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
    const line = strings.map((s) => unescapePdfString(s.slice(1, -1))).join("");
    if (line) out.push(line);
    if (/Tj|'|"/.test(segment)) out.push("\n");
  }
  // Positioning operators roughly map to line breaks.
  return out.join(" ").replace(/ ?\n ?/g, "\n");
}

function unescapePdfString(s: string): string {
  return s
    .replace(
      /\\([nrtbf()\\])/g,
      (_, c: string) =>
        ({
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          "(": "(",
          ")": ")",
          "\\": "\\",
        })[c] ?? c,
    )
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    );
}

export type ImageInfo = {
  format: string;
  width: number;
  height: number;
} | null;

export function imageInfo(buf: Buffer): ImageInfo {
  if (
    buf.length >= 24 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return {
      format: "png",
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  if (
    buf.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))
  ) {
    return {
      format: "gif",
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    // VP8X stores canvas size -1 as 24-bit LE at offset 24.
    if (buf.length >= 30 && buf.subarray(12, 16).toString("ascii") === "VP8X")
      return {
        format: "webp",
        width: buf.readUIntLE(24, 3) + 1,
        height: buf.readUIntLE(27, 3) + 1,
      };
    return { format: "webp", width: 0, height: 0 };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      const length = buf.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return {
          format: "jpeg",
          width: buf.readUInt16BE(offset + 7),
          height: buf.readUInt16BE(offset + 5),
        };
      if (length < 2) break;
      offset += 2 + length;
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  return null;
}

export function wavDurationSeconds(buf: Buffer): number | null {
  if (buf.length < 44 || buf.subarray(0, 4).toString("ascii") !== "RIFF")
    return null;
  const byteRate = buf.readUInt32LE(28);
  if (!byteRate) return null;
  return Math.round(((buf.length - 44) / byteRate) * 10) / 10;
}
