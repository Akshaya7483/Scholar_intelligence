const http = require("http")
const fs = require("fs")
const fsp = require("fs").promises
const path = require("path")
const url = require("url")
const crypto = require("crypto")
try {
  const dotenv = require("dotenv")
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") })
  dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") })
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

function parsePublication(summary) {
  if (!summary) return { authors: "", journal: "", year: "" }
  const parts = summary.split(" - ")
  const authors = parts[0] || ""
  const journalAndYear = parts[1] || ""
  const journalParts = journalAndYear.split(", ")
  const yearMatch = journalAndYear.match(/\d{4}/)
  const year = yearMatch ? yearMatch[0] : ""
  const journal = journalParts[0] || ""
  return { authors, journal, year }
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
      params: { api_key: scraperApiKey, url: targetUrl },
      timeout: 20000
    })
    const html = String(r.data)
    const citation_meta = extractCitationMeta(html)
    
    // Extract abstract using meta tags (Scholar common tags)
    const metaMatch = html.match(/<meta[^>]*name=["'](?:citation_abstract|description|og:description|twitter:description|dc.description)["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["'](?:citation_abstract|description|og:description|twitter:description|dc.description)["']/i)
    
    let abstract = ""
    if (metaMatch && metaMatch[1]) {
      abstract = metaMatch[1].trim()
    } else {
      // Fallback: look for "Abstract" section with more patterns
      const absMatch = html.match(/Abstract<\/h[1-6]>\s*<p[^>]*>([\s\S]{10,2500}?)<\/p>/i) ||
                       html.match(/<div[^>]*class=["']abstract["'][^>]*>([\s\S]{10,2500}?)<\/div>/i) ||
                       html.match(/<blockquote[^>]*abstract[^>]*>([\s\S]{10,2500}?)<\/blockquote>/i) ||
                       html.match(/<section[^>]*Abstract[^>]*>([\s\S]{10,2500}?)<\/section>/i) ||
                       html.match(/<div[^>]*class=["']c-article-section__content["'][^>]*>([\s\S]{10,2500}?)<\/div>/i)
      
      if (absMatch && absMatch[1]) abstract = absMatch[1].replace(/<[^>]*>/g, "").trim().substring(0, 3000)
    }
    
    // Store only up to MAX_HTML_STORAGE_BYTES to prevent JSON bloat
    const truncatedHtml = html.length > MAX_HTML_STORAGE_BYTES ? html.substring(0, MAX_HTML_STORAGE_BYTES) + " (truncated)" : html
    
    return { abstract, html: truncatedHtml, citation_meta }
  } catch (e) {
    return { abstract: "", html: "", citation_meta: {} }
  }
}

async function fetchScholar(keyword, apiKey, start=0, num=10){
  const urlStr="https://serpapi.com/search.json"
  const params={engine:"google_scholar",q:keyword,hl:"en",api_key:apiKey,start,num}
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
    const pdfRes=Array.isArray(item.resources)?item.resources.find(x=>x.file_format==="PDF"):null
    if (pdfRes) {
      pdfUrl = pdfRes.link
    } else if (item.link && (item.link.toLowerCase().endsWith(".pdf") || item.link.toLowerCase().includes("pdf"))) {
      pdfUrl = item.link
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
async function fetchScholarPaged(keyword, apiKey,{maxResults=DEFAULT_MAX_RESULTS,rateDelay=DEFAULT_RATE_DELAY}={}){
  const all=[]; let start=0
  const PAGE_SIZE = 20 // Google Scholar limit per page is 20
  while(all.length<maxResults){
    const num = Math.min(PAGE_SIZE, maxResults - all.length)
    const rows=await withRetry(()=>fetchScholar(keyword,apiKey,start,num),{retries:3,baseDelay:600})
    if(!rows.length) break
    for(const r of rows){ if(all.length<maxResults) all.push(r) }
    if(rows.length<num) break
    start+=PAGE_SIZE; if(all.length<maxResults) await sleep(rateDelay)
  }
  return all
}
async function runScholarJob(job){
  job.status="running"; job.errors=[]
  const all=[]
  const limit = pLimit(CONCURRENCY_LIMIT)
  
  const csvHeaders=["keyword","title","link","authors","journal","year","snippet","full_abstract","pdf_url"]
  const csvPath=path.join(job.tmpDir,"results.csv")
  const csvStream = fs.createWriteStream(csvPath)
  await writeLineAsync(csvStream, csvHeaders.join(","))

  let completedKeywords = 0
  let aborted = false
  const tasks = job.keywords.map(kw => limit(async () => {
    if (aborted) return
    try {
      const rows = await fetchScholarPaged(kw, job.apiKey, {maxResults: DEFAULT_MAX_RESULTS, rateDelay: DEFAULT_RATE_DELAY})
      if (rows.length) {
        // Fetch full abstracts for each result using ScraperAPI
        if (SCRAPER_KEY) {
          const absLimit = pLimit(5) // Limit concurrent abstract fetches
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
          if (all.length < MAX_JSON_RESULTS) { // Global memory protection for JSON and CSV
            all.push(r)
            
            // Map raw data to basic fields for CSV
            const raw = r.serpapi_raw
            const { authors, journal, year } = parsePublication(raw.publication_info?.summary || "")
            const csvRow = {
              keyword: r.keyword,
              title: raw.title || "",
              link: raw.link || "",
              authors,
              journal,
              year,
              snippet: raw.snippet || "",
              full_abstract: r.full_abstract || "",
              pdf_url: r.pdf_url || ""
            }
            await writeLineAsync(csvStream, csvHeaders.map(h => csvEscape(csvRow[h])).join(","))
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
  await new Promise(resolve => { csvStream.end(resolve) }) // Safer closing
  
  job.resultsCount=all.length
  if(!all.length){ job.status="failed"; job.progress=100; job.message="no_results"; return }
  
  job.progress=70
  job.csvPath=csvPath
  
  job.progress=80
  // Excel also uses basic fields
  const wb=XLSX.utils.book_new()
  const xlsxData = [csvHeaders, ...all.map(r => {
    const raw = r.serpapi_raw
    const { authors, journal, year } = parsePublication(raw.publication_info?.summary || "")
    return [
      r.keyword,
      raw.title || "",
      raw.link || "",
      authors,
      journal,
      year,
      raw.snippet || "",
      r.full_abstract || "",
      r.pdf_url || ""
    ]
  })]
  const ws=XLSX.utils.aoa_to_sheet(xlsxData); XLSX.utils.book_append_sheet(wb,ws,"results")
  const xlsxPath=path.join(job.tmpDir,"results.xlsx"); XLSX.writeFile(wb,xlsxPath); job.xlsxPath=xlsxPath
  
  const jsonPath=path.join(job.tmpDir,"results.json")
  await fsp.writeFile(jsonPath,JSON.stringify(all,null,2),"utf8") // JSON keeps everything
  job.jsonPath=jsonPath
  
  job.progress=85
  job.pdfs=all // Try to download all papers found
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
  const arr=Array.isArray(body.keywords)?body.keywords.map(s=>String(s).trim()).filter(Boolean):[]
  if(!arr.length) return json(res,400,{error:"no keywords"})
  const jobId=crypto.randomBytes(8).toString("hex"); 
  const tmpDir=await ensureTmp(jobId)
  const job={id:jobId,status:"queued",progress:0,keywords:arr,tmpDir,createdAt:Date.now(),results:[],apiKey}; scholarJobs.set(jobId,job); runScholarJob(job); return json(res,200,{jobId})
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
  if(req.method==="GET" && /^\/api\/scholar\/[^/]+\/status$/.test(pathname)){ const id=pathname.split("/")[3]; const job=scholarJobs.get(id); if(!job) return json(res,404,{error:"job_not_found"}); return json(res,200,{ id:job.id,status:job.status,progress:job.progress,keywords:job.keywords, counts:{results:job.resultsCount||0,pdfs:(job.pdfs||[]).length}, errors:job.errors||[], message:job.message||"" }) }
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
