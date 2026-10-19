(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});

  // MediaRecorder 的流式 WebM 没有 Duration；补齐后播放器能显示总时长。
  // Matroska Info/Duration 使用 TimestampScale 定义的 Segment Ticks。
  async function withDuration(blob, milliseconds) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    function element(at) {
      if (at >= bytes.length) return null;
      let idLength = 1;
      while (idLength <= 4 && !(bytes[at] & (1 << (8 - idLength)))) idLength++;
      if (idLength > 4) return null;
      let id = 0; for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i];
      const sizeAt = at + idLength;
      let sizeLength = 1;
      while (sizeLength <= 8 && !(bytes[sizeAt] & (1 << (8 - sizeLength)))) sizeLength++;
      if (sizeLength > 8) return null;
      let size = bytes[sizeAt] & ((1 << (8 - sizeLength)) - 1);
      let unknown = size === (1 << (8 - sizeLength)) - 1;
      for (let i = 1; i < sizeLength; i++) { size = size * 256 + bytes[sizeAt + i]; unknown = unknown && bytes[sizeAt + i] === 255; }
      const start = sizeAt + sizeLength;
      return { id, at, start, end: unknown ? bytes.length : start + size, size, unknown };
    }
    function sizeBytes(size) {
      let length = 1; while (size >= Math.pow(2, 7 * length) - 1) length++;
      const out = new Uint8Array(length);
      for (let i = length - 1; i >= 0; i--) { out[i] = size % 256; size = Math.floor(size / 256); }
      out[0] |= 1 << (8 - length);
      return out;
    }
    let segment = element(0);
    if (!segment || segment.id !== 0x1a45dfa3) return blob;
    segment = element(segment.end);
    if (!segment || segment.id !== 0x18538067 || !segment.unknown) return blob;
    const info = element(segment.start);
    if (!info || info.id !== 0x1549a966 || info.unknown) return blob;
    let scale = 1000000;
    for (let at = info.start; at < info.end;) {
      const item = element(at); if (!item || item.end > info.end || item.end <= at) return blob;
      if (item.id === 0x4489) return blob;
      if (item.id === 0x2ad7b1) {
        scale = 0; for (let i = item.start; i < item.end; i++) scale = scale * 256 + bytes[i];
      }
      at = item.end;
    }
    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88]);
    new DataView(duration.buffer).setFloat64(3, milliseconds * 1000000 / scale, false);
    return new Blob([bytes.subarray(0, info.at), bytes.subarray(info.at, info.at + 4),
      sizeBytes(info.size + duration.length), bytes.subarray(info.start, info.end), duration,
      bytes.subarray(info.end)], { type: blob.type });
  }
  CC.webm = { withDuration };
})();
