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
  timezone?: string       // e.g. 'America/New_York'
  timezoneOffset?: number // minutes (e.g. 300 for UTC-5, -480 for UTC+8)
  locale?: string         // e.g. 'en-US'
} = {}): string {
  const {
    platform = 'Win32',
    cpuCores = 8,
    deviceMemory = 8,
    screenWidth = 1920,
    screenHeight = 1080,
    colorDepth = 24,
    pixelRatio = 1,
    timezone = 'America/New_York',
    timezoneOffset = 300,
    locale = 'en-US',
  } = options

  return `(function() {
  'use strict';

  // === navigator properties ===
  Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cpuCores} });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory} });

  // navigator.webdriver — hide Electron/automation detection
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

  // navigator.userAgentData — modern UA Client Hints API (Chromium 90+)
  // Returns platform/arch/model consistent with our spoofed environment
  if (navigator.userAgentData || 'userAgentData' in navigator) {
    var __uaBrands = [
      { brand: 'Chromium', version: '136' },
      { brand: 'Google Chrome', version: '136' },
      { brand: 'Not.A/Brand', version: '24' }
    ];
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({
      brands: __uaBrands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: __uaBrands,
          mobile: false,
          platform: 'Windows',
          platformVersion: '15.0.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: '136.0.6778.140',
          fullVersionList: __uaBrands.map(function(b) { return { brand: b.brand, version: b.brand === 'Not.A/Brand' ? '24.0.0.0' : b.version + '.0.6778.140' }; }),
        });
      },
      toJSON: function() { return { brands: __uaBrands, mobile: false, platform: 'Windows' }; }
    }), configurable: true });
  }

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
  // Design goals (prevents Cloudflare JS challenge failure):
  //   1. Same canvas content → same noise output. Repeated calls to
  //      toDataURL/toBlob on the same unchanged canvas return identical
  //      strings/blobs. Cloudflare verifies stability by calling toDataURL
  //      multiple times and comparing hashes.
  //   2. Never mutate the original canvas. Apply noise to an off-screen
  //      copy, leaving the caller's canvas pristine for subsequent reads.
  //   3. Noise is based on canvas pixel content (not a mutating counter),
  //      so different canvases get different noise patterns but the same
  //      canvas always yields the same result.
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  var origCreateElement = Document.prototype.createElement;

  // Stable base seed derived once per page from location.href — used as
  // entropy mixed into content-based hashes, never mutated.
  var baseSeed = 0;
  for (var _i = 0; _i < location.href.length; _i++) {
    baseSeed = ((baseSeed << 5) - baseSeed + location.href.charCodeAt(_i)) | 0;
  }

  // Compute a deterministic 32-bit hash from a sample of the image data.
  // Sampling (not every pixel) keeps this fast for large canvases while
  // still producing a distinct hash per visual content.
  function hashImageData(d, w, h) {
    var hash = baseSeed ^ ((w * 73856093) ^ (h * 19349663));
    var step = Math.max(1, Math.floor(d.length / 512));
    for (var i = 0; i < d.length; i += step) {
      hash = ((hash << 5) - hash + d[i]) | 0;
    }
    return hash;
  }

  // Apply deterministic noise to a copy of the pixel buffer. Seed is
  // derived from the buffer content so repeated calls with the same
  // input produce byte-identical output.
  function applyStableNoise(d, w, h) {
    var seed = hashImageData(d, w, h);
    for (var j = 0; j < d.length; j += 40) {
      seed = ((seed * 16807) | 0) & 0x7fffffff;
      d[j] = Math.max(0, Math.min(255, d[j] + ((seed & 0xf) - 8)));
    }
  }

  // Render the source canvas into a fresh off-screen canvas with noise
  // applied to the copy. The original canvas is never modified.
  function snapshotWithNoise(src) {
    var w = src.width, h = src.height;
    if (w === 0 || h === 0) return null;
    if (w > 2048 || h > 2048) return null; // too large, skip noise
    var temp = origCreateElement.call(document, 'canvas');
    temp.width = w;
    temp.height = h;
    var tctx = temp.getContext('2d');
    if (!tctx) return null;
    tctx.drawImage(src, 0, 0);
    var imgData = origGetImageData.call(tctx, 0, 0, w, h);
    applyStableNoise(imgData.data, w, h);
    tctx.putImageData(imgData, 0, 0);
    return temp;
  }

  HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
    try {
      var snap = snapshotWithNoise(this);
      if (snap) return origToBlob.call(snap, cb, type, quality);
    } catch(e) { /* fall through */ }
    return origToBlob.call(this, cb, type, quality);
  };
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    try {
      var snap = snapshotWithNoise(this);
      if (snap) return origToDataURL.call(snap, type, quality);
    } catch(e) { /* fall through */ }
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

    // Per-session stable offset: derived from baseSeed, constant for the
    // entire page session. Audio fingerprinters compare waveform samples,
    // so a fixed micro-offset shifts the fingerprint without making it
    // unstable across calls.
    var audioOffset = 1 + (((baseSeed & 0xff) / 2550000) - 0.00005);
    AC.prototype.createOscillator = function() {
      var osc = origCreateOscillator.call(this);
      var origConnect = osc.connect.bind(osc);
      osc.connect = function(dest) {
        try {
          var gain = osc.context.createGain();
          gain.gain.value = audioOffset;
          origConnect(gain);
          gain.connect(dest);
          return dest;
        } catch(e) { return origConnect(dest); }
      };
      return osc;
    };
  }

  // === Font enumeration protection ===
  // Override measureText to return a stable-per-input offset. Same text +
  // same font must always return the same width, or Cloudflare's repeated
  // probes detect inconsistency.
  var origMeasureText = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function(text) {
    var metrics = origMeasureText.call(this, text);
    if (text.length <= 3) {
      var w = metrics.width;
      // Hash text + font → deterministic sub-pixel offset
      var key = text + '|' + (this.font || '');
      var h = baseSeed;
      for (var i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
      var offset = (((h & 0xff) / 255) - 0.5) * 0.1; // -0.05 .. +0.05
      Object.defineProperty(metrics, 'width', { get: () => w + offset });
    }
    return metrics;
  };

  // === mediaDevices enumeration ===
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices = function() {
      return Promise.resolve([]);
    };
  }

  // === Timezone masking (Critical: getTimezoneOffset + Date getters + Date.toString) ===
  var __targetOffset = ${timezoneOffset};
  var __targetTz = ${JSON.stringify(timezone)};
  var __targetLocale = ${JSON.stringify(locale)};

  // Save original Intl.DateTimeFormat early — used by timezone getters below
  var __origDTF = Intl.DateTimeFormat;

  // Override getTimezoneOffset — most common timezone detection method
  // Must handle DST: compute correct offset for each date instance (not a fixed value)
  var __origGetTZO = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    try {
      var fmt = new __origDTF('en-US', { timeZone: __targetTz, timeZoneName: 'longOffset' });
      var parts = fmt.formatToParts(this);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') {
          // Parse "GMT-05:00" or "GMT+08:00" → offset in minutes
          var m = parts[i].value.match(/GMT([+-])(\\d{2}):(\\d{2})/);
          if (m) return (m[1] === '+' ? -1 : 1) * (parseInt(m[2]) * 60 + parseInt(m[3]));
        }
      }
    } catch(e) {}
    return __targetOffset; // fallback
  };

  // Override Date local getters (getHours, getMinutes, etc.) — most chat apps
  // use these directly to build timestamp strings, bypassing toString/Intl.
  // We use Intl.DateTimeFormat with __targetTz to compute correct local values.
  var __weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function __tzParts(d) {
    var fmt = new __origDTF('en-US', {
      timeZone: __targetTz, year: 'numeric', month: 'numeric', day: 'numeric',
      weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
    });
    var p = fmt.formatToParts(d), r = {};
    for (var i = 0; i < p.length; i++) r[p[i].type] = p[i].value;
    return r;
  }
  var __origGetFullYear = Date.prototype.getFullYear;
  Date.prototype.getFullYear = function() { try { return parseInt(__tzParts(this).year); } catch(e) { return __origGetFullYear.call(this); } };
  var __origGetMonth = Date.prototype.getMonth;
  Date.prototype.getMonth = function() { try { return parseInt(__tzParts(this).month) - 1; } catch(e) { return __origGetMonth.call(this); } };
  var __origGetDate = Date.prototype.getDate;
  Date.prototype.getDate = function() { try { return parseInt(__tzParts(this).day); } catch(e) { return __origGetDate.call(this); } };
  var __origGetDay = Date.prototype.getDay;
  Date.prototype.getDay = function() { try { return __weekdayMap[__tzParts(this).weekday] || 0; } catch(e) { return __origGetDay.call(this); } };
  var __origGetHours = Date.prototype.getHours;
  Date.prototype.getHours = function() { try { var h = parseInt(__tzParts(this).hour); return h === 24 ? 0 : h; } catch(e) { return __origGetHours.call(this); } };
  var __origGetMinutes = Date.prototype.getMinutes;
  Date.prototype.getMinutes = function() { try { return parseInt(__tzParts(this).minute); } catch(e) { return __origGetMinutes.call(this); } };
  var __origGetSeconds = Date.prototype.getSeconds;
  Date.prototype.getSeconds = function() { try { return parseInt(__tzParts(this).second); } catch(e) { return __origGetSeconds.call(this); } };

  // Override Date setters — must interpret arguments in target timezone, not system timezone.
  // Strategy: shift internal UTC time so system-local aligns with target-local, call native
  // setter, then shift back. Handles DST transitions correctly because native setter resolves
  // ambiguous/invalid local times the same way the target timezone would.
  function __shiftToTarget(d) {
    var sysOff = __origGetTZO.call(d);
    var tgtOff = d.getTimezoneOffset(); // already overridden → target TZ offset
    return (sysOff - tgtOff) * 60000;
  }
  var __origSetTime = Date.prototype.setTime;
  function __wrapSetter(name) {
    var orig = Date.prototype[name];
    Date.prototype[name] = function() {
      var shift = __shiftToTarget(this);
      __origSetTime.call(this, this.getTime() + shift);
      orig.apply(this, arguments);
      // Recompute shift after mutation (DST may have changed)
      var sysOff = __origGetTZO.call(this);
      var tgtOff = this.getTimezoneOffset();
      __origSetTime.call(this, this.getTime() - (sysOff - tgtOff) * 60000);
      return this.getTime();
    };
  }
  __wrapSetter('setFullYear'); __wrapSetter('setMonth'); __wrapSetter('setDate');
  __wrapSetter('setHours'); __wrapSetter('setMinutes'); __wrapSetter('setSeconds');

  // Override Date.toString/toTimeString/toDateString — leaks "China Standard Time" / local date
  var __origToString = Date.prototype.toString;
  var __origToTimeString = Date.prototype.toTimeString;
  var __origToDateString = Date.prototype.toDateString;
  function __fakeDateStr(d) {
    try {
      var fmt = new __origDTF('en-US', {
        timeZone: __targetTz, weekday: 'short', year: 'numeric', month: 'short',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZoneName: 'long'
      });
      var parts = fmt.formatToParts(d);
      var get = function(t) { for (var i=0;i<parts.length;i++) if(parts[i].type===t) return parts[i].value; return ''; };
      var sign = __targetOffset <= 0 ? '+' : '-';
      var absOff = Math.abs(__targetOffset);
      var offStr = 'GMT' + sign + String(Math.floor(absOff/60)).padStart(2,'0') + String(absOff%60).padStart(2,'0');
      return get('weekday') + ' ' + get('month') + ' ' + get('day') + ' ' + get('year') + ' ' +
             get('hour') + ':' + get('minute') + ':' + get('second') + ' ' + offStr + ' (' + get('timeZoneName') + ')';
    } catch(e) { return __origToString.call(d); }
  }
  Date.prototype.toString = function() { return __fakeDateStr(this); };
  Date.prototype.toTimeString = function() {
    var s = __fakeDateStr(this);
    var idx = s.indexOf(' ', s.indexOf(' ', s.indexOf(' ', s.indexOf(' ') + 1) + 1) + 1);
    return idx > 0 ? s.slice(idx + 1) : __origToTimeString.call(this);
  };
  Date.prototype.toDateString = function() {
    try {
      var p = __tzParts(this);
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return p.weekday + ' ' + months[parseInt(p.month) - 1] + ' ' + String(p.day).padStart(2, '0') + ' ' + p.year;
    } catch(e) { return __origToDateString.call(this); }
  };

  // Override toLocaleString family — V8 uses internal C++ path that bypasses JS-level
  // Intl.DateTimeFormat override, so we must explicitly force target timezone here.
  var __origToLocaleString = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function(locales, opts) {
    return __origToLocaleString.call(this, locales || __targetLocale,
      Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __targetTz }));
  };
  var __origToLocaleDateString = Date.prototype.toLocaleDateString;
  Date.prototype.toLocaleDateString = function(locales, opts) {
    return __origToLocaleDateString.call(this, locales || __targetLocale,
      Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __targetTz }));
  };
  var __origToLocaleTimeString = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleTimeString = function(locales, opts) {
    return __origToLocaleTimeString.call(this, locales || __targetLocale,
      Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __targetTz }));
  };

  // === Intl locale masking ===
  // Intl.NumberFormat — prevents locale leak via number formatting
  var __origNF = Intl.NumberFormat;
  Intl.NumberFormat = function(locales, opts) {
    return new __origNF(locales || __targetLocale, opts);
  };
  Intl.NumberFormat.prototype = __origNF.prototype;
  Intl.NumberFormat.supportedLocalesOf = __origNF.supportedLocalesOf.bind(__origNF);

  // Intl.Collator — prevents locale leak via string sorting
  var __origCollator = Intl.Collator;
  Intl.Collator = function(locales, opts) {
    return new __origCollator(locales || __targetLocale, opts);
  };
  Intl.Collator.prototype = __origCollator.prototype;
  Intl.Collator.supportedLocalesOf = __origCollator.supportedLocalesOf.bind(__origCollator);

  // Intl.DateTimeFormat — force locale + timezone (enhances existing injectRegionMasking)
  Intl.DateTimeFormat = function(locales, opts) {
    return new __origDTF(locales || __targetLocale, Object.assign({}, opts, { timeZone: (opts && opts.timeZone) || __targetTz }));
  };
  Intl.DateTimeFormat.prototype = __origDTF.prototype;
  Intl.DateTimeFormat.supportedLocalesOf = __origDTF.supportedLocalesOf.bind(__origDTF);
  Object.defineProperty(Intl.DateTimeFormat, Symbol.hasInstance, { value: function(i) { return i instanceof __origDTF; } });

  // Intl.RelativeTimeFormat — "2 hours ago" format leaks locale
  if (typeof Intl.RelativeTimeFormat !== 'undefined') {
    var __origRTF = Intl.RelativeTimeFormat;
    Intl.RelativeTimeFormat = function(locales, opts) { return new __origRTF(locales || __targetLocale, opts); };
    Intl.RelativeTimeFormat.prototype = __origRTF.prototype;
    Intl.RelativeTimeFormat.supportedLocalesOf = __origRTF.supportedLocalesOf.bind(__origRTF);
  }

  // Intl.ListFormat — "a, b, and c" vs "a、b和c" leaks locale
  if (typeof Intl.ListFormat !== 'undefined') {
    var __origLF = Intl.ListFormat;
    Intl.ListFormat = function(locales, opts) { return new __origLF(locales || __targetLocale, opts); };
    Intl.ListFormat.prototype = __origLF.prototype;
    Intl.ListFormat.supportedLocalesOf = __origLF.supportedLocalesOf.bind(__origLF);
  }

  // Intl.PluralRules — plural category rules differ by language
  if (typeof Intl.PluralRules !== 'undefined') {
    var __origPR = Intl.PluralRules;
    Intl.PluralRules = function(locales, opts) { return new __origPR(locales || __targetLocale, opts); };
    Intl.PluralRules.prototype = __origPR.prototype;
    Intl.PluralRules.supportedLocalesOf = __origPR.supportedLocalesOf.bind(__origPR);
  }

  // Intl.Segmenter — text segmentation (Chinese word-break vs English space-split)
  if (typeof Intl.Segmenter !== 'undefined') {
    var __origSeg = Intl.Segmenter;
    Intl.Segmenter = function(locales, opts) { return new __origSeg(locales || __targetLocale, opts); };
    Intl.Segmenter.prototype = __origSeg.prototype;
    Intl.Segmenter.supportedLocalesOf = __origSeg.supportedLocalesOf.bind(__origSeg);
  }

  // Intl.DisplayNames — region/language display names ("中国" vs "China")
  if (typeof Intl.DisplayNames !== 'undefined') {
    var __origDN = Intl.DisplayNames;
    Intl.DisplayNames = function(locales, opts) { return new __origDN(locales || __targetLocale, opts); };
    Intl.DisplayNames.prototype = __origDN.prototype;
    Intl.DisplayNames.supportedLocalesOf = __origDN.supportedLocalesOf.bind(__origDN);
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
  timezone: string
  timezoneOffset: number  // minutes: positive = west of UTC (US), negative = east (Asia)
  locale: string
}> = {
  // Default: generic US Windows profile
  default: { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'America/New_York', timezoneOffset: 300, locale: 'en-US' },
  us:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'America/New_York', timezoneOffset: 300, locale: 'en-US' },
  usw: { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'America/Los_Angeles', timezoneOffset: 480, locale: 'en-US' },
  gb:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Europe/London', timezoneOffset: 0, locale: 'en-GB' },
  de:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Europe/Berlin', timezoneOffset: -60, locale: 'de-DE' },
  jp:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Asia/Tokyo', timezoneOffset: -540, locale: 'ja-JP' },
  kr:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Asia/Seoul', timezoneOffset: -540, locale: 'ko-KR' },
  sg:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Asia/Singapore', timezoneOffset: -480, locale: 'en-SG' },
  hk:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Asia/Hong_Kong', timezoneOffset: -480, locale: 'en-HK' },
  tw:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Asia/Taipei', timezoneOffset: -480, locale: 'zh-TW' },
  au:  { platform: 'Win32', cpuCores: 8, deviceMemory: 8, screenWidth: 1920, screenHeight: 1080, timezone: 'Australia/Sydney', timezoneOffset: -600, locale: 'en-AU' },
}
