// fisheyeGl — a tiny WebGL fisheye→rectilinear/panorama de-warp renderer.
//
// The recorder stores a per-camera dewarp config ({ enabled, mount, view }); the
// player is the thing that actually un-distorts a fisheye source. This module is
// the GL core: it takes a live <video> element as a texture and, each frame,
// re-projects it through a fragment shader into one of the supported output views.
//
// ── Projection model ────────────────────────────────────────────────────────
// We assume a standard EQUIDISTANT fisheye lens: r = f·θ, i.e. the distance of a
// pixel from the image centre is proportional to the ray's angle θ off the
// optical axis. A pixel at the circle edge is θ = FOV/2 (we fix FOV ≈ 180°). The
// fisheye circle is taken to be inscribed in the shorter image dimension.
//
// Everything happens in "sensor space": a right-handed frame whose +Z is the
// optical axis pointing OUT of the lens toward the scene. `sampleFisheye(dir)`
// maps a scene ray → fisheye texel:
//     θ = acos(dir.z),  φ = atan2(dir.y, dir.x),  r = θ/(FOV/2)
//     uv = 0.5 + r·circleRadius·(cos φ, sin φ)
// θ > FOV/2 falls outside the imaged circle → black.
//
// Each output VIEW builds scene rays differently, then hands them to sampleFisheye:
//   • dewarp   — one virtual pinhole (rectilinear) camera; pan/tilt/zoom PTZ window.
//   • panorama — the fisheye annulus unwrapped: output.x → azimuth φ, output.y →
//                elevation band near the horizon (θ near FOV/2). 360° for ceiling/
//                desk mounts, a 180° half-strip for a wall mount.
//   • quad     — a 2×2 grid of four pinhole views at φ = 45/135/225/315°.
//
// MOUNT changes the fisheye's optical axis, so it changes the sensible default
// look angles: a ceiling lens points at the nadir (scene is an annulus around the
// centre → tilted pinholes + a full ring panorama); a wall lens points straight
// ahead (scene is centred → pinholes look down the axis + a half panorama).

export const FISHEYE_FOV_DEG = 180; // equidistant lens field of view (constant)

const VIEW_CODE = { dewarp: 1, panorama: 2, quad: 3 };
const MOUNT_CODE = { ceiling: 0, wall: 1, desk: 2 };

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2  uCircle;  // fisheye circle radius in texture-uv (x, y)
uniform float uFov;     // fisheye field of view (radians)
uniform int   uView;    // 1 dewarp, 2 panorama, 3 quad
uniform int   uMount;   // 0 ceiling, 1 wall, 2 desk
uniform float uAspect;  // output width / height
uniform float uZoom;    // virtual zoom for the single-dewarp view

const float PI = 3.14159265359;

// Scene ray (sensor space, +Z = optical axis) -> fisheye colour.
vec4 sampleFisheye(vec3 dir) {
  dir = normalize(dir);
  float theta = acos(clamp(dir.z, -1.0, 1.0));
  if (theta > uFov * 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  float phi = atan(dir.y, dir.x);
  float rf = theta / (uFov * 0.5);            // 0..1 across the imaged circle
  vec2 uv = vec2(0.5) + rf * uCircle * vec2(cos(phi), sin(phi));
  return texture2D(uTex, uv);
}

// A rectilinear pinhole ray for output point p (-1..1) looking toward (thetaC,phiC).
vec3 pinholeRay(vec2 p, float thetaC, float phiC, float vfov) {
  float t = tan(vfov * 0.5);
  vec3 c = normalize(vec3(p.x * t, p.y * t, 1.0));
  vec3 fwd = vec3(sin(thetaC) * cos(phiC), sin(thetaC) * sin(phiC), cos(thetaC));
  vec3 upref = abs(fwd.z) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(upref, fwd));
  vec3 up = cross(fwd, right);
  return right * c.x + up * c.y + fwd * c.z;
}

