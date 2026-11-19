"""Convert the Onshape field STL into assets/field.bin for the browser sim.

Usage: python3 tools/stl_to_field.py "Field - Part Studio 1 - Main.stl" assets/field.bin

The STL is meters, Z-up. Sim/Three.js is Y-up with the long axis on x, so
sim (x, y, z) = (stl y, stl z, stl x). Staging tubes and the carpet are dropped
(the sim draws its own live tubes and a carpet with zone tape). Every remaining
triangle is tagged with a part group so the renderer can color it.

field.bin layout (little endian):
  uint32 magic 'TTF1', uint32 headerBytes, header JSON (utf-8, padded to 4)
  int16 positions [nVerts*3] in units of header.scale meters
  uint32 indices  [nTris*3], sorted by group; header.groups gives [name, start, count]
"""
import json, struct, sys
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read()
n = int.from_bytes(raw[80:84], 'little')
dt = np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')])
T = np.frombuffer(raw, dtype=dt, count=n, offset=84)['v'].astype(np.float64)[:, :, [1, 2, 0]]

lo, hi = T.min(1), T.max(1)
inside = lambda x0, x1, y0, y1, z0, z1: (lo[:, 0] >= x0) & (hi[:, 0] <= x1) & (lo[:, 1] >= y0) & (hi[:, 1] <= y1) & (lo[:, 2] >= z0) & (hi[:, 2] <= z1)
ax = np.abs(T[:, :, 0]).max(1); az = np.abs(T[:, :, 2]).max(1)
cx, cy, cz = T[:, :, 0].mean(1), T[:, :, 1].mean(1), T[:, :, 2].mean(1)

drop = inside(-0.62, 0.62, -0.01, 0.14, -2.45, 2.45) | (hi[:, 1] <= 0.0065)   # staging tubes, carpet + floor decals
group = np.full(len(T), 'structure', dtype=object)
plat = (ax <= 1.835) & (az >= 2.585) & (az <= 3.815) & (hi[:, 1] <= 0.82)
lvl = np.where(np.abs(cx) <= 0.61, 3, np.where(cx * np.sign(cz) < 0, 4, 2))   # blue L2 at -x, red mirrored
for L in (2, 3, 4):
    group[plat & (cz < 0) & (lvl == L)] = f'platform-blue-{L}'
    group[plat & (cz > 0) & (lvl == L)] = f'platform-red-{L}'
short = (ax >= 5.78) & (ax <= 8.15) & (az >= 1.67) & (az <= 1.80)
group[short & (cx < 0)] = 'wall-red'          # -x short wall borders RED's scoring zone
group[short & (cx > 0)] = 'wall-blue'
post = (np.abs(cx) >= 7.6) & (np.abs(cx) <= 8.26) & ((np.abs(cy - 0.6096) < 0.07) | (np.abs(cy - 2.54) < 0.07)) & (hi[:, 1] - lo[:, 1] < 0.14)
group[post] = 'post'
station = np.abs(cx) > 8.29
group[station & (cx < 0)] = 'station-blue'
group[station & (cx > 0)] = 'station-red'
panel = (np.abs(cx) >= 8.12) & (np.abs(cx) <= 8.29) & ~post
group[panel] = 'endwall'
side = (np.abs(cz) >= 3.80) & (np.abs(cz) <= 3.96) & (hi[:, 1] > 0.05) & ~plat
group[side] = 'sidewall'
chute = (((np.abs(cz) > 3.81) | (np.abs(cx) > 8.23)) & (np.abs(cx) > 5.0)) & (hi[:, 1] < 1.85) & (group == 'structure')
group[chute] = 'chute'

keep = ~drop
T, group = T[keep], group[keep]
order = np.argsort(group, kind='stable'); T, group = T[order], group[order]

scale = 1 / 3000.0                                  # int16 covers ±10.9 m at 0.33 mm
q = np.round(T.reshape(-1, 3) / scale).astype(np.int32)
uniq, inv = np.unique(q, axis=0, return_inverse=True)
idx = inv.reshape(-1).astype(np.uint32)
groups, start = [], 0
for name in dict.fromkeys(group):
    c = int((group == name).sum()); groups.append([name, start * 3, c * 3]); start += c

header = json.dumps({'scale': scale, 'verts': len(uniq), 'tris': len(T), 'groups': groups,
                     'axes': 'sim(x,y,z)=stl(y,z,x)', 'source': src.split('/')[-1]}).encode()
header += b' ' * (-len(header) % 4)
with open(dst, 'wb') as f:
    f.write(b'TTF1'); f.write(struct.pack('<I', len(header))); f.write(header)
    f.write(uniq.astype('<i2').tobytes()); f.write(idx.astype('<u4').tobytes())
print(f'{n} -> {len(T)} tris, {len(uniq)} verts, groups:', [(g, c // 3) for g, _, c in groups])
