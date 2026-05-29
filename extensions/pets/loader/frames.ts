import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";
import type { LoadedPet } from "./pet-loader.js";

export interface RgbaFrame {
  width: number;
  height: number;
  /** Length = width * height * 4. Order: R, G, B, A. */
  rgba: Uint8ClampedArray;
}

export async function extractFrames(pet: LoadedPet): Promise<RgbaFrame[]> {
  const buffer = await readFile(pet.spritesheetAbsPath);
  const image = await Jimp.read(buffer);

  const { frame } = pet.manifest;
  const totalFrames = frame.columns * frame.rows;
  const frames: RgbaFrame[] = [];

  for (let index = 0; index < totalFrames; index++) {
    const column = index % frame.columns;
    const row = Math.floor(index / frame.columns);
    const subImage = image.clone().crop({
      x: column * frame.width,
      y: row * frame.height,
      w: frame.width,
      h: frame.height,
    });
    const rgba = new Uint8ClampedArray(subImage.bitmap.data.buffer.slice(
      subImage.bitmap.data.byteOffset,
      subImage.bitmap.data.byteOffset + subImage.bitmap.data.byteLength,
    ));
    frames.push({ width: frame.width, height: frame.height, rgba });
  }

  return frames;
}
