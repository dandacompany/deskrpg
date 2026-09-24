/**
 * Pack several PNGs into one .ico. Windows icons can embed PNGs as-is (Vista+),
 * so only the directory has to be written with no compression — that alone is why we add no dependency.
 */
export type IcoEntry = { size: number; png: Buffer };

export function packIco(entries: IcoEntry[]): Buffer {
  if (!entries.length) throw new Error("ico_needs_entries");
  if (entries.some((e) => e.size < 1 || e.size > 256)) throw new Error("ico_size_out_of_range");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 is written as 0 (format rule).
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // no palette
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}
