/**
 * Browser fingerprint masking — JavaScript injection scripts
 *
 * Mitigates browser fingerprinting by overriding APIs that leak hardware/software info.
 * Modeled after fingerprint browsers (Multilogin, AdsPower, GoLogin).
 */

/**
 * Build the fingerprint masking script for injection into browser windows.
 * Must be injected at document start (before page scripts run).
 */
export function buildFingerprintMaskScript(options: {
  platform?: string       // e.g. 'Win32', 'MacIntel', 'Linux x86_64'
  cpuCores?: number       // navigator.hardwareConcurrency
  deviceMemory?: number   // navigator.deviceMemory (GB)
  screenWidth?: number
  screenHeight?: number
  colorDepth?: number
  pixelRatio?: number
} = {}): string {
  const {
    platform = 'Win32',
    cpuCores = 8,
    deviceMemory = 8,
    screenWidth = 1920,
    screenHeight = 1080,
    colorDepth = 24,
    pixelRatio = 1,
  } = options

  return `(function() {
  'use strict';

  // === navigator properties ===
  Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cpuCores} });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory} });

  // navigator.plugins — return empty but typed correctly
  Object.defineProperty(navigator, 'plugins', { get: () => {
    var p = [];
    p.item = function(i) { return p[i] || null; };
    p.namedItem = function() { return null; };
    p.refresh = function() {};
    Object.defineProperty(p, 'length', { get: () => 0 });
    return p;
  }});
  Object.defineProperty(navigator, 'mimeTypes', { get: () => {
    var m = [];
    m.item = function(i) { return m[i] || null; };
    m.namedItem = function() { return null; };
    Object.defineProperty(m, 'length', { get: () => 0 });
    return m;
  }});

  // navigator.connection — return plausible static values
  if (navigator.connection || 'connection' in navigator) {
    var fakeConn = {
      effectiveType: '4g', downlink: 10, rtt: 50, saveData: false,
      type: 'wifi', downlinkMax: Infinity, addEventListener: function() {}, removeEventListener: function() {}
    };
    Object.defineProperty(navigator, 'connection', { get: () => fakeConn, configurable: true });
  }

  // navigator.getBattery — reject or return fake full battery
  if (navigator.getBattery) {
    navigator.getBattery = function() {
      return Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1,
        addEventListener: function() {}, removeEventListener: function() {}
      });
    };
  }

  // === Screen properties ===
  var screenProps = {
    width: ${screenWidth}, height: ${screenHeight},
    availWidth: ${screenWidth}, availHeight: ${screenHeight - 40},
    colorDepth: ${colorDepth}, pixelDepth: ${colorDepth},
  };
  for (var prop in screenProps) {
    Object.defineProperty(screen, prop, { get: (function(v) { return function() { return v; } })(screenProps[prop]) });
  }
  Object.defineProperty(window, 'devicePixelRatio', { get: () => ${pixelRatio} });
  Object.defineProperty(window, 'outerWidth', { get: () => ${screenWidth} });
  Object.defineProperty(window, 'outerHeight', { get: () => ${screenHeight} });

  // === Canvas fingerprint noise ===
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  // Deterministic noise seed from page URL to be consistent within a session
  var _seed = 0;
  for (var i = 0; i < location.href.length; i++) _seed = ((_seed << 5) - _seed + location.href.charCodeAt(i)) | 0;
  function noise() { _seed = (_seed * 16807 + 0) % 2147483647; return (_seed & 0xf) - 8; }

  function addNoise(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0 || w > 1000 || h > 1000) return; // skip large canvases
      var imgData = origGetImageData.call(ctx, 0, 0, w, h);
      var d = imgData.data;
      // Only touch a small portion of pixels to avoid visual artifacts
      for (var j = 0; j < d.length; j += 40) {
        d[j] = Math.max(0, Math.min(255, d[j] + noise()));
      }
      ctx.putImageData(imgData, 0, 0);
    } catch(e) { /* cross-origin or other error */ }
  }

  HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
    addNoise(this);
    return origToBlob.call(this, cb, type, quality);
  };
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    addNoise(this);
    return origToDataURL.call(this, type, quality);
  };

  // === WebGL fingerprint masking ===
  var origGetParameter = WebGLRenderingContext.prototype.getParameter;
  var origGetExtension = WebGLRenderingContext.prototype.getExtension;

  var UNMASKED_VENDOR = 0x9245;
  var UNMASKED_RENDERER = 0x9246;

  function patchGetParameter(orig) {
    return function(pname) {
      if (pname === UNMASKED_VENDOR) return 'Google Inc. (NVIDIA)';
      if (pname === UNMASKED_RENDERER) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return orig.call(this, pname);
    };
  }

  WebGLRenderingContext.prototype.getParameter = patchGetParameter(origGetParameter);
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = patchGetParameter(origGetParameter2);
  }

  // === AudioContext fingerprint noise ===
  if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
    var AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    var origCreateOscillator = AC.prototype.createOscillator;
    var origCreateDynamicsCompressor = AC.prototype.createDynamicsCompressor;

    AC.prototype.createOscillator = function() {
      var osc = origCreateOscillator.call(this);
      var origConnect = osc.connect.bind(osc);
      osc.connect = function(dest) {
        // Insert a gain node with slight offset to add noise
        try {
          var gain = osc.context.createGain();
          gain.gain.value = 1 + (noise() * 0.0001);
          origConnect(gain);
          gain.connect(dest);
          return dest;
        } catch(e) { return origConnect(dest); }
      };
      return osc;
    };
  }

  // === Font enumeration protection ===
  // Override measureText to add slight noise, making font detection unreliable
  var origMeasureText = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function(text) {
    var metrics = origMeasureText.call(this, text);
    // Only add noise when measuring single characters (font probe pattern)
    if (text.length <= 3) {
      var w = metrics.width;
      Object.defineProperty(metrics, 'width', { get: () => w + noise() * 0.1 });
    }
    return metrics;
  };

  // === mediaDevices enumeration ===
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices = function() {
      return Promise.resolve([]);
    };
  }
})();`
}

/** Platform-specific fingerprint profiles keyed by region */
export const FINGERPRINT_PROFILES: Record<string, {
  platform: string
  cpuCores: number
  deviceMemory: number
  screenWidth: number
  screenHeight: number
}> = {
  // Default: generic Windows profile (most common globally)
  default: { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  // macOS regions
  US:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  USW: { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  GB:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  DE:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  JP:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  KR:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  SG:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  HK:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  TW:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
  AU:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080 },
}
