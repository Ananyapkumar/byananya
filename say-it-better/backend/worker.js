// Say it better: backend for byananya.com/say-it-better
// Runs free on Cloudflare Workers. Needs one secret: GEMINI_KEY.

const ALLOWED = ['https://byananya.com', 'https://www.byananya.com'];
const MODEL = 'gemini-3.5-flash-lite';
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

    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(text, who, want, mode) }] }],
        generationConfig: { temperature: 0.9, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } }
      })
    });
    if (r.status === 429) return reply({ ok: false, error: 'busy' }, 429, origin);
    if (!r.ok) return reply({ ok: false, error: 'failed' }, 502, origin);

    try {
      const d = await r.json();
      const raw = (((d.candidates || [])[0] || {}).content || {}).parts.map(p => p.text || '').join('');
      const out = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (!out.polite) throw new Error('empty');
      return reply({ ok: true, polite: out.polite, firm: out.firm, funny: out.funny, british: out.british || '' }, 200, origin);
    } catch (e) {
      return reply({ ok: false, error: 'failed' }, 502, origin);
    }
  }
};
