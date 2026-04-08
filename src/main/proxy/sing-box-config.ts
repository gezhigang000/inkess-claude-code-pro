/**
 * Generate sing-box configuration JSON from proxy settings.
 * Supports: direct URL (socks5/http), subscription nodes (ss/vmess/vless/trojan)
 */

import { join } from 'path'

export interface SingBoxOutbound {
  type: string
  tag: string
  server?: string
  server_port?: number
  [key: string]: unknown
}

export interface SingBoxConfig {
  log: { level: string; timestamp: boolean; output?: string }
  dns: {
    servers: { address: string; tag: string; address_resolver?: string; detour?: string; strategy?: string }[]
    rules?: Record<string, unknown>[]
    fakeip?: { enabled: boolean; inet4_range: string; inet6_range: string }
    independent_cache?: boolean
    final?: string
  }
  inbounds: { type: string; tag: string; [key: string]: unknown }[]
  outbounds: SingBoxOutbound[]
  route: { rules: Record<string, unknown>[]; rule_set?: Record<string, unknown>[]; auto_detect_interface: boolean; final: string }
  experimental?: { cache_file?: { enabled: boolean; path?: string; store_fakeip?: boolean } }
}

/**
 * Whitelist: only these domains go through proxy, everything else is direct.
 * Keeps proxy load minimal and domestic traffic fast.
 */
const PROXY_DOMAINS = [
  // Anthropic / Claude
  'anthropic.com', 'claude.ai', 'claudeusercontent.com',
  // OpenAI / ChatGPT
  'openai.com', 'chatgpt.com', 'oaiusercontent.com',
  // Google AI
  'googleapis.com', 'gemini.google.com', 'ai.google.dev', 'deepmind.com',
  // Google
  'google.com', 'google.co.jp', 'gstatic.com', 'googleusercontent.com', 'googlevideo.com',
  // GitHub
  'github.com', 'githubusercontent.com', 'github.io', 'githubassets.com',
  // Dev tools
  'npmjs.org', 'npmjs.com', 'registry.npmjs.org', 'yarnpkg.com',
  'pypi.org', 'pythonhosted.org',
  'crates.io', 'docs.rs',
  'stackoverflow.com', 'stackexchange.com',
  // Privacy / Email
  'proton.me', 'protonmail.com',
  // Cloud
  'amazonaws.com', 'cloudflare.com', 'cloudfront.net',
  // Other commonly blocked
  'wikipedia.org', 'wikimedia.org',
  'twitter.com', 'x.com', 'twimg.com',
  'youtube.com', 'ytimg.com', 'ggpht.com',
  'telegram.org', 't.me',
  'reddit.com', 'redd.it', 'redditstatic.com',
  'medium.com',
  'docker.com', 'docker.io',
  // Connectivity test
  'oxylabs.io',
]

interface ProxyNode {
  name: string
  type: string
  server: string
  port: number
  url: string
  raw: string
  // Protocol-specific fields parsed from subscription
  [key: string]: unknown
}

/**
 * Build a sing-box config for TUN mode.
 *
 * Supports two modes:
 * - Single proxy: proxyUrl only → app → proxy → target
 * - Chain proxy:  proxyUrl + tunnelOutbound → app → tunnel(VPN) → proxy(residential IP) → target
 *
 * tunnelOutbound: pre-parsed sing-box outbound for the VPN tunnel (vless/trojan/ss).
 * When provided, the proxy outbound uses `detour: 'tunnel'` to route through it.
 */
export interface TunConfigOptions {
  proxyUrl: string
  logOutput?: string
  tunnelOutbound?: SingBoxOutbound
  ruleSetDir?: string  // directory containing geosite-cn.srs + geoip-cn.srs
}

