import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'

// Global error reporting to main process log
window.onerror = (_msg, _src, _line, _col, err) => {
  window.api?.log?.error(err?.message || String(_msg), err?.stack)
}
window.onunhandledrejection = (event) => {
  const reason = event.reason
  window.api?.log?.error(
    reason?.message || String(reason),
    reason?.stack
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
