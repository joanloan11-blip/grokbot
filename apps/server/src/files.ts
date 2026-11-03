import { inflateRawSync } from 'node:zlib';

export function extractUploadText(
  name: string,
  mime: string,
  bytes: Buffer,
): string {
  const lower = name.toLowerCase();
  if (
    mime.startsWith('text/') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md')
  ) {
    return bytes.toString('utf8').slice(0, 100_000);
  }
  if (lower.endsWith('.pdf') || mime === 'application/pdf')
    return pdfText(bytes).slice(0, 100_000);
  if (lower.endsWith('.docx'))
    return zipText(bytes, 'word/document.xml').slice(0, 100_000);
  if (lower.endsWith('.xlsx'))
    return zipText(bytes, 'xl/sharedStrings.xml').slice(0, 100_000);
  if (mime.startsWith('image/')) return `[изображение ${name}]`;
  return '';
}

function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)) {
    const text = match[0]
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\([()\\])/g, '$1');
    if (/[A-Za-zА-Яа-я0-9]/.test(text)) parts.push(text);
  }
  return parts.join('\n');
}

function zipText(bytes: Buffer, wanted: string): string {
  const xml = readZipEntry(bytes, wanted);
  if (!xml) return '';
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Минимальный разбор ZIP (store и deflate) для офисных файлов. */
export function readZipEntry(bytes: Buffer, name: string): string | undefined {
  let offset = 0;
  while (offset + 30 < bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const method = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 18);
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLen + extraLen;
    const entryName = bytes
      .subarray(offset + 30, offset + 30 + nameLen)
      .toString('utf8');
    const data = bytes.subarray(start, start + compressed);
    if (entryName === name) {
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      return undefined;
    }
    offset = start + compressed;
  }
  return undefined;
}
