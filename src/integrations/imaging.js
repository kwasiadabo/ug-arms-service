/**
 * Image metadata extraction and derivative generation using sharp.
 *
 * Preservation masters are never modified or shown publicly; these functions only read them to produce the smaller
 * access copies and thumbnails that the viewer displays. The sharp cache is disabled so that memory is released
 * between large images in the long-running worker.
 *
 * @author Kwasi Adabo Boakye
 */

import sharp from 'sharp';

sharp.cache(false);
const RASTER = ['image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/jp2'];

/**
 * Tells whether a media type is a raster image that can be processed by sharp (JPEG, PNG, TIFF, WebP or JPEG 2000).
 *
 * @param {string} mediaType Detected media type of the file.
 * @returns {boolean}
 */
export const isRaster = (mediaType) => RASTER.includes(mediaType);

/**
 * Reads the technical metadata of an image: dimensions, format, colour space, channels, bit depth, resolution,
 * embedded colour profile, page count and orientation.
 *
 * @param {string} filePath Path of the image.
 * @returns {Promise<object>} The image metadata, including the name and version of the tool that read it.
 */
export async function imageMetadata(filePath) {
  const m = await sharp(filePath, { limitInputPixels: 1e9 }).metadata();
  return {
    width: m.width,
    height: m.height,
    format: m.format,
    space: m.space,
    channels: m.channels,
    depth: m.depth,
    density: m.density ?? null,
    hasProfile: Boolean(m.icc),
    pages: m.pages ?? 1,
    orientation: m.orientation ?? null,
    tool: `sharp ${sharp.versions.sharp}`,
  };
}

/**
 * Creates the access copy and thumbnail for an image.
 *
 * The first page of the image is rotated according to its orientation tag. The access copy is a JPEG whose longer
 * edge is at most 2,400 pixels; the thumbnail is a JPEG of at most 400 pixels. Images are never enlarged.
 *
 * @param {string} filePath Path of the preservation master.
 * @returns {Promise<{ access: { buffer: Buffer, width: number, height: number }, thumbnail: { buffer: Buffer,
 *   width: number, height: number } }>}
 */
export async function makeDerivatives(filePath) {
  const base = sharp(filePath, { limitInputPixels: 1e9, page: 0 }).rotate();
  const access = await base
    .clone()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await base
    .clone()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer({ resolveWithObject: true });
  return {
    access: { buffer: access.data, width: access.info.width, height: access.info.height },
    thumbnail: { buffer: thumb.data, width: thumb.info.width, height: thumb.info.height },
  };
}
