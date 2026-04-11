import log from 'electron-log'

log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}'
log.transports.console.level = 'debug'
// electron-log v5 writes synchronously by default (fs.writeFileSync in
// File.js), so shutdown diagnostics are never lost to buffering. Leaving
// writeAsync at its default — no need to override.
log.initialize()

export default log
