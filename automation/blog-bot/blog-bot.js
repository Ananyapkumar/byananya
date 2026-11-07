// byananya blog bot (Cloudflare Worker)
// Drafts a post the day before each publish date, sends it to ntfy for approval,
// and publishes approved posts to byananya.com through GitHub.
//
// Schedule (India time):
//   Health posts: 15th, and 30th (last day of the month if there is no 30th)
//   AI tools posts: 10th, 20th, and 30th (last working day of the month if there is no 30th)
//   Draft + notification: the day before. Unapproved drafts get a reminder every morning.
//
// Needs:
//   KV binding  BLOG          (namespace "byananya-blog-drafts")
//   Secrets     GITHUB_TOKEN, ADMIN_KEY, NTFY_TOPIC, GROQ_KEY, TAVILY_KEY, GEMINI_KEY, optionally ANTHROPIC_KEY (paid, capped)
//   Writers, in order: Groq Compound -> Tavily search + Groq -> Gemini -> Claude (capped)
//   Cron        30 3 * * *    (09:00 India time)
//   D1 binding  STATS         (database "byananya-stats") for the anonymous daily visitor report

const REPO = 'Ananyapkumar/byananya';
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const IST = 5.5 * 3600 * 1000;
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'];
// Claude backup: only used when Gemini AND Groq both fail. Roughly Rs 2-3 per use; hard cap of 5 uses a month (about Rs 15 at most).
const CLAUDE_MODELS = ['claude-haiku-4-5', 'claude-haiku-5-5'];
const CLAUDE_MAX_CALLS_PER_MONTH = 5;
const CLAUDE_SEARCHES_PER_POST = 1;

// ---------- dates ----------
const ymd = d => d.toISOString().slice(0, 10);
const istToday = () => ymd(new Date(Date.now() + IST));
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function lastDay(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function lastWorkingDay(y, m) {
  let d = lastDay(y, m);
  while ([0, 6].includes(new Date(Date.UTC(y, m, d)).getUTCDay())) d--;
  return d;
}
// Which posts are due on a given date
function slotsOn(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'), y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const has30 = lastDay(y, m) >= 30, out = [];
  if (day === 15 || (has30 ? day === 30 : day === lastDay(y, m))) out.push('health');
  if (day === 10 || day === 20 || (has30 ? day === 30 : day === lastWorkingDay(y, m))) out.push('tech');
  return out.map(type => ({ type, date: dateStr, id: type + '-' + dateStr }));
}

// ---------- helpers ----------
const esc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64 = s => btoa(unescape(encodeURIComponent(s)));
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const prettyDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const label = t => t === 'health' ? 'Health post' : 'AI tools post';

async function notify(env, title, message, url, tags) {
  await fetch('https://ntfy.sh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, click: url, tags: tags || ['memo'], priority: 4,
      actions: url ? [{ action: 'view', label: 'Open draft', url }] : undefined })
  });
}

// ---------- writing ----------
const VOICE = `Write as Ananya, in first person: warm, curious, a little witty, smart without being stiff. Short paragraphs. Markdown with 2 to 4 "##" subheadings. 450 to 650 words.
Hard rules:
- Do not invent personal experiences. Never claim "I tried it", "I've been using it", or anything that happened to me. Opinions are fine ("I find this wild").
- Only state facts you found in the search results. No made-up numbers, quotes, names or dates.
- No hype words like "revolutionary", "game-changer", "delve", "in today's fast-paced world". No generic AI-sounding filler.
- Do not write a sources section; it is added automatically.`;

function brief(type, avoid) {
  const recent = avoid.length ? `\nDo NOT pick any of these recent topics: ${avoid.join('; ')}.` : '';
  if (type === 'health')
    return `Search the web and pick ONE recent (ideally from the last three months), genuinely fascinating health finding that most people have not heard about yet. It can be physical health, mental health, sleep, running, recovery, nutrition science or the brain. It must come from real research or credible reporting. Avoid generic advice topics like "drink more water" or "sleep 8 hours".${recent}
Write a blog post explaining it: what was found, why it is surprising, and a short practical "what this means for you" part. End with one line in italics: "This is me nerding out, not medical advice."`;
  return `Search the web and pick ONE AI tool, automation tool or piece of software released or launched recently (ideally in the last 30 days) that is genuinely cool and useful in everyday life, but not famous yet. Not a big-company flagship model release. Think small, clever, delightful.${recent}
Write a blog post about it like news with my opinion: what it is, what it does, why I love the idea, how I hadn't come across it sooner, and a short note on limits (platform, early access, privacy) if relevant.`;
}

