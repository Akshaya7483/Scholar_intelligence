const qs = (s) => document.querySelector(s)
const on = (el, ev, cb) => el.addEventListener(ev, cb)

const els = {
  token: qs('#token'),
  keywords: qs('#keywords'),
  startKeywords: qs('#startKeywords'),
  statusCard: qs('#statusCard'),
  jobId: qs('#jobId'),
  jobStatus: qs('#jobStatus'),
  progressBar: qs('#progressBar'),
  downloads: qs('#downloads'),
  dlCsv: qs('#dlCsv'),
  dlXlsx: qs('#dlXlsx'),
  dlJson: qs('#dlJson'),
  dlZip: qs('#dlZip'),
  errorMsg: qs('#errorMsg'),
}

let pollTimer = null

function authHeaders() {
  const t = (els.token?.value || '').trim()
  return t ? { 'Authorization': `Bearer ${t}` } : {}
}

function setStatus(job) {
  els.statusCard.classList.remove('hidden')
  els.jobId.textContent = job.id || '-'
  els.jobStatus.textContent = job.status || '-'
  els.progressBar.style.width = `${job.progress || 0}%`
  const done = job.status === 'succeeded'
  els.downloads.classList.toggle('hidden', !done)
  els.errorMsg.classList.toggle('hidden', !(job.status === 'failed'))
  els.errorMsg.textContent = job.message || ''
  if (done) {
    els.dlCsv.href = `/api/scholar/${job.id}/results.csv`
    els.dlXlsx.href = `/api/scholar/${job.id}/results.xlsx`
    els.dlJson.href = `/api/scholar/${job.id}/results.json`
    els.dlZip.href = `/api/scholar/${job.id}/pdfs.zip`
  }
}

function toast(msg) { console.warn(msg); alert(msg) }

async function startFromKeywords() {
  const lines = (els.keywords.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) return toast('Please paste at least one keyword')
  
  const btn = els.startKeywords
  const oldText = btn.textContent
  btn.disabled = true
  btn.textContent = 'Processing...'

  try {
    const r = await fetch('/api/scholar/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ keywords: lines })
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    setStatus({ id: d.jobId, status: 'queued', progress: 0 })
    beginPolling(d.jobId)
  } catch (e) {
    toast('Failed to start: ' + (e.message || e))
  } finally {
    btn.disabled = false
    btn.textContent = oldText
  }
}

function beginPolling(id) {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/scholar/${id}/status`, { headers: { ...authHeaders() } })
      if (!r.ok) return
      const s = await r.json()
      setStatus(s)
      if (s.status === 'succeeded' || s.status === 'failed') {
        clearInterval(pollTimer)
        pollTimer = null
      }
    } catch {}
  }, 2500)
}

async function init() {
  try {
    const r = await fetch('/api/health')
    if (r.ok) {
      const h = await r.json()
      if (!h.hasSerpApiKey) toast('Warning: SERPAPI_KEY missing on backend.')
      if (h.auth) qs('#authRow')?.classList.remove('hidden')
    }
  } catch {}
}

on(els.startKeywords, 'click', startFromKeywords)
init()
