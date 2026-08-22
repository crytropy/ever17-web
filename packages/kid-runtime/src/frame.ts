import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync, deflateSync, crc32 } from "node:zlib";
import type { AssetResolver } from "./assets.js";
import type { SceneStateSnapshot } from "./types.js";
import { DEFAULT_GAME_PROFILE, type GameProfile } from "kid-contracts/profile";

/**
 * Headless frame compositor: background + sprites (+ a plain text band) into a
 * single RGBA image. This exists to prove that IR state and decoded assets line
 * up geometrically - it is deliberately not a UI.
 */

export interface Raster {
  width: number;
  height: number;
  rgba: Buffer;
}

export function decodePng(buf: Buffer): Raster {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  // Undo per-row filters (our own encoder writes filter 0, but decode the
  // full set so externally-produced PNGs also work).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x]!;
      const a = x >= 4 ? rgba[dst + x - 4]! : 0;
      const b = y > 0 ? rgba[dst - stride + x]! : 0;
      const c = x >= 4 && y > 0 ? rgba[dst - stride + x - 4]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      rgba[dst + x] = v & 0xff;
    }
  }
  return { width, height, rgba };
}

function encodePng(r: Raster): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const stride = r.width * 4;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    raw[y * (stride + 1)] = 0;
    r.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function blit(dst: Raster, src: Raster, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const a = src.rgba[s + 3]! / 255;
      if (a === 0) continue;
      if (a === 1) {
        src.rgba.copy(dst.rgba, d, s, s + 4);
      } else {
        for (let k = 0; k < 3; k++) {
          dst.rgba[d + k] = Math.round(src.rgba[s + k]! * a + dst.rgba[d + k]! * (1 - a));
        }
        dst.rgba[d + 3] = 255;
      }
    }
  }
}

/** Flat translucent band standing in for the message window. */
function textBand(frame: Raster): void {
  const bandTop = frame.height - 130;
  for (let y = bandTop; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const d = (y * frame.width + x) * 4;
      for (let k = 0; k < 3; k++) {
        frame.rgba[d + k] = Math.round(frame.rgba[d + k]! * 0.25);
      }
    }
  }
}

export interface FrameLabels {
  speaker: string | null;
  text: string;
}

/** Compose one story moment into a PNG. */
export function renderFrame(
  state: SceneStateSnapshot,
  assets: AssetResolver,
  _labels: FrameLabels,
  profile: GameProfile = DEFAULT_GAME_PROFILE,
): Buffer {
  const { width: SCREEN_W, height: SCREEN_H } = profile.canvas;
  const frame: Raster = {
    width: SCREEN_W,
    height: SCREEN_H,
    rgba: Buffer.alloc(SCREEN_W * SCREEN_H * 4),
  };
  // opaque base (fill colour 1 = white, anything else = black)
  const base = state.fill === 1 ? 255 : 0;
  for (let i = 0; i < frame.rgba.length; i += 4) {
    frame.rgba[i] = base;
    frame.rgba[i + 1] = base;
    frame.rgba[i + 2] = base;
    frame.rgba[i + 3] = 255;
  }

  if (state.background?.file) {
    const bg = decodePng(readFileSync(join(assets.baseDir, state.background.file)));
    blit(frame, bg, 0, Math.max(0, SCREEN_H - bg.height));
  }
  for (const sprite of state.sprites) {
    if (!sprite.file) continue;
    const img = decodePng(readFileSync(join(assets.baseDir, sprite.file)));
    // Sprites stand on the bottom edge of the frame.
    blit(frame, img, sprite.x ?? Math.round((SCREEN_W - img.width) / 2), SCREEN_H - img.height);
  }
  textBand(frame);
  return encodePng(frame);
}
