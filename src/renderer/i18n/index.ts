import { useMemo } from 'react'
import { useSettingsStore } from '../stores/settings'
import { en, type TranslationKey } from './en'
import { zh } from './zh'

const dictionaries: Record<string, Record<string, string>> = { en, zh }

/** Platform-aware file manager name */
const FILE_MANAGER = (typeof window !== 'undefined' && (window as any).api?.platform === 'darwin') ? 'Finder' : 'Explorer'

function resolveLanguage(setting: string): string {
  if (setting === 'zh' || setting === 'en') return setting
  // auto: detect from navigator
  const lang = navigator.language || 'en'
  return lang.startsWith('zh') ? 'zh' : 'en'
}

export function useI18n() {
  const language = useSettingsStore((s) => s.language)
  const resolved = resolveLanguage(language)
  const dict = dictionaries[resolved] || en

  const t = useMemo(() => {
    return (key: TranslationKey, params?: Record<string, string>) => {
      let text = dict[key] || en[key] || key
      const allParams = { fileManager: FILE_MANAGER, ...params }
      for (const [k, v] of Object.entries(allParams)) {
        text = text.replace(`{${k}}`, v)
      }
      return text
    }
  }, [dict])

  return { t, language: resolved }
}

/** Non-hook translation for use outside React components */
export function getT() {
  const language = useSettingsStore.getState().language
  const resolved = resolveLanguage(language)
  const dict = dictionaries[resolved] || en
  return (key: TranslationKey, params?: Record<string, string>) => {
    let text = dict[key] || en[key] || key
    const allParams = { fileManager: FILE_MANAGER, ...params }
    for (const [k, v] of Object.entries(allParams)) {
      text = text.replace(`{${k}}`, v)
    }
    return text
  }
}

export type { TranslationKey }
