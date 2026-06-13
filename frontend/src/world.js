/**
 * Virtual-world backdrop: gradient sky dome with a glowing horizon, a neon
 * grid floor fading into fog, a soft spawn pad under the character, and
 * slowly rising data-mote particles. All procedural — no asset files.
 */
import * as THREE from "three";

const SKY_TOP = 0x070710;
const SKY_HORIZON = 0x3a1a5e;   // purple glow band at the horizon
const SKY_BOTTOM = 0x05050a;
const GRID_MAIN = 0x35558a;
const GRID_CENTER = 0x5a7ad0;
const FOG_NEAR = 4;
const FOG_FAR = 13;
const PARTICLES = 220;
const PARTICLE_AREA = 9;        // m, square around the character
const PARTICLE_HEIGHT = 4;      // m, rise then wrap
const PAD_COLOR = 0x66aaff;

const GRID_SIZE = 40;
const GRID_DIV = 80;
const GRID_CELL = GRID_SIZE / GRID_DIV; // 0.5 m

export class VirtualWorld {
  constructor(scene) {
    this._t = 0;
    this._scroll = new THREE.Vector2(0, 0); // accumulated ground scroll (x, z)

    scene.fog = new THREE.Fog(SKY_BOTTOM, FOG_NEAR, FOG_FAR);

    // -- sky dome -------------------------------------------------------------
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(SKY_TOP) },
        horizon: { value: new THREE.Color(SKY_HORIZON) },
        bottom: { value: new THREE.Color(SKY_BOTTOM) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 base = h >= 0.0 ? mix(bottom, top, smoothstep(0.0, 0.6, h)) : bottom;
          float glow = exp(-abs(h) * 5.5);          // horizon band
          vec3 color = base + horizon * glow * 0.85;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this._sky = new THREE.Mesh(new THREE.SphereGeometry(15, 32, 16), skyMat);
    scene.add(this._sky);

    // -- neon grid floor --------------------------------------------------------
    const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIV, GRID_CENTER, GRID_MAIN);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);
    this._grid = grid;

    // -- spawn pad under the character -------------------------------------------
    this._pad = new THREE.Group();
    const ringA = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.6, 48),
      new THREE.MeshBasicMaterial({
        color: PAD_COLOR, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    const ringB = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 0.8, 48),
      new THREE.MeshBasicMaterial({
        color: PAD_COLOR, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    for (const ring of [ringA, ringB]) {
      ring.rotation.x = -Math.PI / 2;
      this._pad.add(ring);
    }
    this._pad.position.y = 0.01;
    scene.add(this._pad);
    this._ringA = ringA;
    this._ringB = ringB;

    // -- rising data motes ---------------------------------------------------------
    const positions = new Float32Array(PARTICLES * 3);
    this._speeds = new Float32Array(PARTICLES);
    for (let i = 0; i < PARTICLES; i++) {
      positions[i * 3] = (Math.random() - 0.5) * PARTICLE_AREA;
      positions[i * 3 + 1] = Math.random() * PARTICLE_HEIGHT;
      positions[i * 3 + 2] = (Math.random() - 0.5) * PARTICLE_AREA;
      this._speeds[i] = 0.08 + Math.random() * 0.22;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this._motes = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0x7ab8ff, size: 0.02, transparent: true, opacity: 0.65,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      }),
    );
    scene.add(this._motes);
  }

  /**
   * Scroll the ground/motes by (dx, dz) — used during the emote so the world
   * slides following the character's footwork. The spawn pad stays under her
   * (it's her pad), only the ground and motes move.
   */
  addScroll(dx, dz) {
    this._scroll.x += dx;
    this._scroll.y += dz;
  }

  update(delta) {
    this._t += delta;
    // motes drift upward and wrap
    const pos = this._motes.geometry.attributes.position;
    for (let i = 0; i < PARTICLES; i++) {
      let y = pos.getY(i) + this._speeds[i] * delta;
      if (y > PARTICLE_HEIGHT) y = 0;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    // spawn pad breathes
    const pulse = 0.5 + 0.5 * Math.sin(this._t * 1.4);
    this._ringA.material.opacity = 0.35 + 0.25 * pulse;
    this._ringB.material.opacity = 0.14 + 0.12 * (1 - pulse);
    this._pad.rotation.y += delta * 0.15;
    // ground scroll — grid wraps within one cell (seamless), motes within their box
    this._grid.position.x = -wrapTo(this._scroll.x, GRID_CELL);
    this._grid.position.z = -wrapTo(this._scroll.y, GRID_CELL);
    this._motes.position.x = -wrapTo(this._scroll.x, PARTICLE_AREA);
    this._motes.position.z = -wrapTo(this._scroll.y, PARTICLE_AREA);
  }
}

/** Wrap v into [-size/2, size/2] so a moving plane reads as infinite. */
function wrapTo(v, size) {
  return v - Math.round(v / size) * size;
}
