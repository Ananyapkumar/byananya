// Say it better: backend for byananya.com/say-it-better
// Runs free on Cloudflare Workers. Secrets: GROQ_KEY (main, very fast) and GEMINI_KEY (backup). Either one alone also works.

const ALLOWED = ['https://byananya.com', 'https://www.byananya.com'];
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];
const WHO = ['Landlord', 'Client', 'Boss', 'Friend', 'Family', 'Crush', 'Partner', 'Ex', 'Distant relative', 'Someone new'];
const WANT = ['Say no', 'Get paid', 'Buy time', 'Set a boundary', 'Keep it friendly', 'Push back', 'Flirt back', 'Keep my distance'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
}

function buildPrompt(text, who, want, mode) {
  const whoLine = who ? (mode === 'reply' ? 'It is from my ' : 'I am saying this to my ') + who.toLowerCase() + '.\n' : '';
  const wantLine = want ? 'What I want: ' + want.toLowerCase() + '.\n' : '';
  const task = mode === 'reply'
    ? 'Someone sent me this message:\n"""' + text + '"""\n' + whoLine + wantLine + 'Write four replies I could send back to them.'
    : 'This is what I want to say, in my own rough words:\n"""' + text + '"""\n' + whoLine + wantLine +
      'Rewrite it into four versions I could actually send. Keep my meaning and point of view: I am the one saying this. Do not reply to me, comfort me, or ask me questions.';
  return task + '\nRules: write as me, like a real person texting; each under 45 words; never robotic or corporate; never ask me what happened; no "I hope this message finds you well".\n' +
    'Only use facts that are in the message. Never invent excuses, reasons or details I did not give (for example "my phone was on silent", "I was asleep", "I was busy with work"). If an excuse would help, leave it out rather than make one up.\n' +
    'polite = kind and gracious; firm = clear and confident, not rude; funny = light and witty, never mean, at most one emoji; ' +
    'british = peak polite British office energy like those viral reels: understated, terribly courteous, gently passive-aggressive ("I\'m terribly sorry, but...", "just circling back", "not to be a bother", "as per my previous message"), funny but never offensive. ' +
    'For a crush or partner, playful and sweet is fine but keep it tasteful. Use the language of the original. Return only JSON: {"polite": "...", "firm": "...", "funny": "...", "british": "..."}';
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return reply({ ok: false, error: 'method' }, 405, origin);
    if (!ALLOWED.includes(origin)) return reply({ ok: false, error: 'origin' }, 403, origin);

    let b = {};
    try { b = JSON.parse(await request.text()); } catch (e) { return reply({ ok: false, error: 'bad request' }, 400, origin); }
    const text = String(b.message || '').trim().slice(0, 1500);
    if (!text) return reply({ ok: false, error: 'empty' }, 400, origin);
    const who = WHO.includes(b.who) ? b.who : '';
    const want = WANT.includes(b.want) ? b.want : '';
    const mode = b.mode === 'reply' ? 'reply' : 'rephrase';

    const prompt = buildPrompt(text, who, want, mode);
    let busy = false;
    const clean = o => ({ ok: true, polite: o.polite, firm: o.firm, funny: o.funny, british: o.british || '' });
    const parse = t => { const o = JSON.parse(String(t).replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)[0]); if (!o.polite) throw new Error('empty'); return o; };

    // 1. Groq (fast)
    if (env.GROQ_KEY) for (const model of GROQ_MODELS) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY },
          body: JSON.stringify({ model, temperature: 0.9, max_tokens: 700, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
        });
        if (r.status === 429) { busy = true; continue; }
        if (!r.ok) continue;
        const d = await r.json();
        return reply(clean(parse(d.choices[0].message.content)), 200, origin);
      } catch (e) { /* try the next option */ }
    }
    // 2. Gemini (backup)
    if (env.GEMINI_KEY) for (const model of GEMINI_MODELS) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.9, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } } })
        });
        if (r.status === 429) { busy = true; continue; }
        if (!r.ok) continue;
        const d = await r.json();
        return reply(clean(parse((((d.candidates || [])[0] || {}).content || {}).parts.map(p => p.text || '').join(''))), 200, origin);
      } catch (e) { /* try the next option */ }
    }
    return reply({ ok: false, error: busy ? 'busy' : 'failed' }, busy ? 429 : 502, origin);
  }
};
