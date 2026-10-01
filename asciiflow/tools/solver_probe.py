"""Line-for-line port of the browser solver, to watch the density field evolve.

The canvas is irrelevant here: step() only touches the five Float32Array
fields, so the physics can be run headlessly and fast. float32 mirrors
Float32Array closely enough to expose mass-creation or mass-loss bugs.
"""
import numpy as np

CFG = dict(
    pressureIters=14,
    dt=1.0 / 60.0,
)

VIEW = dict(
    emitX=0.50, emitY=0.70, wander=0.13,
    emitRX=0.24, emitRY=0.26,
    lift=0.55, swirl=28.0,
    wobble=0.45, density=0.030,
    viscosity=0.16, densityDissipate=0.996, velocityDissipate=0.999,
    cut=0.004, gamma=0.62, rampSet="letters",
)

RAMPS = {
    "letters": " ACEFGHIJKLMNOPQRSTUVWXYZ",
}


class Fluid:
    def __init__(self, W, H, view=None):
        self.W, self.H = W, H
        self.view = dict(VIEW) if view is None else dict(view)
        n = W * H
        self.u = np.zeros(n, np.float32)
        self.v = np.zeros(n, np.float32)
        self.u0 = np.zeros(n, np.float32)
        self.v0 = np.zeros(n, np.float32)
        self.dens = np.zeros(n, np.float32)
        self.dens0 = np.zeros(n, np.float32)
        self.press = np.zeros(n, np.float32)
        self.div = np.zeros(n, np.float32)
        self.injected = 0.0
        self.src_cells = 0
        self.steps = 0

    def sample(self, field, x, y):
        W, H = self.W, self.H
        x = 0.0 if x < 0 else (W - 1.001 if x > W - 1.001 else x)
        y = 0.0 if y < 0 else (H - 1.001 if y > H - 1.001 else y)
        i0, j0 = int(x), int(y)
        i1 = i0 + 1 if i0 + 1 < W else i0
        j1 = j0 + 1 if j0 + 1 < H else j0
        fx, fy = x - i0, y - j0
        a = field[j0 * W + i0]
        b = field[j0 * W + i1]
        c = field[j1 * W + i0]
        d = field[j1 * W + i1]
        return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy

    def diffuse(self, field, tmp, rate):
        if rate <= 0:
            return
        W, H = self.W, self.H
        k = rate * 0.0006
        inv = 1.0 / (1.0 + 4.0 * k)
        f = field.reshape(H, W)
        t = tmp.reshape(H, W)
        l = np.empty_like(f)
        l[:, 0] = f[:, 0]
        l[:, 1:] = f[:, :-1]
        r = np.empty_like(f)
        r[:, -1] = f[:, -1]
        r[:, :-1] = f[:, 1:]
        up = np.empty_like(f)
        up[0, :] = f[0, :]
        up[1:, :] = f[:-1, :]
        dn = np.empty_like(f)
        dn[-1, :] = f[-1, :]
        dn[:-1, :] = f[1:, :]
        t[...] = (f + k * (l + r + up + dn)) * inv
        field[:] = t.reshape(-1)

    def project(self):
        W, H = self.W, self.H
        u = self.u.reshape(H, W)
        v = self.v.reshape(H, W)
        l = np.empty_like(u)
        l[:, 0] = u[:, 0]
        l[:, 1:] = u[:, :-1]
        r = np.empty_like(u)
        r[:, -1] = u[:, -1]
        r[:, :-1] = u[:, 1:]
        t = np.empty_like(v)
        t[0, :] = v[0, :]
        t[1:, :] = v[:-1, :]
        b = np.empty_like(v)
        b[-1, :] = v[-1, :]
        b[:-1, :] = v[1:, :]
        self.div[:] = (-0.5 * (r - l + b - t)).reshape(-1)
        press = np.zeros_like(self.div)
        p = press.reshape(H, W)
        d = self.div.reshape(H, W)
        for _ in range(CFG["pressureIters"]):
            pl = np.empty_like(p)
            pl[:, 0] = p[:, 0]
            pl[:, 1:] = p[:, :-1]
            pr = np.empty_like(p)
            pr[:, -1] = p[:, -1]
            pr[:, :-1] = p[:, 1:]
            pt = np.empty_like(p)
            pt[0, :] = p[0, :]
            pt[1:, :] = p[:-1, :]
            pb = np.empty_like(p)
            pb[-1, :] = p[-1, :]
            pb[:-1, :] = p[1:, :]
            p[...] = (d + pl + pr + pt + pb) * 0.25
        self.press[:] = press
        pl = np.empty_like(p)
        pl[:, 0] = p[:, 0]
        pl[:, 1:] = p[:, :-1]
        pr = np.empty_like(p)
        pr[:, -1] = p[:, -1]
        pr[:, :-1] = p[:, 1:]
        pt = np.empty_like(p)
        pt[0, :] = p[0, :]
        pt[1:, :] = p[:-1, :]
        pb = np.empty_like(p)
        pb[-1, :] = p[-1, :]
        pb[:-1, :] = p[1:, :]
        u[...] -= 0.5 * (pr - pl)
        v[...] -= 0.5 * (pb - pt)

    def advect(self, dst, src, velX, velY, dt):
        W, H = self.W, self.H
        xs, ys = np.meshgrid(np.arange(W, dtype=np.float32),
                             np.arange(H, dtype=np.float32))
        sx = xs - velX.reshape(H, W) * dt
        sy = ys - velY.reshape(H, W) * dt
        np.clip(sx, 0, W - 1.001, out=sx)
        np.clip(sy, 0, H - 1.001, out=sy)
        s = src.reshape(H, W)
        i0 = sx.astype(np.int32)
        j0 = sy.astype(np.int32)
        i1 = np.minimum(i0 + 1, W - 1)
        j1 = np.minimum(j0 + 1, H - 1)
        fx = (sx - i0)[..., None]
        fy = (sy - j0)[..., None]
        a = s[j0, i0][..., None]
        b = s[j0, i1][..., None]
        c = s[j1, i0][..., None]
        d = s[j1, i1][..., None]
        dst[:] = ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy).reshape(-1)

    def ambient_source(self, t, wobble=True):
        W, H = self.W, self.H
        v = self.view
        ex = W * v["emitX"] + np.sin(t * 0.23) * W * v["wander"]
        ey = H * v["emitY"] + np.sin(t * 0.17 + 1.7) * H * 0.04
        rx = max(4.0, W * v["emitRX"])
        ry = max(3.0, H * v["emitRY"])
        x0 = max(0, int(ex - rx * 1.6))
        x1 = min(W - 1, int(ex + rx * 1.6))
        y0 = max(0, int(ey - ry * 1.6))
        y1 = min(H - 1, int(ey + ry * 1.6))
        wb = v["wobble"]
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                dx = (x - ex) / rx
                dy = (y - ey) / ry
                q = 1.0 - dx * dx - dy * dy
                if q <= 0:
                    continue
                q *= q
                if wb:
                    q *= (1.0 - wb) + wb * np.sin(x * 0.83 + t * 1.9) * np.sin(
                        y * 1.27 - t * 1.3 + 0.7)
                if q <= 0:
                    continue
                i = y * W + x

                # Mirrors the shipped emitter term for term. If this drifts
                # from the page, tuning through it tunes the wrong thing.
                lift = 0.8 + 0.35 * np.sin(t * 0.9 + x * 0.4)
                self.v[i] += lift * VIEW["lift"] * CFG["dt"] * q
                self.dens[i] += VIEW["density"] * q
                self.injected += VIEW["density"] * q
                self.src_cells += 1

                ang = np.arctan2(dy, dx)
                sw = VIEW["swirl"]
                self.u[i] += sw * q * np.sin(ang * 2.0 + t * 0.7) * CFG["dt"]
                self.u[i] += sw * 0.7 * q * np.sin(dy * 2.2 + t * 0.5) * CFG["dt"]
                self.v[i] += sw * 0.5 * q * np.cos(ang * 2.0 - t * 0.9) * CFG["dt"]

    def step(self, t, wobble=True):
        dt = CFG["dt"]
        vv = self.view
        self.ambient_source(t, wobble)

        self.diffuse(self.u, self.u0, vv["viscosity"])
        self.diffuse(self.v, self.v0, vv["viscosity"])
        self.project()

        self.advect(self.u0, self.u, self.u, self.v, dt)
        self.u[:] = self.u0
        self.advect(self.v0, self.v, self.u, self.v, dt)
        self.v[:] = self.v0
        self.project()

        self.dens0[:] = self.dens
        self.advect(self.dens0, self.dens, self.u, self.v, dt)
        self.dens[:] = self.dens0

        self.u *= vv["velocityDissipate"]
        self.v *= vv["velocityDissipate"]
        self.dens *= vv["densityDissipate"]
        self.dens[self.dens < 0.0004] = 0
        self.steps += 1


