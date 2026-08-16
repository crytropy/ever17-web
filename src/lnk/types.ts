/** A single file entry inside a KID-engine LNK archive. */
export interface LnkEntry {
  name: string;
  /** Absolute byte offset of the file data within the archive. */
  offset: number;
  /** Uncompressed/stored size in bytes (the on-disk size field is `size << 1 | compressedFlag`). */
  size: number;
  /** Low bit of the raw size field. Not set for any entry of script.dat; kept for other .dat archives. */
  compressed: boolean;
  data: Buffer;
}

export interface LnkArchive {
  /** Number of entries declared in the header. */
  count: number;
  /** Byte offset where file data begins (end of the entry index). */
  dataStart: number;
  entries: LnkEntry[];
  /** Non-fatal validation findings (gaps, trailing bytes, ...). */
  warnings: string[];
}
