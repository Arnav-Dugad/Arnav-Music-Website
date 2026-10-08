import { useNavigate } from 'react-router-dom'
import { Empty } from '../components/ui'

export default function NotFound() {
  const nav = useNavigate()
  return (
    <div className="page">
      <Empty icon="compass" title="This page skipped a beat" body="The link may be old, or the page moved." action={<button className="btn btn-primary" onClick={() => nav('/')}>Go home</button>} />
    </div>
  )
}
