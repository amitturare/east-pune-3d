// Regular grid of ground elevations (metres above the lowest DEM sample) in
// local coordinates. Shared by the geometry worker and the main thread so
// everything placed on the ground agrees on where the ground is.
export class Heightfield {
  constructor({ nx, nz, minX, minZ, cell, data, water }) {
    Object.assign(this, { nx, nz, minX, minZ, cell, data, water });
  }

  static sampleGrid(grid, nx, nz, fx, fz) {
    const x0 = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));
    const i = z0 * nx + x0;
    const a = grid[i], b = grid[i + 1], c = grid[i + nx], d = grid[i + nx + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  // Ground height at (x, z).
  at(x, z) {
    return Heightfield.sampleGrid(this.data, this.nx, this.nz, (x - this.minX) / this.cell, (z - this.minZ) / this.cell);
  }

  // Water surface level of the river valley at (x, z).
  waterAt(x, z) {
    return Heightfield.sampleGrid(this.water, this.nx, this.nz, (x - this.minX) / this.cell, (z - this.minZ) / this.cell);
  }

  toJSON() {
    const { nx, nz, minX, minZ, cell, data, water } = this;
    return { nx, nz, minX, minZ, cell, data, water };
  }
}
