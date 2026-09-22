/* Customer status page — reads the private link, shows payment, each
   recipient's order and tracking, and refreshes itself until everything ships. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const money = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HEAD = {
  awaiting_payment: ['Waiting for payment', 'Your gifts are ready to go. As soon as the invoice is paid, every recipient’s order is created and shipped separately.'],
  paid:             ['Paid — preparing your orders', 'Payment received. We’re creating each recipient’s order now; this page updates on its own.'],
  releasing:        ['Paid — preparing your orders', 'Payment received. We’re creating each recipient’s order now; this page updates on its own.'],
  partial:          ['Almost there', 'Most orders are created. Our team is finishing the rest — no action needed from you.'],
  released:         ['Your gifts are on their way', 'Every recipient has their own order. Tracking appears below as each one ships.'],
  cancelled:        ['This order was cancelled', 'Please contact us if that’s unexpected.'],
  failed:           ['We hit a problem', 'Our team has been notified. Please contact us and quote the order number above.']
};

const DELIVERY = { UNFULFILLED: 'Preparing', IN_PROGRESS: 'Preparing', PARTIALLY_FULFILLED: 'Partly shipped',
  FULFILLED: 'Shipped', CANCELLED: 'Cancelled', ON_HOLD: 'On hold', SCHEDULED: 'Scheduled' };


/* Questions? — a mailto alone is unreliable (a browser with no mail app
   does nothing at all on click), so show the address with a copy button. */
function wireContact(cfg) {
  const email = cfg.publicSite.supportEmail;
  const phone = cfg.publicSite.supportPhone;
  const subject = encodeURIComponent('Corporate gift order');
  document.getElementById('contactMail').textContent = email;
  document.getElementById('contactMail').href = `mailto:${email}?subject=${subject}`;
  if (phone) {
    document.getElementById('contactPhoneRow').hidden = false;
    document.getElementById('contactPhone').textContent = phone;
    document.getElementById('contactPhone').href = `tel:${phone.replace(/[^\d+]/g, '')}`;
  }
  const open = (e) => { e.preventDefault(); document.getElementById('contact').showModal(); };
  ['helpLink', 'footHelp'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', open);
  });
  document.getElementById('contactClose').addEventListener('click', () => document.getElementById('contact').close());
  document.getElementById('copyMail').addEventListener('click', async () => {
    const btn = document.getElementById('copyMail');
    try { await navigator.clipboard.writeText(email); btn.textContent = 'Copied'; }
    catch { btn.textContent = 'Select and copy'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

async function load() {
  try {
    const cfg = await (await fetch('/config/shipping-rules.json')).json();
    wireContact(cfg);
    if (cfg.publicSite.homeUrl) $('homeLink').href = cfg.publicSite.homeUrl;
  } catch { /* non-essential */ }

  const res = await fetch(`/.netlify/functions/order-status?b=${encodeURIComponent(params.get('b') || '')}&t=${encodeURIComponent(params.get('t') || '')}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('loading').textContent = data.message || 'We couldn’t load this order.'; return; }
  render(data.batch);
}

function render(b) {
  $('loading').hidden = true;
  $('view').hidden = false;
  const [head, text] = HEAD[b.status] || [b.status, ''];
  $('sId').textContent = `Order ${b.id}${b.orderName ? ` · ${b.orderName}` : ''}`;
  $('sHead').textContent = head;
  $('sText').textContent = text;
  $('payWrap').hidden = !b.invoiceUrl;
  if (b.invoiceUrl) { $('payLink').href = b.invoiceUrl; $('payLink').textContent = `Pay ${money(b.totals.total)} now`; }

  const shipped = b.recipients.filter((r) => r.fulfillment === 'FULFILLED').length;
  $('sSummary').innerHTML =
    `<div><b>${b.recipients.length}</b><span>recipients</span></div>` +
    `<div><b>${b.recipients.filter((r) => r.order).length}</b><span>orders created</span></div>` +
    `<div><b>${shipped}</b><span>shipped</span></div>` +
    `<div><b>${money(b.totals.total)}</b><span>total${b.discountPct ? ` (${b.discountPct}% off)` : ''}</span></div>`;

  $('sRows').innerHTML = b.recipients.map((r) => {
    const track = r.tracking.length
      ? r.tracking.map((t) => t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.company || 'Track')} ${esc(t.number)}</a>` : esc(`${t.company || ''} ${t.number}`)).join('<br>')
      : esc(DELIVERY[r.fulfillment] || (r.order ? 'Preparing' : '—'));
    return `<tr><td>${esc(r.name)}${r.company ? `<br><small class="muted">${esc(r.company)}</small>` : ''}</td>
      <td>${esc(r.city)}, ${esc(r.state)}</td>
      <td>${r.gifts.map((g) => `${g.qty > 1 ? g.qty + '× ' : ''}${esc(g.title)}`).join('<br>')}</td>
      <td class="mono">${esc(r.order || '—')}</td><td>${track}</td></tr>`;
  }).join('');

  $('sUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}.`;
  const allShipped = b.status === 'released' && shipped === b.recipients.length;
  if (!allShipped && !['cancelled', 'failed'].includes(b.status)) {
    setTimeout(load, b.status === 'paid' || b.status === 'releasing' ? 5000 : 60000);
  }
}

load();
