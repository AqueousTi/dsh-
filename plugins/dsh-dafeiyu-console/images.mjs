// Small, dependency-free container/size checks. Browser decoding remains client-side.
export const MAX_AVATAR_BYTES = 1_000_000;

export function validCharacterId(id) {
  return typeof id === 'string' && /^[\w\u4e00-\u9fa5-]{1,64}$/.test(id) &&
    /[\w\u4e00-\u9fa5]/.test(id) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(id);
}

function invalid(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export function checkedAvatar(dataUrl) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl));
  if (!match) invalid('图片只支持 PNG、JPEG、WebP 的标准 base64 data URL');
  if (match[2].length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) invalid('图片不能超过 1 MB', 413);
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) invalid('图片 base64 编码无效');
  if (bytes.length > MAX_AVATAR_BYTES) invalid('图片不能超过 1 MB', 413);
  let width, height;
  if (match[1] === 'png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') invalid('PNG 文件头或结束块无效');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (match[1] === 'jpeg') {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 ||
        bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid('JPEG 文件头或结束标记无效');
    const frames = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    let offset = 2;
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 255) invalid('JPEG 段结构无效');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) invalid('JPEG 段被截断');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid('JPEG 段长度无效');
      if (frames.has(marker)) {
        if (length < 8) invalid('JPEG 尺寸段无效');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else {
    if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('WebP 文件头或长度无效');
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const packed = bytes.readUInt32LE(21);
      width = (packed & 16383) + 1; height = ((packed >>> 14) & 16383) + 1;
    } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) {
    invalid('图片尺寸无效或过大（最长边 4096，最多 800 万像素）');
  }
  return { bytes, ext: match[1] === 'jpeg' ? 'jpg' : match[1], width, height };
}
