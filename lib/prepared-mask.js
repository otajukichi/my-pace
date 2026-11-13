/** Paint the already-computed reveal mask. No route comparison on the device. */
export function paintPreparedMask(ctx, tiles, { x, y, z, ratio = 1, color, revealColor, revealOpacity = 0 }, makeCanvas) {
  const size = 256, n = 2 ** z, wx = (x % n + n) % n, scale = 2 ** (z - 16);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'destination-out'; ctx.imageSmoothingEnabled = true;
  for (const tile of tiles) {
    let canvas = masks.get(tile);
    if (!canvas) {
      canvas = makeCanvas(); canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d'), data = c.createImageData(64, 64);
      for (let i = 0; i < tile.cells.length; i++) data.data[i * 4 + 3] = tile.cells[i];
      c.putImageData(data, 0, 0); masks.set(tile, canvas);
    }
    ctx.drawImage(canvas, (tile.x * scale - wx) * size, (tile.y * scale - y) * size, size * scale, size * scale);
  }
  if (revealOpacity > 0) {
    ctx.globalCompositeOperation = 'destination-over'; ctx.globalAlpha = Math.min(1, revealOpacity); ctx.fillStyle = revealColor; ctx.fillRect(0, 0, size, size);
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
}
const masks = new WeakMap();
