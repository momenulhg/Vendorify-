// Vercel serverless function: sends events to Meta Conversions API (server-side tracking).
// Needed Environment Variables (Vercel > Project > Settings > Environment Variables):
//   META_CAPI_TOKEN        = Conversions API access token (Events Manager > Settings > Conversions API > Generate access token)
//   META_PIXEL_ID          = 1111531977915844   (optional, this is the default)
//   META_TEST_EVENT_CODE   = TEST12345          (optional, only while testing, remove later)
const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '1111531977915844';
const ALLOWED_EVENTS = ['Purchase', 'InitiateCheckout', 'ViewContent', 'AddToCart'];

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Basic spam protection: only accept calls coming from our own site.
  const origin = req.headers.origin || req.headers.referer || '';
  try {
    if (origin && new URL(origin).host !== req.headers.host) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
  } catch (e) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'META_CAPI_TOKEN is not set' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  if (!ALLOWED_EVENTS.includes(b.event_name) || !b.event_id) {
    return res.status(400).json({ ok: false, error: 'Bad event' });
  }

  // Customer data: hashed here on the server (Meta requires SHA-256, lowercase, trimmed).
  const user = {
    client_user_agent: req.headers['user-agent'] || undefined,
    client_ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
    country: [sha256('bd')]
  };
  if (b.fbp) user.fbp = String(b.fbp);
  if (b.fbc) user.fbc = String(b.fbc);
  if (b.phone) {
    const ph = String(b.phone).replace(/\D/g, '').replace(/^0/, '880');
    if (ph) user.ph = [sha256(ph)];
  }
  if (b.name) {
    const parts = String(b.name).trim().split(/\s+/);
    if (parts[0]) user.fn = [sha256(parts[0])];
    if (parts.length > 1) user.ln = [sha256(parts.slice(1).join(' '))];
  }

  const custom = {};
  if (b.value != null) custom.value = Number(b.value) || 0;
  custom.currency = b.currency || 'BDT';
  if (Array.isArray(b.content_ids)) { custom.content_ids = b.content_ids.map(String); custom.content_type = 'product'; }
  if (b.num_items != null) custom.num_items = Number(b.num_items) || 1;

  const payload = {
    data: [{
      event_name: b.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: String(b.event_id),          // same as the browser pixel eventID = Meta removes the duplicate
      action_source: 'website',
      event_source_url: b.event_source_url || origin || undefined,
      user_data: user,
      custom_data: custom
    }]
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, error: (out.error && out.error.message) || 'Meta error' });
    return res.status(200).json({ ok: true, events_received: out.events_received });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Network error' });
  }
};