async function gemini(env, body) {
  let last = '', busy = false;
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify(body)
    });
    if (r.ok) return r.json();
    const t = await r.text();
    last = model + ' ' + r.status + ': ' + t.slice(0, 300);
    if (/API_KEY_INVALID|PERMISSION_DENIED|API key not valid/i.test(t)) throw new Error('Gemini rejected the key. Check the GEMINI_KEY secret. (' + last + ')');
    if (r.status === 429) { busy = true; continue; } // this model has no free quota left: try the next one
  }
  if (busy) throw new Error('Gemini is out of free quota on every model for now. It will try again tomorrow. (' + last + ')');
  throw new Error('No Gemini model worked. Last reply: ' + last);
}

function parsePost(d) {
  const text = (((d.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Draft came back empty');
  const post = JSON.parse(m[0]);
  if (!post.title || !post.markdown) throw new Error('Draft missing title or text');
  const chunks = ((d.candidates || [])[0]?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean);
  const seen = new Set(), sources = [];
  for (const w of chunks) { const k = w.title || w.uri; if (!seen.has(k)) { seen.add(k); sources.push(w); } }
  return { ...post, sources: sources.slice(0, 6) };
}

const FORMAT = `Return ONLY a JSON object, no other text: {"title": "short, specific, not clickbait", "summary": "one sentence under 20 words", "topic": "3 to 6 word name of the topic", "markdown": "the full post in Markdown, without the title"}`;

async function claudeBudgetOk(env) {
  if (!env.ANTHROPIC_KEY) return false;
  const used = +((await env.BLOG.get('claude:' + istToday().slice(0, 7))) || 0);
  return used < CLAUDE_MAX_CALLS_PER_MONTH;
}
async function claudeCount(env) {
  const key = 'claude:' + istToday().slice(0, 7);
  await env.BLOG.put(key, String(+((await env.BLOG.get(key)) || 0) + 1));
}
async function claude(env, prompt, search) {
  let last = '';
  for (const model of CLAUDE_MODELS) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1800, messages: [{ role: 'user', content: prompt }],
        tools: search ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: CLAUDE_SEARCHES_PER_POST }] : undefined })
    });
    if (r.ok) {
      await claudeCount(env);
      const d = await r.json(), blocks = d.content || [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Claude draft came back empty');
      const post = JSON.parse(m[0]);
      if (!post.title || !post.markdown) throw new Error('Claude draft missing title or text');
      const seen = new Set(), sources = [];
      for (const b of blocks.filter(b => b.type === 'web_search_tool_result'))
        for (const res of (Array.isArray(b.content) ? b.content : []))
          if (res.url && !seen.has(res.url)) { seen.add(res.url); sources.push({ uri: res.url, title: res.title || res.url }); }
      return { ...post, sources: sources.slice(0, 6) };
    }
    last = model + ' ' + r.status + ': ' + (await r.text()).slice(0, 200);
    if (r.status === 401 || r.status === 403) throw new Error('Claude rejected the key. Check the ANTHROPIC_KEY secret.');
    if (r.status !== 404 && r.status !== 400) break;
  }
  throw new Error('Claude backup failed: ' + last);
}

