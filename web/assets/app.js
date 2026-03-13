const qs = s => document.querySelector(s)
const on = (el, ev, fn) => el && el.addEventListener(ev, fn)

const els = {
  menuToggle: qs('#menuToggle'),
  sidebar: qs('#sidebar'),
  keywords: qs('#keywords'),
  advAuthor: qs('#advAuthor'),
  advJournal: qs('#advJournal'),
  yearFrom: qs('#yearFrom'),
  yearTo: qs('#yearTo'),
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
  resultsList: qs('#resultsList'),
  searchFilter: qs('#searchFilter'),
  yearFilter: qs('#yearFilter'),
  publisherFilter: qs('#publisherFilter'),
  sortBy: qs('#sortBy'),
  pdfOnly: qs('#pdfOnly'),
  resultsCount: qs('#resultsCount'),
  pagination: qs('#pagination'),
  prevPage: qs('#prevPage'),
  nextPage: qs('#nextPage'),
  pageInfo: qs('#pageInfo')
}

let pollTimer = null
let currentResults = []
let activeJobId = null
let currentPage = 1
const resultsPerPage = 20

function setStatus(s) {
  els.statusCard.classList.remove('hidden')
  els.jobId.textContent = s.id
  els.jobStatus.textContent = s.status
  els.progressBar.style.width = (s.progress || 0) + '%'
  
  if (s.status === 'succeeded') {
    els.downloads.classList.remove('hidden')
    els.dlCsv.href = `/api/scholar/${s.id}/results.csv`
    els.dlXlsx.href = `/api/scholar/${s.id}/results.xlsx`
    els.dlJson.href = `/api/scholar/${s.id}/results.json`
    els.dlZip.href = `/api/scholar/${s.id}/pdfs.zip`
  } else {
    els.downloads.classList.add('hidden')
  }

  if (s.results && s.results.length > 0) {
    updateResults(s.results)
  }
}

function updateResults(results) {
  // Merge results, keeping them unique by link
  const newResults = [...results]
  let added = false
  newResults.forEach(nr => {
    if (!currentResults.find(r => r.link === nr.link)) {
      currentResults.push(nr) // Push to end, we sort later
      added = true
    }
  })
  
  if (added) {
    // Update year filter options
    const years = [...new Set(currentResults.map(r => r.year ? String(r.year).match(/\d{4}/)?.[0] : null).filter(Boolean))].sort((a,b) => b-a)
    const currentYear = els.yearFilter.value
    els.yearFilter.innerHTML = '<option value="">All Years</option>' + 
      years.map(y => `<option value="${y}">${y}</option>`).join('')
    els.yearFilter.value = currentYear

    // Update publisher filter options
    const publishers = [...new Set(currentResults.map(r => r.publisher).filter(Boolean))].sort()
    const currentPub = els.publisherFilter.value
    els.publisherFilter.innerHTML = '<option value="">All Publishers</option>' + 
      publishers.map(p => `<option value="${p}">${p}</option>`).join('')
    els.publisherFilter.value = currentPub

    renderResults()
  }
}

