/**
 * Compara la captura original con cómo se ve el clon y prepara imágenes para
 * que la IA vea las diferencias: original a la izquierda, clon a la derecha
 * con las zonas distintas marcadas en rojo. También da un porcentaje de
 * parecido para decidir si merece la pena otra ronda de corrección.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("imagen no válida"));
    img.src = src;
  });
}

export interface Comparison {
  /** 0–1: proporción de la página que coincide */
  score: number;
  /** Imágenes «original | clon con diferencias en rojo», de arriba abajo */
  composites: string[];
}

const CELL = 8;
const CELL_THRESHOLD = 0.1;
const MAX_SEGMENTS = 5;

export async function compareImages(originalSrc: string, renderedSrc: string): Promise<Comparison> {
  const [orig, rend] = await Promise.all([loadImage(originalSrc), loadImage(renderedSrc)]);
  const ratio = orig.naturalHeight / orig.naturalWidth;
  let cw = Math.min(760, orig.naturalWidth, rend.naturalWidth);
  let segH = Math.round(cw * 1.25);
  let totalH = Math.round(cw * ratio);
  if (Math.ceil(totalH / segH) > MAX_SEGMENTS) {
    cw = Math.max(240, Math.floor(cw * Math.sqrt((MAX_SEGMENTS * segH) / totalH)));
    segH = Math.round(cw * 1.25);
    totalH = Math.round(cw * ratio);
  }

  const draw = (img: HTMLImageElement, h: number) => {
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = totalH;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, totalH);
    ctx.drawImage(img, 0, 0, cw, h);
    return { c, data: ctx.getImageData(0, 0, cw, totalH).data };
  };
  const a = draw(orig, totalH);
  // El clon se dibuja con su propia proporción: si es más corto o más largo, esa diferencia también cuenta
  const b = draw(rend, Math.round((cw * rend.naturalHeight) / rend.naturalWidth));

  const cols = Math.ceil(cw / CELL);
  const rows = Math.ceil(totalH / CELL);
  const marked = new Uint8Array(cols * rows);
  let matching = 0;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      let n = 0;
      for (let y = r * CELL; y < Math.min(totalH, (r + 1) * CELL); y += 2) {
        for (let x = col * CELL; x < Math.min(cw, (col + 1) * CELL); x += 2) {
          const i = (y * cw + x) * 4;
          sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
          n++;
        }
      }
      const diff = n ? sum / (n * 765) : 0;
      if (diff > CELL_THRESHOLD) marked[r * cols + col] = 1;
      else matching++;
    }
  }

  const composites: string[] = [];
  const gap = 20;
  const header = 26;
  const segments = Math.ceil(totalH / segH);
  for (let y0 = 0; y0 < totalH; y0 += segH) {
    const part = segments > 1 ? ` · parte ${Math.round(y0 / segH) + 1}/${segments}` : "";
    const h = Math.min(segH, totalH - y0);
    const c = document.createElement("canvas");
    c.width = cw * 2 + gap;
    c.height = h + header;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`ORIGINAL${part}`, 6, 18);
    ctx.fillText("TU VERSIÓN (rojo = diferente)", cw + gap + 6, 18);
    ctx.drawImage(a.c, 0, y0, cw, h, 0, header, cw, h);
    ctx.drawImage(b.c, 0, y0, cw, h, cw + gap, header, cw, h);
    ctx.fillStyle = "rgba(255, 0, 0, 0.32)";
    for (let r = Math.floor(y0 / CELL); r < Math.ceil((y0 + h) / CELL); r++) {
      for (let col = 0; col < cols; col++) {
        if (!marked[r * cols + col]) continue;
        const y = r * CELL - y0;
        ctx.fillRect(cw + gap + col * CELL, header + Math.max(0, y), CELL, Math.min(CELL, h - y));
      }
    }
    composites.push(c.toDataURL("image/jpeg", 0.85));
  }
  return { score: matching / (cols * rows), composites };
}
