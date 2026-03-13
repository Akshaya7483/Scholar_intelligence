const http = require("http")
const fs = require("fs")
const fsp = require("fs").promises
const path = require("path")
const url = require("url")
const crypto = require("crypto")
try {
  const dotenv = require("dotenv")
  // Check multiple locations for .env
  dotenv.config({ path: path.resolve(__dirname, ".env") }) // Current server/ directory
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") }) // Project root
  dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") }) // Parent directory
} catch {}
const axios = require("axios")
const Archiver = require("archiver")
const XLSX = require("xlsx")
const pLimit = require("p-limit")

const root = path.resolve(__dirname, "..")
const webDir = path.join(root, "web")
const port = process.env.PORT || 3000

const scholarJobs = new Map()
const API_TOKEN = process.env.API_TOKEN || ""
const SERP_KEY = process.env.SERPAPI_KEY || process.env.SERP_API_KEY || ""
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || ""
const TMP_TTL_MS = Number(process.env.TMP_TTL_MS || 1000 * 60 * 60 * 2)
const DEFAULT_MAX_RESULTS = Number(process.env.MAX_RESULTS || 100)
const DEFAULT_RATE_DELAY = Number(process.env.RATE_DELAY_MS || 600)
const CONCURRENCY_LIMIT = Number(process.env.CONCURRENCY_LIMIT || 3)
const MAX_JSON_RESULTS = Number(process.env.MAX_JSON_RESULTS || 20000)
const MAX_HTML_STORAGE_BYTES = Number(process.env.MAX_HTML_STORAGE_BYTES || 20000)

function json(res, code, body) {
  res.statusCode = code
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}
function notFound(res) { res.statusCode = 404; res.end() }
async function serveFile(res, filePath) {
  try {
    const stat = await fsp.stat(filePath)
    if (stat.isDirectory()) return notFound(res)
    const ext = path.extname(filePath)
    const map = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" }
    res.setHeader("Content-Type", map[ext] || "application/octet-stream")
    fs.createReadStream(filePath).pipe(res)
  } catch {
    return notFound(res)
  }
}
function csvEscape(v){ if(v==null)return ""; const s=String(v).replace(/\r?\n/g," "); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s }
function safeName(s, ext){ return (s||"file").substring(0,80).replace(/[^\w.-]+/g,"_")+(ext||"") }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }
async function withRetry(fn,{retries=3,baseDelay=500}){ let last; for(let i=0;i<retries;i++){ try{return await fn()}catch(e){ last=e; await sleep(baseDelay*Math.pow(2,i)) } } throw last }

async function writeLineAsync(stream, line) {
  if (!stream.write(line + "\n")) {
    await new Promise(r => stream.once('drain', r))
  }
}

function parsePublication(summary, citationMeta = {}) {
  // Try citation meta first for higher accuracy
  const metaDate = citationMeta["citation_publication_date"] || citationMeta["citation_date"] || citationMeta["dc.date"]
  const metaPublisher = citationMeta["citation_publisher"] || citationMeta["dc.publisher"] || citationMeta["citation_journal_title"]
  let year = ""
  let fullDate = ""
  let publisher = metaPublisher || ""
  
  if (metaDate) {
    const d = new Date(metaDate)
    if (!isNaN(d.getTime())) {
      year = String(d.getFullYear())
      fullDate = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    } else {
      const yearMatch = metaDate.match(/\d{4}/)
      year = yearMatch ? yearMatch[0] : ""
      fullDate = metaDate
    }
  }

  if (!summary) return { authors: "", journal: "", year: year || "", fullDate: fullDate || year, publisher }
  
  const parts = summary.split(" - ")
  const authors = parts[0] || ""
  const journalAndYear = parts[1] || ""
  const journalParts = journalAndYear.split(", ")
  
  if (!year) {
    const yearMatch = journalAndYear.match(/\d{4}/)
    year = yearMatch ? yearMatch[0] : ""
    fullDate = year
  }
  
  const journal = journalParts[0] || ""
  // If publisher not in meta, try to infer from journal name or link if needed, 
  // but journal is usually the publisher in some contexts or we keep it separate
  return { authors, journal, year, fullDate: fullDate || year, publisher }
}