export function buildTunConfig(opts: TunConfigOptions): SingBoxConfig {
  const { proxyUrl, logOutput, tunnelOutbound, ruleSetDir } = opts
  const proxyOb = parseProxyUrl(proxyUrl)

  // Build outbounds: proxy (+ optional tunnel detour) + direct
  const outbounds: SingBoxOutbound[] = []
  if (tunnelOutbound) {
    // Chain mode: proxy goes through tunnel
    outbounds.push({ ...proxyOb, tag: 'proxy', detour: 'tunnel' })
    outbounds.push({ ...tunnelOutbound, tag: 'tunnel' })
  } else {
    // Single mode: proxy connects directly
    outbounds.push({ ...proxyOb, tag: 'proxy' })
  }
  outbounds.push({ type: 'direct', tag: 'direct' })

  // CN bypass: geosite-cn/geoip-cn rule sets (pre-bundled .srs files)
  const hasRuleSet = !!ruleSetDir
  const ruleSetDefs = hasRuleSet ? [
    { type: 'local', tag: 'geosite-cn', format: 'binary', path: join(ruleSetDir!, 'geosite-cn.srs') },
    { type: 'local', tag: 'geoip-cn', format: 'binary', path: join(ruleSetDir!, 'geoip-cn.srs') },
  ] : []

  // Chain mode: DNS goes through tunnel (VPN), not proxy (residential SOCKS5 may block DNS targets with code=2)
  // Single mode: DNS goes through proxy as before
  const dnsDetour = tunnelOutbound ? 'tunnel' : 'proxy'

  return {
    log: { level: 'info', timestamp: true, ...(logOutput ? { output: logOutput } : {}) },
    dns: {
      servers: [
        // Remote DNS: DoH — all non-CN domains
        { address: 'https://dns.google/dns-query', tag: 'remote-dns', detour: dnsDetour, address_resolver: 'local-dns', strategy: 'ipv4_only' },
        // Local DNS: CN domains + proxy/tunnel server hostname resolution
        { address: '114.114.114.114', tag: 'local-dns', detour: 'direct', strategy: 'ipv4_only' },
      ],
      rules: [
        // Proxy/tunnel server hostname → local DNS (avoids circular dependency)
        { outbound: 'any', server: 'local-dns' },
        // CN domains → local DNS (real IP for direct outbound)
        ...(hasRuleSet ? [{ rule_set: 'geosite-cn', server: 'local-dns' }] : []),
      ],
      final: 'remote-dns',
      independent_cache: true,
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
      },
    ],
    outbounds,
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_version: 6, action: 'reject' },
        { ip_is_private: true, action: 'route', outbound: 'direct' },
        // CN traffic → direct (domain match + IP match)
        ...(hasRuleSet ? [{ rule_set: ['geosite-cn', 'geoip-cn'], action: 'route', outbound: 'direct' }] : []),
      ],
      ...(ruleSetDefs.length > 0 ? { rule_set: ruleSetDefs } : {}),
      auto_detect_interface: true,
      final: 'proxy',
    },
  }
}

/**
 * Build a sing-box config for local proxy mode (no TUN, no admin needed)
 */
export function buildLocalProxyConfig(proxyUrl: string, localPort = 7891): SingBoxConfig {
  const outbound = parseProxyUrl(proxyUrl)

  return {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [{ address: '8.8.8.8', tag: 'remote-dns' }],
      rules: [],
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: localPort,
      },
    ],
    outbounds: [
      { ...outbound, tag: 'proxy' },
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [],
      auto_detect_interface: true,
      final: 'proxy',
    },
  }
}

export function parseProxyUrl(url: string): SingBoxOutbound {
  url = url.trim()
  const lower = url.toLowerCase()

  if (lower.startsWith('socks5://') || lower.startsWith('socks://')) {
    return parseSocks(url)
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return parseHttp(url)
  }
  if (lower.startsWith('ss://')) {
    return parseShadowsocks(url)
  }
  if (lower.startsWith('vmess://')) {
    return parseVmess(url)
  }
  if (lower.startsWith('vless://')) {
    return parseVless(url)
  }
  if (lower.startsWith('trojan://')) {
    return parseTrojan(url)
  }
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) {
    return parseHysteria2(url)
  }

  // Auto-detect: user:pass@host:port without protocol prefix → treat as HTTP proxy
  if (url.includes('@') && url.includes(':')) {
    return parseHttp('http://' + url)
  }

  // Fallback: treat as socks5
  return { type: 'socks', tag: 'proxy', server: url, server_port: 1080 }
}

function parseSocks(url: string): SingBoxOutbound {
  const u = new URL(url)
  const out: SingBoxOutbound = {
    type: 'socks',
    tag: 'proxy',
    server: u.hostname,
    server_port: Number(u.port) || 1080,
    version: '5',
  }
  if (u.username) out.username = decodeURIComponent(u.username)
  if (u.password) out.password = decodeURIComponent(u.password)
  return out
}

function parseHttp(url: string): SingBoxOutbound {
  const u = new URL(url)
  const out: SingBoxOutbound = {
    type: 'http',
    tag: 'proxy',
    server: u.hostname,
    server_port: Number(u.port) || (u.protocol === 'https:' ? 443 : 8080),
  }
  if (u.username) out.username = decodeURIComponent(u.username)
  if (u.password) out.password = decodeURIComponent(u.password)
  if (u.protocol === 'https:') out.tls = { enabled: true }
  return out
}

