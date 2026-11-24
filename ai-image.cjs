'use strict';
// Split large screenshots instead of shrinking small configuration text.
function prepareImages(bytes, nativeImage, decodedImage) {
  const image = decodedImage || nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw Error('无法读取图片，请另存为 PNG 或 JPEG 后重试。');
  const { width, height } = image.getSize();
  if (width > 16000 || height > 16000 || width * height > 60000000 || width * height < 200) throw Error('图片尺寸不适合识别，请裁剪后重试。');
  if (width <= 5120 && height <= 5120 && width * height <= 5242880 && Math.max(width, height) / Math.min(width, height) <= 200) {
    const png = image.toPNG();
    if (png.length <= 10 * 1024 * 1024) return { images: ['data:image/png;base64,' + png.toString('base64')], warnings: [] };
  }
  const edge = 2048, columns = Math.ceil(width / edge), rows = Math.ceil(height / edge);
  if (columns * rows > 16) throw Error('截图过大，请拆成几份后导入。');
  const images = [];
  for (let y = 0; y < height; y += edge) for (let x = 0; x < width; x += edge) {
    const left = Math.max(0, x - 48), top = Math.max(0, y - 48);
    const tileWidth = Math.min(edge + 48, width - left), tileHeight = Math.min(edge + 48, height - top);
    if (tileWidth * tileHeight < 200 || Math.max(tileWidth, tileHeight) / Math.min(tileWidth, tileHeight) > 200) throw Error('图片过于狭长，请裁剪后重试。');
    const tile = image.crop({ x: left, y: top, width: tileWidth, height: tileHeight });
    const png = tile.toPNG();
    if (png.length > 10 * 1024 * 1024) throw Error('图片分块超过 LongCat 限制，请裁剪后重试。');
    images.push('data:image/png;base64,' + png.toString('base64'));
  }
  if (images.reduce((n, x) => n + x.length, 0) > 28 * 1024 * 1024) throw Error('图片上传内容过大，请裁剪后重试。');
  return { images, warnings: images.length > 1 ? ['大图已分块识别，请核对跨分块的表格字段及重复内容。'] : [] };
}
// Electron nativeImage does not decode WebP on every platform. Chromium does;
// use a sandboxed, network-disabled decoder and keep the original attachment.
async function prepareImagesAsync(bytes, { nativeImage, BrowserWindow }) {
  const decoded = nativeImage.createFromBuffer(bytes);
  if (!decoded.isEmpty()) return prepareImages(bytes, nativeImage, decoded);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw Error('无法读取图片，请另存为 PNG 或 JPEG 后重试。');
  const decoder = new BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  let timer;
  try {
    const work = (async () => {
      await decoder.loadURL('data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">'));
      const url = 'data:image/webp;base64,' + bytes.toString('base64');
      const png = await decoder.webContents.executeJavaScript(`(async()=>{const i=new Image();i.src=${JSON.stringify(url)};await i.decode();if(i.naturalWidth>16000||i.naturalHeight>16000||i.naturalWidth*i.naturalHeight>60000000)throw Error('图片尺寸过大，请裁剪后重试');const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);return c.toDataURL('image/png');})()`);
      return prepareImages(bytes, nativeImage, nativeImage.createFromDataURL(png));
    })();
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('图片解码超时，请另存为 PNG 后重试。')), 10000); })]);
  } catch (error) { throw Error(error.message.includes('图片') ? error.message : '无法读取 WebP 图片，请另存为 PNG 后重试。'); }
  finally { clearTimeout(timer); decoder.destroy(); }
}
module.exports = { prepareImages, prepareImagesAsync };