// Groq Compound: free, has built-in web search
async function groqWrite(env, prompt, search) {
  const models = search ? ['groq/compound'] : ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'];
  const fails = [];
  for (const model of models) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 3000, messages: [{ role: 'user', content: prompt +
        (search ? '\nAlso add a "sources" field to the JSON: a list of {"title": "...", "url": "..."} for the pages you actually used.' : '') }] })
    });
    if (!r.ok) { fails.push(model + ' ' + r.status); continue; }
    const d = await r.json(), msg = (d.choices || [])[0]?.message || {};
    const m = String(msg.content || '').match(/\{[\s\S]*\}/);
    if (!m) { fails.push(model + ' gave no JSON'); continue; }
    const post = JSON.parse(m[0]);
    if (!post.title || !post.markdown) { fails.push(model + ' missing title or text'); continue; }
    // prefer the search results Groq actually ran; fall back to the sources it listed
    const found = [];
    for (const t of (msg.executed_tools || [])) for (const res of (t.search_results?.results || [])) if (res.url) found.push({ uri: res.url, title: res.title || res.url });
    for (const s2 of (Array.isArray(post.sources) ? post.sources : [])) if (s2 && s2.url) found.push({ uri: s2.url, title: s2.title || s2.url });
    const seen = new Set(), sources = found.filter(x => !seen.has(x.uri) && seen.add(x.uri)).slice(0, 6);
    delete post.sources;
    return { ...post, sources };
  }
  throw new Error(fails.join(', ') || 'no model answered');
}

// Tavily search + Groq writing: both free, very reliable
function searchQueries(type) {
  const month = new Date(Date.now() + IST).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return type === 'health'
    ? ['surprising new health study ' + month, 'new research sleep exercise brain mental health finding ' + month]
    : ['new AI tool launched this week everyday use', 'Product Hunt new AI app launch ' + month];
}
async function tavilyGroq(env, slot, avoid) {
  const results = [];
  for (const q of searchQueries(slot.type)) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TAVILY_KEY },
      body: JSON.stringify({ api_key: env.TAVILY_KEY, query: q, search_depth: 'basic', topic: 'news', days: 30, max_results: 6 })
    });
    if (!r.ok) throw new Error('Tavily search failed ' + r.status);
    for (const x of ((await r.json()).results || [])) if (x.url && !results.some(y => y.url === x.url)) results.push(x);
  }
  if (!results.length) throw new Error('Tavily found nothing');
  const list = results.slice(0, 10).map((x, i) => `[${i + 1}] ${x.title}\nURL: ${x.url}\n${String(x.content || '').slice(0, 600)}`).join('\n\n');
  const prompt = brief(slot.type, avoid).replace(/^Search the web and pick/, 'From the search results below, pick') +
    '\n\n' + VOICE + '\n\nAlso include "used": a list of the result numbers you relied on, like [2, 5].\n' +
    FORMAT.replace('}', ', "used": [1, 2]}') + '\n\nSEARCH RESULTS:\n' + list;
  const post = await groqChat(env, prompt);
  const used = (Array.isArray(post.used) ? post.used : []).map(n => results[n - 1]).filter(Boolean);
  delete post.used;
  return { ...post, sources: (used.length ? used : results.slice(0, 3)).slice(0, 6).map(x => ({ uri: x.url, title: x.title })) };
}

// Plain Groq call that tries each model until one answers (models get retired over time)
async function groqChat(env, prompt) {
  const fails = [];
  for (const model of GROQ_MODELS) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 4000, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }],
        ...(model.startsWith('openai/') ? { reasoning_effort: 'low' } : {}) })
    });
    if (!r.ok) { fails.push(model.split('/').pop() + ' ' + r.status); continue; }
    try {
      const post = JSON.parse((await r.json()).choices[0].message.content);
      if (post.title && post.markdown) return post;
      fails.push(model.split('/').pop() + ' incomplete');
    } catch (e) { fails.push(model.split('/').pop() + ' bad JSON'); }
  }
  throw new Error('Groq: ' + fails.join(', '));
}

async function writeDraft(env, slot, avoid) {
  const prompt = brief(slot.type, avoid) + '\n\n' + VOICE + '\n\n' + FORMAT;
  const errors = [];
  if (env.GROQ_KEY && env.TAVILY_KEY) { try { return await tavilyGroq(env, slot, avoid); } catch (e) { errors.push('Tavily + Groq: ' + e.message.slice(0, 100)); } }
  else errors.push('Tavily + Groq: skipped, TAVILY_KEY not added yet');
  if (env.GEMINI_KEY) { try { return await writeDraftGemini(env, slot, avoid); } catch (e) { errors.push('Gemini: ' + (/quota|429/i.test(e.message) ? 'out of free quota' : e.message.slice(0, 100))); } }
  if (await claudeBudgetOk(env)) return claude(env, prompt, true);
  throw new Error('All writers were unavailable (' + errors.join(' | ') + '). It will try again tomorrow.');
}