def report(f, label):
    vel = float(np.abs(f.u).max() + np.abs(f.v).max())
    mx = float(f.dens.max())
    sm = float(f.dens.sum())
    above = int((f.dens > 0.004).sum())
    kept = (sm / f.injected * 100.0) if f.injected > 0 else 0.0
    print(f"{label:>7}  max={mx:8.4f}  sum={sm:9.2f}  above={above:5d}  "
          f"velMax={vel:8.3f}  injected={f.injected:9.1f}  kept={kept:6.1f}%")


def run(W, H, steps, wobble=True, ambient_density=None):
    if ambient_density is not None:
        CFG["ambientDensity"] = ambient_density
    f = Fluid(W, H)
    for s in range(steps):
        f.step(s * CFG["dt"], wobble)
        if (s + 1) % 100 == 0:
            report(f, str(s + 1))
    return f


def preview(f, ramp_chars=None):
    """Print the field the way render() would, so shape can be judged without
    a browser round trip."""
    if ramp_chars is None:
        ramp_chars = RAMPS.get(f.view.get("rampSet"), " ACEFGHIJKLMNOPQRSTUVWXYZ")
    W, H = f.W, f.H
    n = len(ramp_chars)
    cut = f.view["cut"]
    g = f.view["gamma"]
    out = []
    for y in range(H):
        row = []
        for x in range(W):
            d = float(f.dens[y * W + x])
            if d < cut:
                row.append(" ")
                continue
            t = min(1.0, d) ** g
            row.append(ramp_chars[min(n - 1, int(t * n))])
        out.append("".join(row))
    return out


RAMPS = {
    "letters": " ACEFGHIJKLMNOPQRSTUVWXYZ",
    "blocks": " .:-=+*#%@",
    "dense": "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'",
}


if __name__ == "__main__":
    import sys
    nsteps = int(sys.argv[1]) if len(sys.argv) > 1 else 420
    f = Fluid(96, 41)
    for s in range(nsteps):
        f.step(s * CFG["dt"])
    for line in preview(f):
        print(line)
    above = int((f.dens > f.view["cut"]).sum())
    print(f"max={float(f.dens.max()):.3f} sum={float(f.dens.sum()):.1f} "
          f"above={above} ({above / (96 * 41) * 100:.1f}%) "
          f"kept={float(f.dens.sum()) / f.injected * 100:.1f}%")