function extractCitationMeta(html){
  const meta={}
  const regex=/<meta\s+(?:name|property)=["']([^"']+)["']\s+content=["']([^"']+)["']/gi
  let m
  while((m=regex.exec(html))){
    if(m[1].startsWith("citation_") || m[1].startsWith("dc.")){
      meta[m[1]]=m[2]
    }
  }
  return meta
}

async function fetchFullAbstract(targetUrl, scraperApiKey) {
  if (!targetUrl || !scraperApiKey) return { abstract: "", html: "", citation_meta: {} }
  try {
    const r = await axios.get("https://api.scraperapi.com/", {
      params: { api_key: scraperApiKey, url: targetUrl, render: "true" }, // Use render:true for JS-heavy sites (Elsevier, etc.)
      timeout: 30000
    })
    const html = String(r.data)
    const citation_meta = extractCitationMeta(html)
    
    // Most common academic meta tags for abstracts
    const metaMatch = html.match(/<meta[^>]*name=["'](?:citation_abstract|dc\.description|prism\.teaser|description|og:description|twitter:description|DC\.description)["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["'](?:citation_abstract|dc\.description|prism\.teaser|description|og:description|twitter:description|DC\.description)["']/i)
    
    let abstract = ""
    if (metaMatch && metaMatch[1]) {
      abstract = metaMatch[1].trim()
    } else {
      // Very aggressive fallback patterns for diverse publisher layouts
      const absMatch = 
        // 1. Elsevier/ScienceDirect
        html.match(/<div[^>]*class=["']abstract-content[^"']*["'][^>]*>([\s\S]{50,10000}?)<\/div>/i) ||
        // 2. Springer/Nature
        html.match(/<div[^>]*class=["']c-article-section__content[^"']*["'][^>]*>([\s\S]{50,10000}?)<\/div>/i) ||
        // 3. Wiley/IEEE
        html.match(/<div[^>]*class=["']article-section__content[^"']*["'][^>]*>([\s\S]{50,10000}?)<\/div>/i) ||
        // 4. PubMed/PMC
        html.match(/<div[^>]*id=["']abstract["'][^>]*>([\s\S]{50,10000}?)<\/div>/i) ||
        // 5. General "abstract" section
        html.match(/Abstract<\/h[1-6]>\s*<p[^>]*>([\s\S]{50,10000}?)<\/p>/i) ||
        // 6. Common class names
        html.match(/<div[^>]*class=["'](?:abstract|abstract-text|paper-abstract)["'][^>]*>([\s\S]{50,10000}?)<\/div>/i) ||
        // 7. ArXiv/Quote
        html.match(/<blockquote[^>]*class=["']abstract[^"']*["'][^>]*>([\s\S]{50,10000}?)<\/blockquote>/i)
      
      if (absMatch && absMatch[1]) {
        // Clean up HTML tags but keep the content fully intact
        abstract = absMatch[1]
          .replace(/<script[\s\S]*?<\/script>/gi, "") // Remove scripts
          .replace(/<style[\s\S]*?<\/style>/gi, "")   // Remove styles
          .replace(/<[^>]+>/g, " ")                  // Replace tags with spaces
          .replace(/\s+/g, " ")                      // Normalize spaces
          .trim()
          .substring(0, 10000) // Significantly higher limit to capture everything
      }
    }
    
    // Store only up to MAX_HTML_STORAGE_BYTES to prevent JSON bloat
    const truncatedHtml = html.length > MAX_HTML_STORAGE_BYTES ? html.substring(0, MAX_HTML_STORAGE_BYTES) + " (truncated)" : html
    
    return { abstract, html: truncatedHtml, citation_meta }
  } catch (e) {
    return { abstract: "", html: "", citation_meta: {} }
  }
}

async function fetchScholar(keyword, apiKey, start=0, num=20, filters={}){
  const urlStr="https://serpapi.com/search.json"
  // Advanced parameters to match standard Google Scholar results 100%
  const params={
    engine: "google_scholar",
    q: String(keyword).trim(),
    api_key: apiKey,
    start: start,
    num: num,
    hl: "en",
    gl: "us",
    as_ylo: filters.yearFrom || "",
    as_yhi: filters.yearTo || "",
    as_sauthors: filters.author || "",
    as_publication: filters.journal || "",
    as_sdt: "0,5",
    scisbd: 0 // 0 for relevance, 1 for date
  }
  const r=await axios.get(urlStr,{params,timeout:20000,validateStatus:()=>true})
  if(!r.data) throw new Error("empty_response")
  if(r.status===429 || (r.data.error && r.data.error.includes("quota"))) {
    const err = new Error(r.data.error || "SerpApi quota exceeded or rate limit hit")
    err.isQuotaError = true
    throw err
  }
  if(r.status>=400||r.data.error) throw new Error(r.data.error||`http_${r.status}`)
  const results=Array.isArray(r.data.organic_results)?r.data.organic_results:[]
  const rows=[]
  for(const item of results){
    let pdfUrl = ""
    // 1. Direct resources check
    const pdfRes=Array.isArray(item.resources)?item.resources.find(x=>x.file_format==="PDF"):null
    if (pdfRes) {
      pdfUrl = pdfRes.link
    } 
    // 2. Check main link
    else if (item.link && (item.link.toLowerCase().endsWith(".pdf") || item.link.toLowerCase().includes("pdf"))) {
      pdfUrl = item.link
    }
    // 3. Check version links (New improvement)
    else if (item.inline_links?.versions?.link && item.inline_links.versions.link.toLowerCase().includes("pdf")) {
      pdfUrl = item.inline_links.versions.link
    }

    rows.push({
      keyword,
      serpapi_raw: item,
      pdf_url: pdfUrl,
      full_abstract: "",
      scraper_html: "",
      citation_meta: {}
    })
  }
  return rows
}
async function fetchScholarPaged(keyword, apiKey,{maxResults=DEFAULT_MAX_RESULTS,rateDelay=DEFAULT_RATE_DELAY,filters={}}={}){
  const all=[]; let start=0
  const PAGE_SIZE = 20 // Google Scholar limit per page is 20
  while(all.length<maxResults){
    const num = Math.min(PAGE_SIZE, maxResults - all.length)
    const rows=await withRetry(()=>fetchScholar(keyword,apiKey,start,num,filters),{retries:3,baseDelay:600})
    if(!rows.length) break
    for(const r of rows){ if(all.length<maxResults) all.push(r) }
    if(rows.length<num) break
    start+=PAGE_SIZE; if(all.length<maxResults) await sleep(rateDelay)
  }
  return all
}
function getDomainScore(link){
  if(!link) return 0
  const l = link.toLowerCase()
  if(l.includes("ieee")) return 10
  if(l.includes("acm.org")) return 10
  if(l.includes("springer.com")) return 10
  if(l.includes("nature.com")) return 10
  if(l.includes("science.org")) return 10
  if(l.includes("arxiv.org")) return 8
  if(l.includes("researchgate.net")) return 4
  if(l.includes("sciencedirect.com") || l.includes("elsevier.com")) return 10
  if(l.includes("wiley.com")) return 8
  if(l.includes(".edu")) return 5
  return 2
}

async function ensureTmp(jobId){ 
  const dir=path.join(root,"tmp",jobId); 
  await fsp.mkdir(dir,{recursive:true}); 
  return dir 
}

async function runScholarJob(job){
  job.status="running"; job.errors=[]
  const all=[]
  const limit = pLimit(CONCURRENCY_LIMIT)
  
  let completedKeywords = 0
  let aborted = false
  const tasks = job.keywords.map(kw => limit(async () => {
    if (aborted) return
    try {
      const collectionLimit = 100 // Reduced from 200 to 100 to match top Scholar results
      const rows = await fetchScholarPaged(kw, job.apiKey, {
        maxResults: collectionLimit, 
        rateDelay: DEFAULT_RATE_DELAY,
        filters: job.filters || {}
      })
      if (rows.length) {
        if (SCRAPER_KEY) {
          const absLimit = pLimit(5)
          await Promise.all(rows.map(r => absLimit(async () => {
            const paperUrl = r.serpapi_raw.link
            if (paperUrl) {
              const scrapeResult = await fetchFullAbstract(paperUrl, SCRAPER_KEY)
              r.full_abstract = scrapeResult.abstract
              r.scraper_html = scrapeResult.html
              r.citation_meta = scrapeResult.citation_meta
            }
          })))
        }

        for (const r of rows) {
          if (all.length < MAX_JSON_RESULTS) {
            all.push(r)
            
            if (!job.results_preview) job.results_preview = []
            const pub = parsePublication(r.serpapi_raw.publication_info?.summary || "", r.citation_meta)
            const previewRow = {
              title: r.serpapi_raw.title,
              link: r.serpapi_raw.link,
              snippet: r.serpapi_raw.snippet,
              authors: pub.authors,
              journal: pub.journal,
              publisher: pub.publisher || pub.journal, // Store publisher separately
              year: pub.fullDate || pub.year, // Use full calendar date if available
              pdf_url: r.pdf_url,
              full_abstract: r.full_abstract,
              cited_by: r.serpapi_raw.inline_links?.cited_by?.total || 0,
              versions_total: r.serpapi_raw.inline_links?.versions?.total || 0,
              versions_link: r.serpapi_raw.inline_links?.versions?.link || ""
            }
            job.results_preview.push(previewRow) // Use push to maintain Scholar ranking order
            if (job.results_preview.length > 500) job.results_preview.shift() // Remove from beginning if too many
          }
        }
      } else {
        job.errors.push({keyword: kw, error: "no_results"})
      }
    } catch (e) {
      if (e && e.isQuotaError) {
        aborted = true
        job.errors.push({keyword: "GLOBAL", error: "SerpApi quota exceeded. Stopping job early."})
      } else {
        job.errors.push({keyword: kw, error: String(e && e.message ? e.message : e)})
      }
    } finally {
      completedKeywords++
      job.progress = Math.round((completedKeywords / job.keywords.length) * 60)
    }
  }))

  await Promise.all(tasks)
  
  // Use results in the order they were collected from Scholar
  let finalResults = all
  
  // Limit to max results per job requirement
  if (finalResults.length > DEFAULT_MAX_RESULTS) {
    finalResults = finalResults.slice(0, DEFAULT_MAX_RESULTS)
  }
  
  // CSV Writing
  const csvHeaders=["keyword","title","link","authors","journal","year","snippet","full_abstract","pdf_url"]
  const csvPath=path.join(job.tmpDir,"results.csv")
  const csvStream = fs.createWriteStream(csvPath)
  await writeLineAsync(csvStream, csvHeaders.join(","))
  
  for (const r of finalResults) {
      const raw = r.serpapi_raw
      const { authors, journal, year, fullDate } = parsePublication(raw.publication_info?.summary || "", r.citation_meta)
      const csvRow = {
        keyword: r.keyword,
        title: raw.title || "",
        link: raw.link || "",
        authors,
        journal,
        year: fullDate || year,
        snippet: raw.snippet || "",
        full_abstract: r.full_abstract || "",
        pdf_url: r.pdf_url || ""
      }
      await writeLineAsync(csvStream, csvHeaders.map(h => csvEscape(csvRow[h])).join(","))
    }
  await new Promise(resolve => { csvStream.end(resolve) })
  
  job.resultsCount=finalResults.length
  if(!finalResults.length){ job.status="failed"; job.progress=100; job.message="no_results"; return }
  
  job.progress=70
  job.csvPath=csvPath
  
  job.progress=80
  // Excel
  const wb=XLSX.utils.book_new()
  const xlsxData = [csvHeaders, ...finalResults.map(r => {
    const raw = r.serpapi_raw
    const { authors, journal, year, fullDate } = parsePublication(raw.publication_info?.summary || "", r.citation_meta)
    return [
      r.keyword,
      raw.title || "",
      raw.link || "",
      authors,
      journal,
      fullDate || year,
      raw.snippet || "",
      r.full_abstract || "",
      r.pdf_url || ""
    ]
  })]
  const ws=XLSX.utils.aoa_to_sheet(xlsxData); XLSX.utils.book_append_sheet(wb,ws,"results")
  const xlsxPath=path.join(job.tmpDir,"results.xlsx"); XLSX.writeFile(wb,xlsxPath); job.xlsxPath=xlsxPath
  
  const jsonPath=path.join(job.tmpDir,"results.json")
  await fsp.writeFile(jsonPath,JSON.stringify(finalResults,null,2),"utf8") 
  job.jsonPath=jsonPath
  
  job.progress=85
  job.pdfs=finalResults
  job.results=[]; job.progress=100; job.status="succeeded"
}
async function ensureTmp(jobId){ 
  const dir=path.join(root,"tmp",jobId); 
  await fsp.mkdir(dir,{recursive:true}); 
  return dir 
}
async function handleKeywords(req,res){
  const apiKey=SERP_KEY; if(!apiKey) return json(res,400,{error:"SERPAPI_KEY not set"})
  if(req.headers['content-length'] > 5 * 1024 * 1024){
    return json(res,413,{error:"request too large (max 5MB)"})
  }
  const body=await new Promise(r=>{ let d=[]; req.on("data",c=>d.push(c)); req.on("end",()=>{ try{ r(JSON.parse(Buffer.concat(d).toString("utf8")||"{}")) }catch{ r({}) } }) })
  const keywords=Array.isArray(body.keywords)?body.keywords.map(s=>String(s).trim()).filter(Boolean):[]
  if(!keywords.length) return json(res,400,{error:"no keywords"})

  const filters = {
    author: body.advAuthor || "",
    journal: body.advJournal || "",
    yearFrom: body.yearFrom || "",
    yearTo: body.yearTo || ""
  }

  const jobId=crypto.randomBytes(8).toString("hex"); 
  const tmpDir=await ensureTmp(jobId)
  const job={
    id:jobId,
    status:"queued",
    progress:0,
    keywords:keywords,
    filters:filters,
    tmpDir,
    createdAt:Date.now(),
    results:[],
    apiKey
  }; 
  scholarJobs.set(jobId,job); 
  runScholarJob(job); 
  return json(res,200,{jobId})
}
function streamCSV(res,job){ res.statusCode=200; res.setHeader("Content-Type","text/csv; charset=utf-8"); res.setHeader("Content-Disposition",`attachment; filename="${safeName("results",".csv")}"`); fs.createReadStream(job.csvPath).pipe(res) }
function streamXLSX(res,job){ res.statusCode=200; res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.setHeader("Content-Disposition",`attachment; filename="${safeName("results",".xlsx")}"`); fs.createReadStream(job.xlsxPath).pipe(res) }
function streamJSON(res,job){ res.statusCode=200; res.setHeader("Content-Type","application/json; charset=utf-8"); res.setHeader("Content-Disposition",`attachment; filename="${safeName("results",".json")}"`); fs.createReadStream(job.jsonPath).pipe(res) }
async function streamZip(res,job){
  try {
    res.statusCode=200; 
    res.setHeader("Content-Type","application/zip"); 
    res.setHeader("Content-Disposition",`attachment; filename="${safeName(job.id,".zip")}"`);
    res.setHeader("Connection", "close");

    const archive=Archiver("zip",{zlib:{level:9}}); 
    archive.on("error",(err)=>{ 
      console.error("Archive error:", err);
      try{res.end()}catch{} 
    }); 
    
    // Handle client disconnect
    res.on("close", () => {
      if (!archive.isAborted) archive.abort();
    });

    archive.pipe(res);

    // Add a manifest file first so ZIP is never empty (prevents Windows 'Access Denied' error)
    const manifest = `Job ID: ${job.id}\nKeywords: ${job.keywords.join(", ")}\nTotal Results Found: ${job.resultsCount}\nDownloaded on: ${new Date().toISOString()}\n`;
    archive.append(manifest, { name: 'job_info.txt' });
    
    const dlLimit = pLimit(3) // Parallelize downloads
    const MIN_PDF_SIZE = 50 * 1024; // 50KB minimum for a real paper

    const tasks = job.pdfs.map((row, i) => dlLimit(async () => {
      try{
        let pdfBuffer = null
        const tryDownload = async (targetUrl) => {
          if (!targetUrl) return null
          try {
            // Direct attempt
            let resp = await axios.get(targetUrl, {
              responseType: "arraybuffer",
              timeout: 15000,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36" },
              validateStatus: (s) => s < 400
            })
            
            let buf = Buffer.from(resp.data)
            // Magic bytes for PDF: %PDF and check minimum size
            if (buf.length >= MIN_PDF_SIZE && buf.toString("utf8", 0, 4) === "%PDF") return buf
            
            // If not PDF, maybe HTML?
            if (SCRAPER_KEY) {
              resp = await axios.get("https://api.scraperapi.com/", {
                params: { api_key: SCRAPER_KEY, url: targetUrl },
                responseType: "arraybuffer",
                timeout: 30000
              })
              buf = Buffer.from(resp.data)
              if (buf.length >= MIN_PDF_SIZE && buf.toString("utf8", 0, 4) === "%PDF") return buf
              
              // Still not PDF? Maybe it's a landing page. Try to find a PDF link in the HTML
            const html = buf.toString("utf8")
            const pdfMatch = html.match(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i) || 
                             html.match(/href=["']([^"']+\/download\/pdf(?:\?[^"']*)?)["']/i) ||
                             html.match(/citation_pdf_url["']\s*content=["']([^"']+)["']/i) ||
                             html.match(/full-text-link["']\s*href=["']([^"']+)["']/i) ||
                             html.match(/pdf-link["']\s*href=["']([^"']+)["']/i) ||
                             html.match(/href=["']([^"']*(?:pdf|download|fulltext|article-pdf|pdfviewer|fulltext\.pdf|content\/pdf)[^"']*)["']/i) ||
                             html.match(/["'](https?:\/\/[^"']+\.pdf(?:\?[^"']*)?)["']/i)
            
            if (pdfMatch && pdfMatch[1]) {
                 let nextUrl = pdfMatch[1]
                 if (nextUrl.includes("\\/")) nextUrl = nextUrl.replace(/\\\//g, "/")
                 if (!nextUrl.startsWith("http")) {
                   try { nextUrl = new URL(nextUrl, targetUrl).toString() } catch {
                     const base = new URL(targetUrl).origin
                     nextUrl = new URL(nextUrl, base).toString()
                   }
                 }
                 const nextResp = await axios.get("https://api.scraperapi.com/", {
                   params: { api_key: SCRAPER_KEY, url: nextUrl },
                   responseType: "arraybuffer",
                   timeout: 30000
                 })
                const nextBuf = Buffer.from(nextResp.data)
                if (nextBuf.length >= MIN_PDF_SIZE && nextBuf.toString("utf8", 0, 4) === "%PDF") return nextBuf
              }
            }
          } catch (e) { return null }
          return null
        }

        pdfBuffer = await tryDownload(row.pdf_url)
        if (!pdfBuffer) pdfBuffer = await tryDownload(row.serpapi_raw.link) // Use raw link if pdf_url fails

        if (pdfBuffer) {
          const fname=safeName(row.serpapi_raw.title||`paper_${i+1}`,".pdf")
          archive.append(pdfBuffer,{name:fname})
        } else {
          try{ console.log("Failed to find valid PDF for:", row.serpapi_raw.title || row.pdf_url) }catch{}
        }
      }catch(e){
        console.error("PDF download error:", row.pdf_url, e.message)
      }
    }))

    await Promise.all(tasks)
    await archive.finalize()
  } catch (err) {
    console.error("streamZip global error:", err)
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
}

const server=http.createServer(async (req,res)=>{
  const parsed=url.parse(req.url,true); const pathname=parsed.pathname||"/"
  if(req.method==="GET" && pathname==="/"){ return await serveFile(res,path.join(webDir,"index.html")) }
  if(req.method==="GET" && pathname.startsWith("/assets/")){ return await serveFile(res,path.join(webDir,pathname)) }
  if(req.method==="GET" && pathname==="/api/health"){ return json(res,200,{up:true,hasSerpApiKey:Boolean(SERP_KEY),port,auth:Boolean(process.env.API_TOKEN)}) }
  if(req.method==="POST" && pathname==="/api/scholar/keywords"){ if(API_TOKEN){ const auth=req.headers["authorization"]||""; if(auth!==`Bearer ${API_TOKEN}`) return json(res,401,{error:"unauthorized"}) } return handleKeywords(req,res) }
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/status$/.test(pathname)){ 
    const id=pathname.split("/")[3]; 
    const job=scholarJobs.get(id); 
    if(!job) return json(res,404,{error:"job_not_found"}); 
    return json(res,200,{ 
      id:job.id,
      status:job.status,
      progress:job.progress,
      keywords:job.keywords, 
      counts:{results:job.resultsCount||0,pdfs:(job.pdfs||[]).length}, 
      errors:job.errors||[], 
      message:job.message||"",
      results: job.results_preview || [] // Provide preview results for real-time UI
    }) 
  }
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/results\.csv$/.test(pathname)){ const id=pathname.split("/")[3]; const job=scholarJobs.get(id); if(!job||job.status!=="succeeded"||!job.csvPath) return notFound(res); return streamCSV(res,job) }
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/results\.xlsx$/.test(pathname)){ const id=pathname.split("/")[3]; const job=scholarJobs.get(id); if(!job||job.status!=="succeeded"||!job.xlsxPath) return notFound(res); return streamXLSX(res,job) }
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/results\.json$/.test(pathname)){ const id=pathname.split("/")[3]; const job=scholarJobs.get(id); if(!job||job.status!=="succeeded"||!job.jsonPath) return notFound(res); return streamJSON(res,job) }
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/pdfs\.zip$/.test(pathname)){ const id=pathname.split("/")[3]; const job=scholarJobs.get(id); if(!job||job.status!=="succeeded"||!job.pdfs) return notFound(res); return streamZip(res,job) }
  
  const filePath=path.join(webDir,pathname); 
  if(filePath.startsWith(webDir)) {
    try {
      const stat = await fsp.stat(filePath)
      if (stat.isFile()) return await serveFile(res,filePath)
    } catch {}
  }
  notFound(res)
})

server.listen(port,()=>{ process.stdout.write(`Server listening on http://localhost:${port}\n`) })

setInterval(async ()=>{ 
  try{ 
    const base=path.join(root,"tmp"); 
    try { await fsp.access(base) } catch { return }
    const now=Date.now(); 
    const entries = await fsp.readdir(base, { withFileTypes: true })
    for(const entry of entries){ 
      if (entry.isDirectory()) {
        const dir = path.join(base, entry.name)
        try {
          const stat = await fsp.stat(dir)
          if (now - stat.mtimeMs > TMP_TTL_MS) {
            await fsp.rm(dir, { recursive: true, force: true })
          }
        } catch {}
      }
    } 
  } catch {} 
}, 10*60*1000)