async function writeDraftGemini(env, slot, avoid) {
  const d = await gemini(env, {
    contents: [{ role: 'user', parts: [{ text: brief(slot.type, avoid) + '\n\n' + VOICE + '\n\n' + FORMAT }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.8 }
  });
  return parsePost(d);
}

async function reviseDraft(env, draft, feedback) {
  const prompt = `Here is a blog post draft:\n\nTITLE: ${draft.title}\n\n${draft.markdown}\n\nRewrite it with this feedback from the author: "${feedback}"\nKeep the same facts. Do not add new facts.\n\n${VOICE}\n\n${FORMAT}`;
  let p, err = 'no writer available';
  if (env.GROQ_KEY) { try { p = await groqChat(env, prompt); } catch (e) { err = e.message; } }
  if (!p && env.GEMINI_KEY) { try { p = parsePost(await gemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } })); } catch (e) { err = e.message; } }
  if (!p && (await claudeBudgetOk(env))) p = await claude(env, prompt, false);
  if (!p) throw new Error('Could not rewrite right now (' + err.slice(0, 120) + ')');
  return { ...p, sources: draft.sources };
}

// ---------- drafts ----------
async function getDraft(env, id) { const v = await env.BLOG.get('draft:' + id); return v ? JSON.parse(v) : null; }
async function saveDraft(env, d) { await env.BLOG.put('draft:' + d.id, JSON.stringify(d)); }
async function recentTopics(env, type) { return JSON.parse((await env.BLOG.get('topics:' + type)) || '[]'); }
async function rememberTopic(env, type, topic) {
  const list = (await recentTopics(env, type)).concat(topic).slice(-24);
  await env.BLOG.put('topics:' + type, JSON.stringify(list));
}

async function createDraft(env, slot, extraAvoid) {
  const avoid = (await recentTopics(env, slot.type)).concat(extraAvoid || []);
  const p = await writeDraft(env, slot, avoid);
  const draft = { ...slot, ...p, status: 'pending', createdAt: new Date().toISOString() };
  await saveDraft(env, draft);
  return draft;
}

const draftUrl = (env, id) => `${env.BASE_URL}/draft/${id}?k=${encodeURIComponent(env.ADMIN_KEY)}`;

async function sendForApproval(env, d, reminder) {
  await notify(env,
    (reminder ? 'Still waiting: ' : 'Draft ready: ') + label(d.type),
    `"${d.title}"\nGoes live ${prettyDate(d.date)} once you approve. Tap to read, edit or approve.`,
    draftUrl(env, d.id), [d.type === 'health' ? 'running' : 'robot']);
}

// ---------- publishing ----------
async function gh(env, path, init) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...init, headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'byananya-blog-bot', ...(init && init.headers) }
  });
}

async function publish(env, d) {
  const slug = slugify(d.title) || d.id;
  let md = d.markdown.trim();
  if (d.sources && d.sources.length) md += '\n\n## Sources\n\n' + d.sources.map(s => `- [${s.title || 'Source'}](${s.uri})`).join('\n');
  // 1. the post file
  const put = await gh(env, `posts/${slug}.md`, { method: 'PUT', body: JSON.stringify({ message: 'New post: ' + d.title, content: b64(md + '\n'), branch: 'main' }) });
  if (!put.ok && put.status !== 422) throw new Error('GitHub post upload failed ' + put.status);
  // 2. the posts list
  const cur = await (await gh(env, 'posts/index.json')).json();
  const list = JSON.parse(unb64(cur.content)).filter(p => p.slug !== slug);
  list.unshift({ slug, title: d.title, date: d.date, summary: d.summary, topic: d.type === 'health' ? 'health' : 'tech' });
  const upd = await gh(env, 'posts/index.json', { method: 'PUT', body: JSON.stringify({ message: 'Add ' + slug + ' to blog', content: b64(JSON.stringify(list, null, 2) + '\n'), sha: cur.sha, branch: 'main' }) });
  if (!upd.ok) throw new Error('GitHub list update failed ' + upd.status);
  d.status = 'published'; d.slug = slug; d.publishedAt = new Date().toISOString();
  await saveDraft(env, d);
  await rememberTopic(env, d.type, d.topic || d.title);
  await notify(env, 'Published: ' + d.title, 'Live on byananya.com in a minute or two.', `https://byananya.com/post.html?p=${slug}`, ['tada']);
}