function parseShadowsocks(url: string): SingBoxOutbound {
  // ss://base64(method:password)@server:port#name
  const hashIdx = url.indexOf('#')
  const body = url.slice(5, hashIdx > 0 ? hashIdx : undefined)

  let method = 'aes-128-gcm', password = '', server = '', port = 0

  if (body.includes('@')) {
    const [encoded, rest] = body.split('@')
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
      const colonIdx = decoded.indexOf(':')
      method = decoded.slice(0, colonIdx)
      password = decoded.slice(colonIdx + 1)
    } catch {
      // Try as plain text
      const colonIdx = encoded.indexOf(':')
      if (colonIdx > 0) {
        method = encoded.slice(0, colonIdx)
        password = encoded.slice(colonIdx + 1)
      }
    }
    if (rest) {
      const [s, p] = rest.split(':')
      server = s; port = Number(p)
    }
  } else {
    try {
      const decoded = Buffer.from(body, 'base64').toString('utf-8')
      const atIdx = decoded.lastIndexOf('@')
      if (atIdx > 0) {
        const userInfo = decoded.slice(0, atIdx)
        const colonIdx = userInfo.indexOf(':')
        method = userInfo.slice(0, colonIdx)
        password = userInfo.slice(colonIdx + 1)
        const [s, p] = decoded.slice(atIdx + 1).split(':')
        server = s; port = Number(p)
      }
    } catch { /* ignore */ }
  }

  return {
    type: 'shadowsocks',
    tag: 'proxy',
    server,
    server_port: port,
    method,
    password,
  }
}

function parseVmess(url: string): SingBoxOutbound {
  try {
    const json = JSON.parse(Buffer.from(url.slice(8), 'base64').toString('utf-8'))
    const out: SingBoxOutbound = {
      type: 'vmess',
      tag: 'proxy',
      server: json.add || json.server || '',
      server_port: Number(json.port) || 443,
      uuid: json.id || '',
      alter_id: Number(json.aid) || 0,
      security: json.scy || 'auto',
    }
    // TLS
    if (json.tls === 'tls') {
      out.tls = { enabled: true, server_name: json.sni || json.host || json.add }
    }
    // Transport
    if (json.net === 'ws') {
      out.transport = { type: 'ws', path: json.path || '/', headers: json.host ? { Host: json.host } : undefined }
    } else if (json.net === 'grpc') {
      out.transport = { type: 'grpc', service_name: json.path || '' }
    }
    return out
  } catch {
    return { type: 'vmess', tag: 'proxy', server: '', server_port: 443, uuid: '' }
  }
}

function parseVless(url: string): SingBoxOutbound {
  try {
    const u = new URL(url)
    const out: SingBoxOutbound = {
      type: 'vless',
      tag: 'proxy',
      server: u.hostname,
      server_port: Number(u.port) || 443,
      uuid: u.username || '',
    }
    const params = u.searchParams
    // TLS
    const security = params.get('security') || ''
    if (security === 'tls' || security === 'reality') {
      const fp = params.get('fp') || ''
      out.tls = {
        enabled: true,
        server_name: params.get('sni') || u.hostname,
        ...(security === 'reality' ? {
          reality: {
            enabled: true,
            public_key: params.get('pbk') || '',
            short_id: params.get('sid') || '',
          }
        } : {}),
        ...(fp ? { utls: { enabled: true, fingerprint: fp } } : {}),
      }
    }
    // Transport
    const type = params.get('type') || 'tcp'
    if (type === 'ws') {
      out.transport = { type: 'ws', path: params.get('path') || '/' }
    } else if (type === 'grpc') {
      out.transport = { type: 'grpc', service_name: params.get('serviceName') || '' }
    }
    // Flow (XTLS)
    const flow = params.get('flow')
    if (flow) out.flow = flow
    return out
  } catch {
    return { type: 'vless', tag: 'proxy', server: '', server_port: 443, uuid: '' }
  }
}

function parseHysteria2(url: string): SingBoxOutbound {
  try {
    const u = new URL(url.replace(/^hy2:\/\//, 'hysteria2://'))
    const params = u.searchParams
    const out: SingBoxOutbound = {
      type: 'hysteria2',
      tag: 'proxy',
      server: u.hostname,
      server_port: Number(u.port) || 443,
      password: decodeURIComponent(u.username) || '',
      tls: {
        enabled: true,
        server_name: params.get('sni') || u.hostname,
        insecure: params.get('insecure') === '1',
      },
    }
    const obfs = params.get('obfs')
    if (obfs) {
      out.obfs = {
        type: obfs,
        password: params.get('obfs-password') || '',
      }
    }
    return out
  } catch {
    return { type: 'hysteria2', tag: 'proxy', server: '', server_port: 443, password: '' }
  }
}

function parseTrojan(url: string): SingBoxOutbound {
  try {
    const u = new URL(url)
    const out: SingBoxOutbound = {
      type: 'trojan',
      tag: 'proxy',
      server: u.hostname,
      server_port: Number(u.port) || 443,
      password: decodeURIComponent(u.username) || '',
      tls: {
        enabled: true,
        server_name: u.searchParams.get('sni') || u.hostname,
      },
    }
    const type = u.searchParams.get('type') || 'tcp'
    if (type === 'ws') {
      out.transport = { type: 'ws', path: u.searchParams.get('path') || '/' }
    } else if (type === 'grpc') {
      out.transport = { type: 'grpc', service_name: u.searchParams.get('serviceName') || '' }
    }
    return out
  } catch {
    return { type: 'trojan', tag: 'proxy', server: '', server_port: 443, password: '' }
  }
}
