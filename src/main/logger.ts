import log from 'electron-log'

log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}'
log.transports.console.level = 'debug'
log.initialize()

export default log