// ---------- anonymous visitor stats ----------
const SITE_ORIGINS = ['https://byananya.com', 'https://www.byananya.com'];
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|linkedinbot|whatsapp|headless|lighthouse|monitor/i;
function sourceOf(ref) {
  let h = '';
  try { h = new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { return 'direct'; }
  if (!h || h.endsWith('byananya.com')) return 'direct';
  if (/linkedin\.com$|lnkd\.in$/.test(h)) return 'LinkedIn';
  if (/google\./.test(h)) return 'Google';
  if (/github\.com$/.test(h)) return 'GitHub';
  if (/(^|\.)(t\.co|x\.com|twitter\.com)$/.test(h)) return 'X';
  if (/whatsapp|wa\.me/.test(h)) return 'WhatsApp';
  return h;
}
async function recordHit(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = { 'Access-Control-Allow-Origin': SITE_ORIGINS.includes(origin) ? origin : SITE_ORIGINS[0], 'Vary': 'Origin' };
  if (!SITE_ORIGINS.includes(origin) || !env.STATS) return new Response(null, { status: 204, headers: cors });
  const ua = request.headers.get('User-Agent') || '';
  if (BOT_UA.test(ua)) return new Response(null, { status: 204, headers: cors });
  let b = {};
  try { b = JSON.parse(await request.text()); } catch (e) {}
  const day = istToday();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // scrambled, changes every day, so no IP or person can be recovered from it
  const raw = new TextEncoder().encode(ip + '|' + ua + '|' + day + '|' + (env.ADMIN_KEY || ''));
  const visitor = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
  const page = String(b.p || '/').slice(0, 120);
  const kind = b.k === 'use' ? 'use' : 'view';
  await env.STATS.prepare('INSERT INTO hits (day, page, visitor, source, kind, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(day, page, visitor, sourceOf(b.r || ''), kind, new Date().toISOString()).run();
  return new Response(null, { status: 204, headers: cors });
}
const PAGE_NAMES = p => p === '/' || p === '/index.html' ? 'Home' : p.startsWith('/say-it-better') ? 'Say it better' : p.startsWith('/post.html') ? 'Blog: ' + (p.split('p=')[1] || 'post').replace(/-/g, ' ').slice(0, 40) : p;
async function statsFor(env, day) {
  const q = (sql) => env.STATS.prepare(sql).bind(day);
  const [v, pv, uses, pages, sources] = await Promise.all([
    q("SELECT COUNT(DISTINCT visitor) n FROM hits WHERE day = ? AND kind = 'view'").first(),
    q("SELECT COUNT(*) n FROM hits WHERE day = ? AND kind = 'view'").first(),
    q("SELECT COUNT(*) n FROM hits WHERE day = ? AND kind = 'use'").first(),
    q("SELECT page, COUNT(*) n FROM hits WHERE day = ? AND kind = 'view' GROUP BY page ORDER BY n DESC LIMIT 4").all(),
    q("SELECT src AS source, COUNT(*) n FROM (SELECT visitor, COALESCE(MAX(CASE WHEN source <> 'direct' THEN source END), 'direct') src FROM hits WHERE day = ? AND kind = 'view' GROUP BY visitor) GROUP BY src ORDER BY n DESC LIMIT 5").all()
  ]);
  return { visitors: v.n, views: pv.n, uses: uses.n, pages: pages.results, sources: sources.results };
}
function statsText(s) {
  if (!s.views) return 'No visits recorded.';
  return `${s.visitors} visitor${s.visitors === 1 ? '' : 's'}, ${s.views} page view${s.views === 1 ? '' : 's'}.\n` +
    `Top pages: ${s.pages.map(p => PAGE_NAMES(p.page) + ' (' + p.n + ')').join(', ')}\n` +
    `Came from: ${s.sources.map(x => x.source + ' ' + x.n).join(', ')}\n` +
    `Say it better used ${s.uses} time${s.uses === 1 ? '' : 's'}.`;
}
async function dailyReport(env) {
  if (!env.STATS) return 'no stats database';
  const yesterday = addDays(istToday(), -1);
  const s = await statsFor(env, yesterday);
  await notify(env, `Yesterday on byananya.com: ${s.visitors} visitor${s.visitors === 1 ? '' : 's'}`, statsText(s), 'https://byananya.com', ['bar_chart']);
  await env.STATS.prepare('DELETE FROM hits WHERE day < ?').bind(addDays(istToday(), -90)).run(); // keep 90 days
  return 'report sent for ' + yesterday;
}

// ---------- weekly queue (Sundays) ----------
const weekday = s => new Date(s + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
const shortDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
async function queue(env) {
  const today = istToday(), done = [], upcoming = [];
  const keys = await env.BLOG.list({ prefix: 'draft:' });
  const drafts = {};
  for (const k of keys.keys) { const d = JSON.parse(await env.BLOG.get(k.name)); if (!d.id.includes('-test-')) drafts[d.id] = d; }
  for (const d of Object.values(drafts))
    if (d.status === 'published' && d.publishedAt && d.publishedAt.slice(0, 10) >= addDays(today, -7)) done.push(`✅ ${shortDate(d.date)}: "${d.title}" (${label(d.type)})`);
  for (let i = 0; i <= 14; i++) {
    const day = addDays(today, i);
    for (const s of slotsOn(day)) {
      const d = drafts[s.id];
      const state = !d ? `draft arrives ${shortDate(addDays(day, -1))}, 9am`
        : d.status === 'pending' ? `⏳ waiting for your approval: "${d.title}"`
        : d.status === 'approved' ? `👍 approved: "${d.title}"`
        : d.status === 'published' ? `✅ published: "${d.title}"`
        : `skipped (${d.status})`;
      upcoming.push(`${shortDate(day)}, ${label(s.type)}: ${state}`);
    }
  }
  // any older drafts still waiting
  for (const d of Object.values(drafts)) if (d.status === 'pending' && d.date < today) upcoming.unshift(`⚠️ overdue, ${shortDate(d.date)}: "${d.title}" is still waiting for approval`);
  let site = '';
  if (env.STATS) {
    const r = await env.STATS.prepare("SELECT COUNT(DISTINCT visitor || day) n, COUNT(*) v FROM hits WHERE day >= ? AND day < ? AND kind = 'view'").bind(addDays(today, -7), today).first();
    site = `Site last 7 days: ${r.n} visits, ${r.v} page views.`;
  }
  return { done, upcoming, site };
}
function queueText(q) {
  return (q.done.length ? 'Published this week:\n' + q.done.join('\n') + '\n\n' : 'Nothing published this week.\n\n') +
    'Coming up (next 2 weeks):\n' + (q.upcoming.join('\n') || 'Nothing scheduled.') + (q.site ? '\n\n' + q.site : '');
}
async function weeklyUpdate(env) {
  const q = await queue(env);
  await notify(env, 'Your blog this week', queueText(q), `${env.BASE_URL}/queue?k=${encodeURIComponent(env.ADMIN_KEY)}`, ['calendar']);
  return 'weekly update sent';
}

// ---------- daily run ----------
async function daily(env) {
  const today = istToday(), tomorrow = addDays(today, 1), log = [];
  for (const slot of [...slotsOn(tomorrow), ...slotsOn(today)]) {
    if (await getDraft(env, slot.id)) continue;
    try { const d = await createDraft(env, slot); await sendForApproval(env, d); log.push('drafted ' + slot.id); }
    catch (e) { log.push('failed ' + slot.id + ': ' + e.message); await notify(env, 'Blog bot: draft failed', `${label(slot.type)} for ${prettyDate(slot.date)} could not be written (${e.message}). It will try again tomorrow morning.`, ''); }
  }
  const keys = await env.BLOG.list({ prefix: 'draft:' });
  for (const k of keys.keys) {
    const d = JSON.parse(await env.BLOG.get(k.name));
    if (d.date > today || d.id.includes('-test-')) continue;
    if (d.status === 'approved') { try { await publish(env, d); log.push('published ' + d.id); } catch (e) { log.push('publish failed ' + d.id + ': ' + e.message); } }
    else if (d.status === 'pending' && !(d.createdAt || '').startsWith(today)) { await sendForApproval(env, d, true); log.push('reminded ' + d.id); }
  }
  try { log.push(await dailyReport(env)); } catch (e) { log.push('report failed: ' + e.message); }
  if (weekday(today) === 0) { try { log.push(await weeklyUpdate(env)); } catch (e) { log.push('weekly update failed: ' + e.message); } }
  return log;
}

// ---------- review page ----------
function page(d, k, msg) {
  const src = (d.sources || []).map(s => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener">${esc(s.title || 'Source')}</a></li>`).join('');
  const done = d.status !== 'pending';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft: ${esc(d.title)}</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400..800&display=swap" rel="stylesheet">
<script src="https://byananya.com/assets/marked.min.js"></script>
<style>
:root{--bg:#f7f7f5;--s:#fff;--ink:#121316;--mu:#62656e;--line:#e4e4e0;--acc:#9a6b1f}
@media(prefers-color-scheme:dark){:root{--bg:#0c0d10;--s:#15171c;--ink:#f2f2ef;--mu:#9a9ca6;--line:#262931;--acc:#d9b26a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.75 "Plus Jakarta Sans",system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1.25rem 9rem}.tag{font-size:.8rem;font-weight:800;color:var(--acc)}
h1{font-size:clamp(1.9rem,6vw,2.8rem);line-height:1.08;letter-spacing:-.04em;margin:.4rem 0 .6rem}.sum{color:var(--mu);margin:0 0 1.5rem}
.note{padding:.8rem 1rem;border-radius:14px;background:var(--s);border:1px solid var(--line);margin-bottom:1.25rem;font-weight:600}
article h2{font-size:1.3rem;letter-spacing:-.02em;margin:2rem 0 .3rem}a{color:var(--acc)}.src{font-size:.9rem;color:var(--mu)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--s);border-top:1px solid var(--line);padding:.8rem 1rem calc(.8rem + env(safe-area-inset-bottom,0px))}
.bar form{max-width:44rem;margin:0 auto;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
button{font:inherit;font-weight:700;font-size:.92rem;border-radius:999px;padding:.6rem 1.1rem;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
button.go{background:var(--ink);color:var(--bg);border-color:var(--ink)}textarea{width:100%;font:inherit;font-size:.95rem;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:.6rem .8rem;min-height:3rem}
</style></head><body><main>
<span class="tag">${label(d.type)} · goes live ${prettyDate(d.date)} · ${esc(d.status)}</span>
${msg ? `<p class="note">${esc(msg)}</p>` : ''}
<h1>${esc(d.title)}</h1><p class="sum">${esc(d.summary)}</p>
<article id="post"></article>
${src ? `<h2 style="font-size:1.1rem;margin-top:2rem">Sources it used</h2><ul class="src">${src}</ul>` : ''}
</main>
${done ? '' : `<div class="bar"><form method="post" action="/draft/${d.id}?k=${encodeURIComponent(k)}">
<textarea name="feedback" placeholder="Want changes? Type them here, then tap Rewrite."></textarea>
<button class="go" name="do" value="approve">Approve</button><button name="do" value="revise">Rewrite with my notes</button><button name="do" value="another">Different topic</button><button name="do" value="discard">Discard</button>
</form></div>`}
<script>document.getElementById('post').innerHTML = window.marked ? marked.parse(${JSON.stringify(d.markdown)}) : ${JSON.stringify('<pre>' + esc(d.markdown) + '</pre>')};
document.querySelectorAll('.bar button').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>{document.querySelectorAll('.bar button').forEach(x=>x.disabled=true);b.textContent='Working… (up to a minute)'},10)));</script>
</body></html>`;
}
const html = (s, status) => new Response(s, { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(daily(env)); },

  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return html('<p style="font-family:sans-serif;padding:2rem;max-width:40rem">Something went wrong: ' + esc(e.message) + '</p>', 500); }
  }
};

async function handle(request, env) {
    const url = new URL(request.url), k = url.searchParams.get('k') || '';
    if (url.pathname === '/hit') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      return recordHit(request, env);
    }
    // Setup check: shows which settings exist (never their values)
    if (url.pathname === '/check') {
      const rows = [['BLOG storage connection', !!(env.BLOG && env.BLOG.get)], ['GEMINI_KEY', !!env.GEMINI_KEY], ['GITHUB_TOKEN', !!env.GITHUB_TOKEN],
        ['ADMIN_KEY', !!env.ADMIN_KEY], ['NTFY_TOPIC', !!env.NTFY_TOPIC], ['BASE_URL', !!env.BASE_URL && !String(env.BASE_URL).endsWith('/')], ['GROQ_KEY', !!env.GROQ_KEY], ['TAVILY_KEY', !!env.TAVILY_KEY], ['STATS database (visitor report)', !!env.STATS], ['ANTHROPIC_KEY (optional paid backup)', !!env.ANTHROPIC_KEY]];
      return html('<div style="font-family:sans-serif;padding:2rem;line-height:2"><h2>Blog bot setup check</h2>' + rows.map(r => (r[1] ? '✅ ' : '❌ ') + r[0]).join('<br>') +
        (env.BLOG && env.BLOG.get ? '<p>Claude backup calls this month: ' + ((await env.BLOG.get('claude:' + istToday().slice(0, 7))) || 0) + ' of ' + CLAUDE_MAX_CALLS_PER_MONTH + '</p>' : '') +
        '<p style="color:#666">❌ means missing or misnamed. Names must match exactly, in capitals. BASE_URL must not end with a slash.</p></div>');
    }
    if (!env.ADMIN_KEY || k !== env.ADMIN_KEY) return html('<p style="font-family:sans-serif;padding:2rem">Nothing to see here.</p>', 403);

    // Manual triggers for testing: /run (daily job now) and /test?type=health|tech (one draft now)
    if (url.pathname === '/run') return new Response((await daily(env)).join('\n') || 'Nothing due today.');
    if (url.pathname === '/queue') {
      return html('<div style="font-family:sans-serif;padding:2rem;line-height:1.9;white-space:pre-line;max-width:46rem"><h2>Blog queue</h2>' + esc(queueText(await queue(env))) + '</div>');
    }
    if (url.pathname === '/stats') {
      const day = url.searchParams.get('day') || istToday();
      return html('<div style="font-family:sans-serif;padding:2rem;line-height:1.9;white-space:pre-line"><h2>byananya.com on ' + esc(day) + '</h2>' + esc(statsText(await statsFor(env, day))) + '</div>');
    }
    if (url.pathname === '/test') {
      const type = url.searchParams.get('type') === 'tech' ? 'tech' : 'health';
      const slot = { type, date: addDays(istToday(), 1), id: type + '-test-' + Date.now() };
      const d = await createDraft(env, slot); await sendForApproval(env, d);
      return Response.redirect(draftUrl(env, d.id), 303);
    }

    const m = url.pathname.match(/^\/draft\/([\w-]+)$/);
    if (!m) return html('<p style="font-family:sans-serif;padding:2rem">Not found.</p>', 404);
    let d = await getDraft(env, m[1]);
    if (!d) return html('<p style="font-family:sans-serif;padding:2rem">That draft no longer exists.</p>', 404);

    if (request.method === 'POST') {
      const f = await request.formData(), act = f.get('do'), fb = String(f.get('feedback') || '').trim();
      let msg = '';
      try {
        if (d.status !== 'pending') msg = 'This draft is already ' + d.status + '.';
        else if (act === 'approve') {
          d.status = 'approved'; await saveDraft(env, d);
          if (d.date <= istToday() && !d.id.includes('-test-')) { await publish(env, d); msg = 'Approved and published.'; }
          else msg = d.id.includes('-test-') ? 'Approved. (Test drafts are never published.)' : `Approved. It goes live on ${prettyDate(d.date)}.`;
        } else if (act === 'revise') {
          if (!fb) msg = 'Type what you want changed first.';
          else { const n = await reviseDraft(env, d, fb); d = { ...d, ...n }; await saveDraft(env, d); msg = 'Rewritten with your notes. Have another look.'; }
        } else if (act === 'another') {
          d = await createDraft(env, { type: d.type, date: d.date, id: d.id }, [d.topic || d.title]); msg = 'New topic. Have a look.';
        } else if (act === 'discard') { d.status = 'discarded'; await saveDraft(env, d); msg = 'Discarded. Nothing will be published for this date.'; }
      } catch (e) { msg = 'Something went wrong: ' + e.message + '. Try again in a minute.'; }
      return html(page(d, k, msg));
    }
    return html(page(d, k));
}
