/**
 * The plate picture for the printer's file list (Metadata/plate_1.png): every
 * model, fins included, drawn from the front-right at 30 degrees, flat-shaded,
 * on a transparent background. Its own little painter's-algorithm renderer on a
 * 2D canvas, so it doesn't depend on the 3D view's state, size or camera.
 *
 * models: [{ tris: [[x,y,z], ...] (3 per triangle), fins: [[x,y,z], ...] }] in plate
 * coordinates (mm, z up, plate centre at the origin).
 */
export async function plateThumbnail(models, size = 512) {
  const yaw = -Math.PI / 4, pitch = Math.PI / 6;     // look from front-right, 30 degrees down
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // world -> view: rotate about z by yaw, then tilt about x by pitch
  const view = ([x, y, z]) => {
    const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
    return [x1, y1 * sp + z * cp, y1 * cp - z * sp];   // screen x, screen y (up), depth (away)
  };
  const light = norm([0.4, -0.6, 0.7]);
  const faces = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of models) {
    for (const [tris, base] of [[m.tris, [0.86, 0.88, 0.92]], [m.fins ?? [], [0.98, 0.72, 0.30]]]) {
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const a = tris[i], b = tris[i + 1], c = tris[i + 2];
        const n = norm(cross(sub(b, a), sub(c, a)));
        if (!n) continue;
        const shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
        const p = [view(a), view(b), view(c)];
        for (const q of p) {
          if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
          if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
        }
        faces.push({ p, depth: (p[0][2] + p[1][2] + p[2][2]) / 3, rgb: base.map((v) => Math.round(255 * v * shade)) });
      }
    }
  }
  if (!faces.length) return null;
  faces.sort((f, g) => g.depth - f.depth);             // far first
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const k = (size * 0.9) / span;
  const ox = size / 2 - ((minX + maxX) / 2) * k, oy = size / 2 + ((minY + maxY) / 2) * k;

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  g.lineJoin = 'round';
  g.lineWidth = 0.6;
  for (const f of faces) {
    const col = `rgb(${f.rgb[0]},${f.rgb[1]},${f.rgb[2]})`;
    g.fillStyle = g.strokeStyle = col;                  // the stroke closes hairline gaps between faces
    g.beginPath();
    g.moveTo(ox + f.p[0][0] * k, oy - f.p[0][1] * k);
    g.lineTo(ox + f.p[1][0] * k, oy - f.p[1][1] * k);
    g.lineTo(ox + f.p[2][0] * k, oy - f.p[2][1] * k);
    g.closePath();
    g.fill();
    g.stroke();
  }
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}
