// image.ts — sharp 图片压缩：切图 4x→2x、封面→1x JPEG、视觉喂图 shrink
import sharp from 'sharp';

// 切图压缩：蓝湖 CDN 固定返回 4x（pixel = design frame × 4），resize 到设计尺寸的 2x 再用
// PNG 调色板压缩（保 alpha；实测同图 141KB RGBA32 → 2x 调色板约 1/4 体积）
export async function compressSlicePng(buf: Buffer, designW: number, designH: number): Promise<Buffer> {
  const targetW = designW > 0 ? Math.round(designW * 2) : undefined;
  const targetH = designH > 0 ? Math.round(designH * 2) : undefined;
  let pipeline = sharp(buf);
  if (targetW && targetH) pipeline = pipeline.resize(targetW, targetH, { fit: 'fill' });
  return pipeline.png({ palette: true, compressionLevel: 9, quality: 90 }).toBuffer();
}

// 封面图压到设计稿 1x（viewport 尺寸）JPEG：analyze 喂视觉模型用，
// 4x 封面 1.6MB → 1x JPEG 通常 <100KB。viewport 缺失时按最长边 1024 兜底
export async function coverTo1xJpeg(buf: Buffer, viewportW: number, viewportH: number): Promise<Buffer> {
  let pipeline = sharp(buf);
  if (viewportW > 0 && viewportH > 0) {
    pipeline = pipeline.resize(Math.round(viewportW), Math.round(viewportH), { fit: 'fill' });
  } else {
    pipeline = pipeline.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
  }
  return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
}

// 视觉工具入参图 shrink：截图/设计稿对比图统一压到最长边 1568（视觉模型有效分辨率上限）
// + JPEG q85，降低请求体积与 token 消耗；不放大
export async function shrinkForVision(buf: Buffer, maxSide = 1568): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}
