import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { sharedTarget } from '../lib/links'

/** The installed app's share target: a YouTube link shared from another app plays here. */
export default function Share() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  useEffect(() => {
    const text = ['url', 'text', 'title'].map((k) => params.get(k) ?? '').join(' ')
    nav(sharedTarget(text), { replace: true })
  }, [params, nav])
  return null
}
