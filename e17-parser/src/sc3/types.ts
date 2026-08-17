/** Parsed SC3 container header (16 bytes). */
export interface Sc3Header {
  /** Offset of the chunk-offset table; also the end of the code region. */
  textTableOffset: number;
  /** Offset *inside* the chunk-offset table where text entries end and resource entries begin. */
  graphicsListOffset: number;
  /**
   * Address of the first instruction after the optional `10 24` scene-id preamble.
   * Equals the end of the entry-address table when there is no preamble
   * (startup.scr, system.scr). Historically called "header size".
   */
  codeStartOffset: number;
}

/** One chunk from the trailing chunk area. */
export interface Chunk {
  index: number;
  offset: number;
  /** Raw bytes, up to the next chunk offset (chunks are NOT all NUL-terminated strings). */
  data: Buffer;
}

export interface ResourceChunk extends Chunk {
  /** Decoded asset name when the chunk is a well-formed NUL-terminated ASCII string. */
  name?: string;
}

/** Container-level split of one .scr file. */
export interface Sc3File {
  name: string;
  header: Sc3Header;
  /**
   * Entry-address table: sorted u32 file offsets starting at 0x10.
   * Jump/choice targets reference this table with 1-based indexes.
   */
  entryPoints: number[];
  /** File offset right after the entry table = first byte of code. */
  codeRegionStart: number;
  /** File offset where code ends (== textTableOffset). */
  codeRegionEnd: number;
  textChunks: Chunk[];
  resourceChunks: ResourceChunk[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type ExprToken =
  | { kind: "imm"; value: number; /** encoded byte length incl. class byte */ width: number }
  | { kind: "op"; op: number };

/**
 * A raw expression: token stream as stored in the file.
 * `immTerminated` records whether the empirical "extra 00 after a trailing
 * immediate" pad byte was present (true for every expression whose last token
 * is an immediate; see docs/sc3-format.md).
 */
export interface RawExpr {
  tokens: ExprToken[];
  immPad: boolean;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export type Operand =
  | { kind: "expr"; expr: RawExpr }
  | { kind: "u8"; value: number }
  | { kind: "u16"; value: number }
  | { kind: "entryRef"; /** 1-based index into entryPoints */ index: number }
  | { kind: "raw"; bytes: Buffer }
  | { kind: "string"; value: string }
  | { kind: "textRef"; index: number }
  | { kind: "u16list"; values: number[] };

export type Confidence = "confirmed" | "high" | "medium" | "low" | "unknown";

export interface Instruction {
  address: number;
  /** Raw bytes of the whole instruction. */
  raw: Buffer;
  /** Mnemonic from the opcode table, or "UNKNOWN". */
  mnemonic: string;
  /** Opcode key bytes (1 or 2). */
  opcode: Buffer;
  operands: Operand[];
  confidence: Confidence;
}

/** A region of the code segment that could not be decoded as instructions. */
export interface DataRegion {
  address: number;
  bytes: Buffer;
  reason: string;
  /** Set when the region decodes as a NUL-separated ASCII string table. */
  strings?: string[];
}

export interface Disassembly {
  instructions: Instruction[];
  dataRegions: DataRegion[];
  /** Bytes decoded as instructions or recognized padding. */
  coveredBytes: number;
  totalBytes: number;
}
