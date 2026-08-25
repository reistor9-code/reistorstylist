/**
 * Category carousel artwork — 1080x565, the 1.91:1 that WhatsApp crops cards
 * to, so nothing is cut away on the way to the shopper.
 *
 * Run it with `npm run cards`. Reads assets/categories/<occasion>/<category>.jpg
 * and writes dashboard/public/categories/<occasion>/<category>.jpg, which is
 * what CATEGORY_IMAGES in src/catalog.ts points at.
 *
 * Two kinds of photograph arrive here and they cannot take the same crop:
 *
 *   A street shot has a model in frame, so it crops like the occasion cards —
 *   from the top, which puts the trim on the hem rather than the face.
 *
 *   A flat product shot is the whole garment on a plain background. Cropping
 *   a skirt to a wide band leaves a waistband and nothing else, so instead the
 *   background is trimmed away and the garment is centred on a canvas of that
 *   same colour. Because the original background is flat, the extension is
 *   invisible — it reads as a garment shot on a wide canvas rather than a
 *   photo with bars beside it.
 */
import sharp from 'sharp';
import { mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const W = 1080;
const H = 565;
const RATIO = W / H;

const SRC = 'assets/categories';
const OUT = 'dashboard/public/categories';

/** Vertical breathing room around a trimmed garment, as a share of height. */
const GARMENT_INSET = 0.06;

const CATEGORIES = ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'];

/** Sampled from a corner, which on a product shot is always the backdrop. */
async function backdrop(file) {
  const { data } = await sharp(file)
    .extract({ left: 0, top: 0, width: 24, height: 24 })
    .removeAlpha()
    .stats();
  const [r, g, b] = data ? [0, 0, 0] : [0, 0, 0];
  return { r, g, b };
}

async function cornerColour(file) {
  const [r, g, b] = await sharp(file)
    .extract({ left: 0, top: 0, width: 24, height: 24 })
    .resize(1, 1, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  return { r, g, b };
}

async function build(occasion, category) {
  const file = path.join(SRC, occasion, `${category}.jpg`);
  try {
    await access(file);
  } catch {
    return null;
  }

  const meta = await sharp(file).metadata();
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  const out = path.join(OUT, occasion, `${category}.jpg`);

  // Already the right shape: leave the photographer's framing alone.
  if (Math.abs(ratio - RATIO) < 0.06) {
    await sharp(file).resize(W, H, { fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
    return { category, treatment: 'as-is', from: `${meta.width}x${meta.height}` };
  }

  // A model in frame: crop from the top so the face survives.
  if (ratio > 1.25) {
    await sharp(file)
      .resize(W, H, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(out);
    return { category, treatment: 'top-crop', from: `${meta.width}x${meta.height}` };
  }

  // A garment on a backdrop: trim it, then centre it on that same colour.
  const bg = await cornerColour(file);
  const garment = await sharp(file)
    .trim({ threshold: 12 })
    .resize({ height: Math.round(H * (1 - GARMENT_INSET * 2)), fit: 'inside' })
    .toBuffer();
  const gm = await sharp(garment).metadata();

  await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
    .composite([
      {
        input: garment,
        left: Math.round((W - (gm.width ?? 0)) / 2),
        top: Math.round((H - (gm.height ?? 0)) / 2),
      },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(out);

  const hex = `#${[bg.r, bg.g, bg.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return {
    category,
    treatment: `padded ${hex}`,
    from: `${meta.width}x${meta.height}`,
    garment: `${gm.width}x${gm.height}`,
  };
}

const occasions = (await readdir(SRC, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const occasion of occasions) {
  await mkdir(path.join(OUT, occasion), { recursive: true });
  const rows = [];
  for (const category of CATEGORIES) {
    const row = await build(occasion, category);
    if (row) rows.push(row);
  }
  if (!rows.length) {
    console.log(`${occasion.padEnd(9)} — no artwork yet, falls back to the shared images`);
    continue;
  }
  console.log(`\n${occasion}`);
  for (const r of rows) {
    console.log(
      `  ${r.category.padEnd(10)} ${r.from.padEnd(10)} → ${W}x${H}  ${r.treatment}${
        r.garment ? `  garment ${r.garment}` : ''
      }`,
    );
  }
}

console.log(`\nWritten to ${OUT}/`);