void main() {
  vec4 col;

  if (uView == 2) {
    // ── panorama: unwrap the fisheye annulus ──────────────────────────────
    float phiSpan = (uMount == 1) ? PI : 2.0 * PI;   // wall = 180° half-strip
    float phi = vUV.x * phiSpan - phiSpan * 0.5;
    float band = radians(60.0);
    float thetaTop = uFov * 0.5;                     // horizon = circle edge
    float theta = thetaTop - (1.0 - vUV.y) * band;   // top row -> nearer nadir
    if (uMount == 1) theta = clamp(theta, radians(5.0), uFov * 0.5);
    vec3 dir = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
    col = sampleFisheye(dir);

  } else if (uView == 3) {
    // ── quad: 2x2 grid of pinhole views ───────────────────────────────────
    vec2 cell = floor(vUV * 2.0);
    vec2 q = fract(vUV * 2.0);
    float idx = cell.y * 2.0 + cell.x;
    float phiC = idx * (PI * 0.5) + PI * 0.25;
    float thetaC = (uMount == 1) ? radians(0.0) : radians(50.0);
    vec2 p = (q - 0.5) * 2.0;
    p.x *= uAspect;
    vec3 dir = pinholeRay(p, thetaC, phiC, radians(75.0));
    col = sampleFisheye(dir);

  } else {
    // ── dewarp: a single centred rectilinear virtual-PTZ window ────────────
    vec2 p = (vUV - 0.5) * 2.0;
    p.x *= uAspect;
    float thetaC = (uMount == 1) ? 0.0 : radians(45.0);
    vec3 dir = pinholeRay(p, thetaC, 0.0, radians(100.0) / max(uZoom, 0.001));
    col = sampleFisheye(dir);
  }

  gl_FragColor = col;
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`dewarp shader compile failed: ${log}`);
  }
  return sh;
}

// Create a de-warp renderer bound to a <canvas>. Returns null if WebGL is absent
// (caller falls back to the raw video). The returned object exposes:
//   render(video, { view, mount, zoom })  → draw one de-warped frame
//   resize(w, h)                          → match the canvas backing store
//   dispose()                             → release GL resources
export function createDewarpRenderer(canvas) {
  const gl =
    canvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: false }) ||
    canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true, alpha: false });
  if (!gl) return null;

  let program;
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "link failed");
    }
  } catch (e) {
    return null;
  }

  gl.useProgram(program);

  // Full-screen triangle-pair quad in clip space.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const u = {
    tex: gl.getUniformLocation(program, "uTex"),
    circle: gl.getUniformLocation(program, "uCircle"),
    fov: gl.getUniformLocation(program, "uFov"),
    view: gl.getUniformLocation(program, "uView"),
    mount: gl.getUniformLocation(program, "uMount"),
    aspect: gl.getUniformLocation(program, "uAspect"),
    zoom: gl.getUniformLocation(program, "uZoom"),
  };
  gl.uniform1i(u.tex, 0);
  gl.uniform1f(u.fov, (FISHEYE_FOV_DEG * Math.PI) / 180);

  let disposed = false;

  return {
    gl,

    resize(w, h) {
      if (disposed) return;
      const W = Math.max(1, Math.round(w));
      const H = Math.max(1, Math.round(h));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      gl.viewport(0, 0, W, H);
    },

    // Upload the current video frame and draw the selected view. Returns false if
    // the frame can't be sampled (e.g. a CORS-tainted <video> throws SecurityError)
    // — the caller then falls back to the raw video, honestly.
    render(video, { view, mount, zoom = 1 }) {
      if (disposed) return true;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return true; // not decoded yet — keep waiting, not a failure

      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (e) {
        return false; // tainted / cross-origin — cannot texture this frame
      }

      // The imaged circle is inscribed in the shorter dimension; convert its
      // radius to texture-uv so it stays round on a non-square frame.
      const minDim = Math.min(vw, vh);
      gl.uniform2f(u.circle, (0.5 * minDim) / vw, (0.5 * minDim) / vh);
      gl.uniform1i(u.view, VIEW_CODE[view] || 1);
      gl.uniform1i(u.mount, MOUNT_CODE[mount] ?? 0);
      gl.uniform1f(u.aspect, canvas.width / Math.max(1, canvas.height));
      gl.uniform1f(u.zoom, zoom);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        gl.deleteTexture(tex);
        gl.deleteBuffer(buf);
        gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {}
    },
  };
}
