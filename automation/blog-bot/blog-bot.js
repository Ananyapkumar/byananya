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
//   Secrets     GEMINI_KEY, GITHUB_TOKEN, ADMIN_KEY, NTFY_TOPIC, GROQ_KEY (free backup), optionally ANTHROPIC_KEY (paid, capped last resort)
//   Cron        30 3 * * *    (09:00 India time)

const REPO = 'Ananyapkumar/byananya';
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const IST = 5.5 * 3600 * 1000;
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
  const models = search ? ['groq/compound', 'groq/compound-mini'] : ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'];
  let last = '';
  for (const model of models) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY },
      body: JSON.stringify({ model, temperature: 0.7, max_tokens: 3000, messages: [{ role: 'user', content: prompt +
        (search ? '\nAlso add a "sources" field to the JSON: a list of {"title": "...", "url": "..."} for the pages you actually used.' : '') }] })
    });
    if (!r.ok) { last = model + ' ' + r.status + ': ' + (await r.text()).slice(0, 200); continue; }
    const d = await r.json(), msg = (d.choices || [])[0]?.message || {};
    const m = String(msg.content || '').match(/\{[\s\S]*\}/);
    if (!m) { last = model + ': no JSON in reply'; continue; }
    const post = JSON.parse(m[0]);
    if (!post.title || !post.markdown) { last = model + ': missing title or text'; continue; }
    // prefer the search results Groq actually ran; fall back to the sources it listed
    const found = [];
    for (const t of (msg.executed_tools || [])) for (const res of (t.search_results?.results || [])) if (res.url) found.push({ uri: res.url, title: res.title || res.url });
    for (const s2 of (Array.isArray(post.sources) ? post.sources : [])) if (s2 && s2.url) found.push({ uri: s2.url, title: s2.title || s2.url });
    const seen = new Set(), sources = found.filter(x => !seen.has(x.uri) && seen.add(x.uri)).slice(0, 6);
    delete post.sources;
    return { ...post, sources };
  }
  throw new Error('Groq failed: ' + last);
}

async function writeDraft(env, slot, avoid) {
  const prompt = brief(slot.type, avoid) + '\n\n' + VOICE + '\n\n' + FORMAT;
  const errors = [];
  try { return await writeDraftGemini(env, slot, avoid); } catch (e) { errors.push('Gemini: ' + e.message.slice(0, 120)); }
  if (env.GROQ_KEY) { try { return await groqWrite(env, prompt, true); } catch (e) { errors.push(e.message.slice(0, 160)); } }
  if (await claudeBudgetOk(env)) return claude(env, prompt, true);
  throw new Error(errors.join(' | ') + (env.ANTHROPIC_KEY ? ' | Claude backup has hit its monthly cap.' : ''));
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
  let p;
  try {
    p = parsePost(await gemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }));
  } catch (e) {
    if (env.GROQ_KEY) { try { p = await groqWrite(env, prompt, false); } catch (e2) {} }
    if (!p) { if (!(await claudeBudgetOk(env))) throw e; p = await claude(env, prompt, false); }
  }
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
    // Setup check: shows which settings exist (never their values)
    if (url.pathname === '/check') {
      const rows = [['BLOG storage connection', !!(env.BLOG && env.BLOG.get)], ['GEMINI_KEY', !!env.GEMINI_KEY], ['GITHUB_TOKEN', !!env.GITHUB_TOKEN],
        ['ADMIN_KEY', !!env.ADMIN_KEY], ['NTFY_TOPIC', !!env.NTFY_TOPIC], ['BASE_URL', !!env.BASE_URL && !String(env.BASE_URL).endsWith('/')], ['GROQ_KEY (free backup)', !!env.GROQ_KEY], ['ANTHROPIC_KEY (optional paid backup)', !!env.ANTHROPIC_KEY]];
      return html('<div style="font-family:sans-serif;padding:2rem;line-height:2"><h2>Blog bot setup check</h2>' + rows.map(r => (r[1] ? '✅ ' : '❌ ') + r[0]).join('<br>') +
        (env.BLOG && env.BLOG.get ? '<p>Claude backup calls this month: ' + ((await env.BLOG.get('claude:' + istToday().slice(0, 7))) || 0) + ' of ' + CLAUDE_MAX_CALLS_PER_MONTH + '</p>' : '') +
        '<p style="color:#666">❌ means missing or misnamed. Names must match exactly, in capitals. BASE_URL must not end with a slash.</p></div>');
    }
    if (!env.ADMIN_KEY || k !== env.ADMIN_KEY) return html('<p style="font-family:sans-serif;padding:2rem">Nothing to see here.</p>', 403);

    // Manual triggers for testing: /run (daily job now) and /test?type=health|tech (one draft now)
    if (url.pathname === '/run') return new Response((await daily(env)).join('\n') || 'Nothing due today.');
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