function renderResults() {
  const searchTerm = els.searchFilter.value.toLowerCase()
  const selectedYear = els.yearFilter.value
  const selectedPublisher = els.publisherFilter.value
  const showPdfOnly = els.pdfOnly.checked
  const sortVal = els.sortBy.value

  let filtered = currentResults.filter(r => {
    const matchesSearch = !searchTerm || 
      (r.title && r.title.toLowerCase().includes(searchTerm)) || 
      (r.authors && r.authors.toLowerCase().includes(searchTerm)) ||
      (r.snippet && r.snippet.toLowerCase().includes(searchTerm)) ||
      (r.full_abstract && r.full_abstract.toLowerCase().includes(searchTerm))
    const matchesYear = !selectedYear || (r.year && String(r.year).includes(selectedYear))
    const matchesPublisher = !selectedPublisher || r.publisher === selectedPublisher
    const matchesPdf = !showPdfOnly || r.pdf_url
    return matchesSearch && matchesYear && matchesPublisher && matchesPdf
  })

  // Sorting
  if (sortVal === 'newest') {
    filtered.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0))
  } else if (sortVal === 'oldest') {
    filtered.sort((a, b) => (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999))
  } else if (sortVal === 'cited') {
    filtered.sort((a, b) => (parseInt(b.cited_by) || 0) - (parseInt(a.cited_by) || 0))
  } else if (sortVal === 'pdf') {
    filtered.sort((a, b) => (b.pdf_url ? 1 : 0) - (a.pdf_url ? 1 : 0))
  }
  // If sortVal is 'relevance', we do nothing and keep the original order from the API

  els.resultsCount.textContent = filtered.length

  // Pagination
  const totalPages = Math.ceil(filtered.length / resultsPerPage) || 1
  if (currentPage > totalPages) currentPage = totalPages
  
  const startIdx = (currentPage - 1) * resultsPerPage
  const paginated = filtered.slice(startIdx, startIdx + resultsPerPage)

  if (filtered.length > resultsPerPage) {
    els.pagination.classList.remove('hidden')
    els.pageInfo.textContent = `Page ${currentPage} of ${totalPages}`
    els.prevPage.disabled = currentPage === 1
    els.nextPage.disabled = currentPage === totalPages
  } else {
    els.pagination.classList.add('hidden')
  }

  if (paginated.length === 0) {
    els.resultsList.innerHTML = '<div class="empty-state"><p>No results match your filters.</p></div>'
    return
  }

  els.resultsList.innerHTML = paginated.map(r => `
    <div class="paper-card">
      <div class="paper-header">
        <span class="rank-badge">#${currentResults.indexOf(r) + 1}</span>
        <h3><a href="${r.link}" target="_blank">${r.title || 'Untitled Paper'}</a></h3>
      </div>
      
      <div class="paper-meta">
        <span class="meta-item"><i class="fas fa-user-friends"></i> ${r.authors || 'Unknown Authors'}</span>
        <span class="meta-item"><i class="fas fa-calendar-alt"></i> ${r.year || 'N/A'}</span>
      </div>
      
      <div class="pub-info">
        <i class="fas fa-book-open"></i> ${r.journal || 'Journal/Conference unknown'} 
        ${r.publisher && r.publisher !== r.journal ? `<span class="publisher-label">| <i class="fas fa-building"></i> ${r.publisher}</span>` : ''}
      </div>
      
      <div class="paper-content">
        ${r.full_abstract 
          ? `<div class="full-abstract">
               <div class="abstract-header"><i class="fas fa-align-left"></i> Full Abstract</div>
               <div class="abstract-text">${r.full_abstract}</div>
             </div>` 
          : `<div class="paper-snippet">${r.snippet || ''}</div>`}
      </div>

      <div class="paper-actions">
        <a href="${r.link}" target="_blank" class="action-link"><i class="fas fa-external-link-alt"></i> View Source</a>
        ${r.cited_by ? `<a href="#" class="action-link cite-link"><i class="fas fa-quote-right"></i> Cited by ${r.cited_by}</a>` : ''}
        ${r.versions_total ? `<a href="${r.versions_link || '#'}" target="_blank" class="action-link"><i class="fas fa-layer-group"></i> ${r.versions_total} versions</a>` : ''}
        ${r.pdf_url ? `<a href="${r.pdf_url}" target="_blank" class="pdf-link"><i class="fas fa-file-pdf"></i> PDF</a>` : ''}
      </div>
    </div>
  `).join('')
}

async function startFromKeywords() {
  const lines = (els.keywords.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) return alert('Please paste at least one keyword')
  
  const btn = els.startKeywords
  btn.disabled = true
  btn.textContent = 'Searching...'

  currentResults = []
  currentPage = 1
  els.resultsList.innerHTML = '<div class="empty-state"><p>Searching for papers...</p></div>'
  els.resultsCount.textContent = '0'

  const body = {
    keywords: lines,
    advAuthor: els.advAuthor.value.trim(),
    advJournal: els.advJournal.value.trim(),
    yearFrom: els.yearFrom.value,
    yearTo: els.yearTo.value
  }

  try {
    const r = await fetch('/api/scholar/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    activeJobId = d.jobId
    setStatus({ id: d.jobId, status: 'queued', progress: 0 })
    beginPolling(d.jobId)
  } catch (e) {
    alert('Failed to start: ' + (e.message || e))
    btn.disabled = false
    btn.textContent = 'Start Search'
  }
}

function beginPolling(id) {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/scholar/${id}/status`)
      if (!r.ok) return
      const s = await r.json()
      setStatus(s)
      if (s.status === 'succeeded' || s.status === 'failed') {
        clearInterval(pollTimer)
        pollTimer = null
        els.startKeywords.disabled = false
        els.startKeywords.textContent = 'Start Search'
      }
    } catch {}
  }, 2000)
}

on(els.startKeywords, 'click', startFromKeywords)
on(els.menuToggle, 'click', () => {
  els.sidebar.classList.toggle('active')
})
// Close sidebar when clicking outside on mobile
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 1024 && 
      !els.sidebar.contains(e.target) && 
      !els.menuToggle.contains(e.target) && 
      els.sidebar.classList.contains('active')) {
    els.sidebar.classList.remove('active')
  }
})

on(els.searchFilter, 'input', () => { currentPage = 1; renderResults() })
on(els.yearFilter, 'change', () => { currentPage = 1; renderResults() })
on(els.publisherFilter, 'change', () => { currentPage = 1; renderResults() })
on(els.sortBy, 'change', () => { currentPage = 1; renderResults() })
on(els.pdfOnly, 'change', () => { currentPage = 1; renderResults() })

on(els.prevPage, 'click', () => { if (currentPage > 1) { currentPage--; renderResults(); qs('.results-list').scrollTop = 0 } })
on(els.nextPage, 'click', () => { currentPage++; renderResults(); qs('.results-list').scrollTop = 0 })

async function init() {
  try {
    const r = await fetch('/api/health')
    if (r.ok) {
      const h = await r.json()
      if (!h.hasSerpApiKey) alert('Warning: SERPAPI_KEY missing on backend.')
    }
  } catch {}
}
init()
