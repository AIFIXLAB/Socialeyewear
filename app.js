(() => {
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('seo_' + k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem('seo_' + k, JSON.stringify(v)) };
const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
const baht = n => '฿' + Number(n || 0).toLocaleString('th-TH');
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2800); };
const errText = e => { const m = e?.message || String(e); try { return JSON.parse(m).message || m; } catch { return m; } };

/* ---------- โครงสร้างข้อมูล (ตรงกับ supabase/schema.sql) ---------- */
const COLS = {
  customer_profiles: ['id', 'shop_id', 'customer_code', 'full_name', 'phone', 'budget_thb', 'lifestyle', 'notes', 'consent_recorded_at', 'deleted_at', 'created_at'],
  prescriptions: ['id', 'shop_id', 'customer_id', 'exam_date', 'od_sph', 'od_cyl', 'od_axis', 'os_sph', 'os_cyl', 'os_axis', 'pd', 'add_power', 'notes', 'deleted_at', 'created_at'],
  products: ['id', 'shop_id', 'product_type', 'sku', 'brand', 'product_name', 'description', 'features', 'retail_price_thb', 'cost_thb', 'stock_qty', 'active', 'deleted_at', 'created_at'],
  quotes: ['id', 'shop_id', 'customer_id', 'quote_number', 'status', 'subtotal_thb', 'discount_thb', 'total_thb', 'notes', 'valid_until', 'deleted_at', 'created_at'],
  quote_items: ['id', 'shop_id', 'quote_id', 'product_id', 'item_name_snapshot', 'product_type', 'quantity', 'unit_price_thb', 'line_total_thb', 'deleted_at', 'created_at']
};
const T = Object.keys(COLS);
const db = {}; T.forEach(t => db[t] = ls.get('db_' + t, []));
const persist = () => T.forEach(t => ls.set('db_' + t, db[t]));
const live = t => db[t].filter(r => !r.deleted_at);
const find = (t, id) => db[t].find(r => r.id === id);
let shop = ls.get('shop', null), sess = ls.get('sess', null), syncing = false, status = '';

function save(t, rec) {
  if (!rec.created_at) rec.created_at = now();
  if (!rec.shop_id && shop) rec.shop_id = shop.id;
  rec.updated_at = now(); rec._dirty = true; delete rec._err;
  const i = db[t].findIndex(r => r.id === rec.id); i < 0 ? db[t].unshift(rec) : db[t][i] = rec;
}
const commit = () => { persist(); render(); sync(); };
const softDelete = (t, id) => { const r = find(t, id); if (r) { save(t, { ...r, deleted_at: now() }); commit(); } };
const mgr = () => !shop || ['owner', 'manager'].includes(shop.role);

/* ---------- Supabase REST (ไม่พึ่งไลบรารีภายนอก เพื่อให้แคชออฟไลน์ได้) ---------- */
const cfg = () => ({ url: (ls.get('url', '') || window.APP_CONFIG?.supabaseUrl || '').replace(/\/$/, ''), key: ls.get('key', '') || window.APP_CONFIG?.supabaseKey || '' });
async function auth(kind, email, password) {
  const c = cfg();
  const r = await fetch(c.url + (kind === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password'), { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || 'เข้าสู่ระบบไม่สำเร็จ');
  if (!j.access_token) throw new Error('สมัครแล้ว กรุณายืนยันอีเมล แล้วกลับมาเข้าสู่ระบบอีกครั้ง');
  sess = { ...j, email }; ls.set('sess', sess);
}
async function refresh() {
  const c = cfg();
  const r = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sess.refresh_token }) });
  if (!r.ok) { sess = null; ls.set('sess', null); throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'); }
  sess = { ...sess, ...(await r.json()) }; ls.set('sess', sess);
}
async function api(path, o = {}, retry = true) {
  const c = cfg();
  const r = await fetch(c.url + path, { ...o, headers: { apikey: c.key, 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.access_token, ...o.headers } });
  if (r.status === 401 && retry) { await refresh(); return api(path, o, false); }
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function loadShop() {
  const rows = await api(`/rest/v1/shop_members?select=shop_id,role,shops(name)&user_id=eq.${sess.user.id}`);
  if (!rows?.length) { shop = null; ls.set('shop', null); return false; }
  const m = rows.find(r => r.shop_id === shop?.id) || rows[0], next = { id: m.shop_id, name: m.shops?.name || '', role: m.role };
  if (shop && shop.id !== next.id) { T.forEach(t => db[t] = db[t].filter(r => !r.shop_id || r.shop_id === next.id)); ls.set('pull', {}); }
  shop = next; ls.set('shop', shop); return true;
}
const pendingCount = () => T.reduce((n, t) => n + db[t].filter(r => r._dirty && !r._err).length, 0);
const errCount = () => T.reduce((n, t) => n + db[t].filter(r => r._err).length, 0);
function setStatus() {
  const el = $('#sync'); if (!el) return; const c = cfg();
  const s = !navigator.onLine ? ['off', 'ออฟไลน์ · บันทึกในเครื่อง'] : !sess ? ['off', 'ยังไม่ได้ล็อกอิน · บันทึกในเครื่อง'] : !c.url || !c.key ? ['off', 'ยังไม่ตั้งค่า Supabase'] : !shop ? ['off', 'ยังไม่มีร้าน'] : ['ok', status || 'เชื่อมต่อแล้ว'];
  const p = pendingCount(), e = errCount();
  el.className = 'sync ' + s[0]; el.innerHTML = `<i></i><span>${esc(s[1])}${p ? ` · รอซิงก์ ${p}` : ''}${e ? ` · ผิดพลาด ${e}` : ''}</span>`;
}
// ดึงข้อมูลใหม่จากเซิร์ฟเวอร์ก่อน (แก้ล่าสุดชนะ) แล้วจึงส่งรายการที่แก้ในเครื่องขึ้นไป
async function sync() {
  const c = cfg();
  if (syncing || !navigator.onLine || !sess || !c.url || !c.key) return setStatus();
  syncing = true; status = 'กำลังซิงก์…'; setStatus();
  try {
    if (!(await loadShop())) { status = ''; syncing = false; setStatus(); if (!$('#dlg').open) render(); return; }
    const pull = ls.get('pull', {});
    for (const t of T) {
      let since = pull[t] ? new Date(Date.parse(pull[t]) - 10000).toISOString() : '1970-01-01T00:00:00Z';
      for (;;) {
        const rows = await api(`/rest/v1/${t}?updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc&limit=1000`) || [];
        for (const row of rows) {
          const i = db[t].findIndex(r => r.id === row.id), l = db[t][i];
          if (!(l && l._dirty && !l._err && l.updated_at > row.updated_at)) i < 0 ? db[t].push(row) : db[t][i] = row;
          if (row.updated_at > (pull[t] || '')) pull[t] = row.updated_at;
        }
        if (rows.length < 1000) break; since = rows[rows.length - 1].updated_at;
      }
      const dirty = db[t].filter(r => r._dirty && !r._err);
      const body = r => { const o = {}; COLS[t].forEach(k => o[k] = r[k] === undefined ? null : r[k]); o.shop_id = o.shop_id || shop.id; return o; };
      const post = rows => api(`/rest/v1/${t}?on_conflict=id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.map(body)) });
      const ok = r => { delete r._dirty; r.shop_id = r.shop_id || shop.id; };
      if (dirty.length) {
        try { await post(dirty); dirty.forEach(ok); }
        catch { for (const r of dirty) { try { await post([r]); ok(r); } catch (e) { r._err = errText(e); } } }
      }
    }
    ls.set('pull', pull); persist();
    status = errCount() ? 'บางรายการซิงก์ไม่สำเร็จ' : 'ซิงก์แล้ว ' + new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { status = 'ซิงก์ไม่สำเร็จ จะลองใหม่อัตโนมัติ'; console.error(e); }
  syncing = false; setStatus(); if (!$('#dlg').open) render();
}
async function loadStaff() {
  if (!sess || !shop) return;
  try { S.staff = await api('/rest/v1/rpc/shop_staff', { method: 'POST', body: JSON.stringify({ p_shop: shop.id }) }); if (S.v === 'settings' && !$('#dlg').open) render(); } catch (e) { console.error(e); }
}

/* ---------- ตัวช่วยแสดงผล ---------- */
const NEEDS = { general: 'ใช้งานทั่วไป', screen: 'ทำงานหน้าจอ', drive: 'ขับรถ/กลางคืน', outdoor: 'กลางแจ้ง', progressive: 'สายตายาว/โปรเกรสซีฟ' };
const TYPES = { lens: 'เลนส์', frame: 'กรอบ', service: 'บริการ', other: 'อื่น ๆ' };
const QST = { draft: 'ร่าง', presented: 'เสนอแล้ว', accepted: 'ลูกค้าตกลง', declined: 'ลูกค้าปฏิเสธ', expired: 'หมดอายุ', converted: 'ออกขายแล้ว' };
const NAV = [['studio', 'Sales Studio'], ['customers', 'ลูกค้า'], ['products', 'สินค้า'], ['quotes', 'ใบเสนอราคา'], ['insights', 'ภาพรวม'], ['settings', 'ตั้งค่า']];
const S = { v: 'studio', need: 'general', cart: [], cust: '', disc: 0, notes: '', q: '', pq: '', ptype: 'all', staff: null };
const empty = (m, a = '') => `<div class="empty">${m}${a ? `<br><br>${a}` : ''}</div>`;
const fmtP = v => v == null || v === '' ? '-' : (+v > 0 ? '+' : '') + (+v).toFixed(2);
const day = d => d ? new Date(d).toLocaleDateString('th-TH') : '-';
const cartSub = () => S.cart.reduce((n, i) => n + i.price * i.qty, 0);
const latestRx = cid => db.prescriptions.filter(r => !r.deleted_at && r.customer_id === cid).sort((a, b) => (b.exam_date || b.created_at).localeCompare(a.exam_date || a.created_at))[0];
const rxText = r => r ? `ขวา ${fmtP(r.od_sph)}${r.od_cyl != null ? '/' + fmtP(r.od_cyl) + '×' + (r.od_axis ?? '-') : ''} · ซ้าย ${fmtP(r.os_sph)}${r.os_cyl != null ? '/' + fmtP(r.os_cyl) + '×' + (r.os_axis ?? '-') : ''}` : 'ยังไม่มีค่าสายตา';
const custName = id => find('customer_profiles', id)?.full_name || 'ลูกค้าทั่วไป';
const csv = rows => '\ufeff' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
const download = (name, text, type = 'text/csv') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

const views = {
  studio() {
    const ps = live('products').filter(p => p.active !== false), tag = p => (p.features || []).includes(S.need);
    const card = p => `<div class="card ${tag(p) ? 'rec' : ''}"><h3>${esc(p.product_name)}</h3><span class="tag">${esc(tag(p) ? 'เหมาะกับ' + NEEDS[S.need] : [p.brand, p.description].filter(Boolean).join(' · ') || TYPES[p.product_type])}</span><span class="price">${baht(p.retail_price_thb)}</span><button class="btn sm" data-act="add" data-id="${p.id}">เพิ่มในชุดแว่น</button></div>`;
    const grp = (types, title) => { const l = ps.filter(p => types.includes(p.product_type)).sort((a, b) => tag(b) - tag(a)); return `<h2 class="gap">${title}</h2><div class="cards">${l.map(card).join('') || empty('ยังไม่มี' + title)}</div>`; };
    const sub = cartSub(), disc = Math.min(S.disc, sub), total = sub - disc, c = find('customer_profiles', S.cust);
    return `<h1>Sales Studio</h1><p class="sub">เลือกลักษณะการใช้งานของลูกค้า แล้วประกอบเลนส์ กรอบ และบริการเป็นชุดเดียว</p>
    <div class="grid studio"><div>
      <div class="chips">${Object.entries(NEEDS).map(([k, l]) => `<button class="chip ${S.need === k ? 'on' : ''}" data-act="need" data-id="${k}">${l}</button>`).join('')}</div>
      ${grp(['lens'], 'เลนส์')}${grp(['frame'], 'กรอบแว่น')}${grp(['service', 'other'], 'บริการและอื่น ๆ')}
    </div>
    <aside class="panel"><h2>ชุดแว่นของลูกค้า</h2>
      <label>ลูกค้า<select data-bind="cust"><option value="">ลูกค้าทั่วไป</option>${live('customer_profiles').map(x => `<option value="${x.id}" ${S.cust === x.id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select></label>
      <button class="btn line sm" data-act="newcust" data-from="studio">เพิ่มลูกค้าใหม่</button>
      ${c ? `<p class="tag" style="margin-top:10px">${esc(rxText(latestRx(c.id)))}${c.budget_thb ? `<br>งบประมาณ ${baht(c.budget_thb)}` : ''}${c.lifestyle ? `<br>ไลฟ์สไตล์: ${esc(c.lifestyle)}` : ''}</p>` : ''}
      <div style="margin-top:12px">${S.cart.map(i => `<div class="row"><span>${esc(i.name)}<br><span class="tag">${baht(i.price)} × ${i.qty}</span></span><span class="qty"><button class="btn line sm" data-act="qty" data-id="${i.id}" data-d="-1" aria-label="ลด">−</button><b>${i.qty}</b><button class="btn line sm" data-act="qty" data-id="${i.id}" data-d="1" aria-label="เพิ่ม">+</button></span></div>`).join('') || '<p class="tag">ยังไม่ได้เลือกสินค้า</p>'}</div>
      <label style="margin-top:12px">ส่วนลด (บาท)<input type="number" min="0" value="${S.disc}" data-bind="disc"></label>
      <label>หมายเหตุในใบเสนอราคา<textarea rows="2" data-bind="notes">${esc(S.notes)}</textarea></label>
      <div class="row" style="border:0"><span>รวมสุทธิ</span><span class="total">${baht(total)}</span></div>
      ${c?.budget_thb && total > c.budget_thb ? `<p class="warn">เกินงบลูกค้า ${baht(total - c.budget_thb)}</p>` : ''}
      <button class="btn gold" style="display:block" data-act="mkquote">สร้างใบเสนอราคา</button></aside></div>`;
  },
  customers() {
    const q = S.q.toLowerCase(), rows = live('customer_profiles').filter(c => [c.full_name, c.phone, c.customer_code].join(' ').toLowerCase().includes(q));
    return `<div class="bar"><div><h1>ลูกค้า</h1><p class="sub" style="margin:0">โปรไฟล์ ความยินยอม และประวัติค่าสายตา</p></div><div class="tools"><input placeholder="ค้นหาชื่อ เบอร์ หรือรหัส" value="${esc(S.q)}" data-bind="q" style="width:220px"><button class="btn line" data-act="csvcust">ส่งออก CSV</button><button class="btn" data-act="newcust">เพิ่มลูกค้า</button></div></div>
    ${rows.length ? `<div class="panel wrap"><table><tr><th>รหัส</th><th>ชื่อ</th><th>โทรศัพท์</th><th>ค่าสายตาล่าสุด</th><th>ยินยอม</th><th></th></tr>${rows.map(c => `<tr><td>${esc(c.customer_code || '-')}</td><td>${esc(c.full_name)}</td><td>${esc(c.phone || '')}</td><td class="tag">${esc(rxText(latestRx(c.id)))}</td><td>${c.consent_recorded_at ? '<span class="st accepted">บันทึกแล้ว</span>' : '<span class="st">ยังไม่มี</span>'}</td><td class="act"><button class="btn line sm" data-act="viewcust" data-id="${c.id}">เปิด</button>${mgr() ? ` <button class="btn line sm bad" data-act="delcust" data-id="${c.id}">ลบ</button>` : ''}</td></tr>`).join('')}</table></div>` : empty('ยังไม่มีลูกค้าที่ตรงกับการค้นหา', '<button class="btn" data-act="newcust">เพิ่มลูกค้าคนแรก</button>')}`;
  },
  products() {
    const q = S.pq.toLowerCase(), rows = live('products').filter(p => (S.ptype === 'all' || p.product_type === S.ptype) && [p.product_name, p.sku, p.brand].join(' ').toLowerCase().includes(q));
    const chips = [['all', 'ทั้งหมด'], ...Object.entries(TYPES)].map(([k, l]) => `<button class="chip ${S.ptype === k ? 'on' : ''}" data-act="ptype" data-id="${k}">${l}</button>`).join('');
    return `<div class="bar"><div><h1>สินค้า</h1><p class="sub" style="margin:0">ราคา สต็อก และแท็กการใช้งานสำหรับ Sales Studio</p></div><div class="tools"><input placeholder="ค้นหาชื่อ SKU แบรนด์" value="${esc(S.pq)}" data-bind="pq" style="width:220px"><button class="btn" data-act="newprod">เพิ่มสินค้า</button></div></div>
    <div class="chips">${chips}</div>
    ${rows.length ? `<div class="panel wrap"><table><tr><th>สินค้า</th><th>ประเภท</th><th>ราคา</th>${mgr() ? '<th>ต้นทุน</th>' : ''}<th>สต็อก</th><th>สถานะ</th><th></th></tr>${rows.map(p => `<tr><td>${esc(p.product_name)}<br><span class="tag">${esc([p.sku, p.brand].filter(Boolean).join(' · '))}</span></td><td>${TYPES[p.product_type]}</td><td>${baht(p.retail_price_thb)}</td>${mgr() ? `<td>${p.cost_thb != null ? baht(p.cost_thb) : '-'}</td>` : ''}<td>${p.stock_qty == null ? '-' : `<span class="${p.stock_qty <= 2 ? 'warn' : ''}">${p.stock_qty}</span>`}</td><td>${p.active === false ? '<span class="st">ปิดขาย</span>' : '<span class="st accepted">ขายอยู่</span>'}</td><td class="act"><button class="btn line sm" data-act="editprod" data-id="${p.id}">แก้ไข</button>${mgr() ? ` <button class="btn line sm bad" data-act="delprod" data-id="${p.id}">ลบ</button>` : ''}</td></tr>`).join('')}</table></div>`
      : empty('ยังไม่มีสินค้า', `<button class="btn" data-act="newprod">เพิ่มสินค้า</button> ${live('products').length ? '' : '<button class="btn line" data-act="sample">เพิ่มสินค้าตัวอย่าง 8 รายการ</button>'}`)}`;
  },
  quotes() {
    const rows = live('quotes').sort((a, b) => b.created_at.localeCompare(a.created_at));
    return `<div class="bar"><div><h1>ใบเสนอราคา</h1><p class="sub" style="margin:0">เปลี่ยนสถานะได้ทันที พิมพ์หรือบันทึกเป็น PDF ได้</p></div><button class="btn line" data-act="csvq">ส่งออก CSV</button></div>
    ${rows.length ? `<div class="panel wrap"><table><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ยอดสุทธิ</th><th>สถานะ</th><th></th></tr>${rows.map(q => `<tr><td>${esc(q.quote_number || 'รอออกเลข')}</td><td>${day(q.created_at)}</td><td>${esc(custName(q.customer_id))}</td><td>${baht(q.total_thb)}</td><td><select class="st-sel ${q.status}" data-bind="qstatus" data-id="${q.id}">${Object.entries(QST).map(([k, l]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td class="act"><button class="btn line sm" data-act="viewq" data-id="${q.id}">เปิด/พิมพ์</button> <button class="btn line sm bad" data-act="delq" data-id="${q.id}">ลบ</button></td></tr>`).join('')}</table></div>` : empty('ยังไม่มีใบเสนอราคา ไปที่ Sales Studio เพื่อสร้างใบแรก', '<button class="btn" data-act="go" data-id="studio">ไปที่ Sales Studio</button>')}`;
  },
  insights() {
    const q = live('quotes'), won = q.filter(x => ['accepted', 'converted'].includes(x.status)), rev = won.reduce((n, x) => n + x.total_thb, 0);
    const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5 + i); return d.toISOString().slice(0, 7); });
    const mv = months.map(m => won.filter(x => x.created_at.slice(0, 7) === m).reduce((n, x) => n + x.total_thb, 0)), mx = Math.max(...mv, 1);
    const chart = `<svg viewBox="0 0 600 170" role="img" aria-label="ยอดขายรายเดือน" style="width:100%;height:auto">${mv.map((v, i) => `<rect x="${i * 100 + 22}" y="${140 - v / mx * 120}" width="56" height="${v / mx * 120}" rx="8" fill="var(--gold)"/><text x="${i * 100 + 50}" y="160" text-anchor="middle" font-size="12" fill="var(--mute)">${months[i].slice(5)}/${months[i].slice(2, 4)}</text>${v ? `<text x="${i * 100 + 50}" y="${132 - v / mx * 120}" text-anchor="middle" font-size="11" fill="var(--ink)">${Math.round(v / 1000)}k</text>` : ''}`).join('')}</svg>`;
    const cnt = {}; live('quote_items').forEach(i => { const p = find('quotes', i.quote_id); if (p && !p.deleted_at) cnt[i.item_name_snapshot] = (cnt[i.item_name_snapshot] || 0) + i.quantity; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5), max = top[0]?.[1] || 1;
    const low = live('products').filter(p => p.stock_qty != null && p.stock_qty <= 2 && p.active !== false);
    return `<h1>ภาพรวม</h1><p class="sub">สรุปจากข้อมูลที่อยู่ในเครื่องนี้</p>
    <div class="grid stats"><div class="panel stat"><span class="tag">ยอดที่ลูกค้าตกลง</span><b>${baht(rev)}</b></div><div class="panel stat"><span class="tag">ใบเสนอราคา</span><b>${q.length}</b></div><div class="panel stat"><span class="tag">อัตราปิดการขาย</span><b>${q.length ? Math.round(won.length / q.length * 100) : 0}%</b></div><div class="panel stat"><span class="tag">ยอดเฉลี่ยต่อใบ</span><b>${baht(won.length ? Math.round(rev / won.length) : 0)}</b></div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:16px">
      <div class="panel"><h2>ยอดขายรายเดือน (6 เดือน)</h2>${chart}</div>
      <div class="panel"><h2>สินค้าที่ถูกเสนอบ่อยที่สุด</h2>${top.map(([n, c]) => `<div style="margin-bottom:12px"><div class="row" style="border:0;padding:0"><span>${esc(n)}</span><span>${c}</span></div><div class="meter"><i style="width:${c / max * 100}%"></i></div></div>`).join('') || '<p class="tag">ยังไม่มีข้อมูล</p>'}
      <h2 style="margin-top:20px">สต็อกใกล้หมด</h2>${low.map(p => `<div class="row"><span>${esc(p.product_name)}</span><span class="warn">เหลือ ${p.stock_qty}</span></div>`).join('') || '<p class="tag">ไม่มีรายการที่ใกล้หมด</p>'}</div></div>`;
  },
  settings() {
    const c = cfg();
    const acct = sess ? `<p>ล็อกอินเป็น <b>${esc(sess.email || sess.user?.email || '')}</b>${shop ? `<br>ร้าน: <b>${esc(shop.name)}</b> <span class="st">${{ owner: 'เจ้าของ', manager: 'ผู้จัดการ', staff: 'พนักงาน' }[shop.role]}</span>` : ''}</p><button class="btn" data-act="syncnow">ซิงก์ตอนนี้</button> <button class="btn line" data-act="logout">ออกจากระบบ</button>`
      : `<form data-form="auth"><label>อีเมล<input type="email" name="email" required autocomplete="username"></label><label>รหัสผ่าน (อย่างน้อย 6 ตัว)<input type="password" name="password" required minlength="6" autocomplete="current-password"></label><button class="btn" type="submit" value="login">เข้าสู่ระบบ</button> <button class="btn line" type="submit" value="signup">สมัครบัญชีใหม่</button></form>`;
    const mkShop = sess && !shop && navigator.onLine ? `<div class="panel"><h2>สร้างร้านของคุณ</h2><p class="tag">ยังไม่มีร้านผูกกับบัญชีนี้ ถ้าเป็นพนักงาน ให้เจ้าของร้านเพิ่มอีเมลของคุณในหน้านี้ก่อน</p><form data-form="shop"><label>ชื่อร้าน<input name="name" required></label><button class="btn" type="submit">สร้างร้าน</button></form></div>` : '';
    const staff = shop?.role === 'owner' ? `<div class="panel"><h2>พนักงานในร้าน</h2>${(S.staff || []).map(m => `<div class="row"><span>${esc(m.email)} <span class="st">${m.role}</span></span>${m.role !== 'owner' ? `<button class="btn line sm bad" data-act="rmstaff" data-id="${m.user_id}">ถอด</button>` : ''}</div>`).join('') || '<p class="tag">กำลังโหลด…</p>'}<form data-form="staff" style="margin-top:14px"><div class="two"><label>อีเมลพนักงาน (ต้องสมัครบัญชีแล้ว)<input type="email" name="email" required></label><label>บทบาท<select name="role"><option value="staff">พนักงาน</option><option value="manager">ผู้จัดการ (ลบข้อมูลและดูต้นทุนได้)</option></select></label></div><button class="btn" type="submit">เพิ่ม/เปลี่ยนบทบาท</button></form></div>` : '';
    return `<h1>ตั้งค่า</h1><p class="sub">เชื่อมต่อ Supabase เพื่อซิงก์ข้อมูลระหว่างเครื่อง</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
    <div class="panel"><h2>บัญชี</h2>${acct}</div>${mkShop}${staff}
    <div class="panel"><h2>การเชื่อมต่อ</h2><label>Project URL<input data-bind="url" value="${esc(c.url)}"></label><label>Publishable key<input data-bind="key" value="${esc(c.key)}"></label><p class="tag">ใช้เฉพาะ publishable key ห้ามใส่ secret key</p></div>
    <div class="panel"><h2>ข้อมูลในเครื่อง</h2><p class="tag">รอซิงก์ ${pendingCount()} รายการ${errCount() ? ` · ผิดพลาด ${errCount()} รายการ (แก้ไขรายการนั้นแล้วบันทึกใหม่เพื่อลองอีกครั้ง)` : ''}</p><button class="btn line" data-act="backup">สำรองข้อมูลเป็นไฟล์ JSON</button></div></div>`;
  }
};

function render() {
  $('#nav').innerHTML = NAV.map(([k, l]) => `<button data-act="go" data-id="${k}" class="${S.v === k ? 'on' : ''}">${l}</button>`).join('');
  $('#view').innerHTML = views[S.v](); setStatus();
}
const dialog = html => { const d = $('#dlg'); d.innerHTML = html; if (!d.open) d.showModal(); };
const closeDlg = () => $('#dlg').close();
const fld = (n, l, v = '', t = 'text', extra = '') => `<label>${l}<input name="${n}" type="${t}" value="${esc(v)}" ${extra}></label>`;
const foot = ok => `<div class="foot"><button type="button" class="btn line" data-act="close">ยกเลิก</button><button class="btn" type="submit">${ok}</button></div>`;

function custForm(c = {}, from = '') {
  dialog(`<form data-form="cust" data-id="${c.id || ''}" data-from="${from}"><h2>${c.id ? 'แก้ไขลูกค้า' : 'เพิ่มลูกค้า'}</h2><div class="two">${fld('full_name', 'ชื่อ-นามสกุล', c.full_name, 'text', 'required')}${fld('customer_code', 'รหัสลูกค้า', c.customer_code)}${fld('phone', 'โทรศัพท์', c.phone, 'tel')}${fld('budget_thb', 'งบประมาณ (บาท)', c.budget_thb, 'number', 'min="0"')}</div>${fld('lifestyle', 'ไลฟ์สไตล์ / การใช้งาน', c.lifestyle)}<label>บันทึก<textarea name="notes" rows="2">${esc(c.notes)}</textarea></label><label class="chk"><input type="checkbox" name="consent" ${c.consent_recorded_at ? 'checked' : ''}> ลูกค้ายินยอมให้เก็บข้อมูลส่วนบุคคลและค่าสายตา${c.consent_recorded_at ? ` (บันทึกเมื่อ ${day(c.consent_recorded_at)})` : ''}</label>${foot('บันทึกลูกค้า')}</form>`);
}
function rxForm(cid) {
  const g = (n, l, st = '0.25') => fld(n, l, '', 'number', `step="${st}"`);
  dialog(`<form data-form="rx" data-cid="${cid}"><h2>เพิ่มค่าสายตา · ${esc(custName(cid))}</h2>${fld('exam_date', 'วันที่ตรวจ', now().slice(0, 10), 'date')}<div class="two">${g('od_sph', 'ขวา SPH')}${g('od_cyl', 'ขวา CYL')}${fld('od_axis', 'ขวา AXIS (0-180)', '', 'number', 'min="0" max="180"')}<span></span>${g('os_sph', 'ซ้าย SPH')}${g('os_cyl', 'ซ้าย CYL')}${fld('os_axis', 'ซ้าย AXIS (0-180)', '', 'number', 'min="0" max="180"')}<span></span>${g('pd', 'PD', '0.5')}${g('add_power', 'ADD')}</div><label>บันทึก<textarea name="notes" rows="2"></textarea></label>${foot('บันทึกค่าสายตา')}</form>`);
}
function custView(id) {
  const c = find('customer_profiles', id), rx = db.prescriptions.filter(r => !r.deleted_at && r.customer_id === id).sort((a, b) => (b.exam_date || b.created_at).localeCompare(a.exam_date || a.created_at));
  const qs = live('quotes').filter(q => q.customer_id === id);
  dialog(`<h2>${esc(c.full_name)} <span class="tag">${esc(c.customer_code || '')}</span></h2><p class="tag">${esc([c.phone, c.budget_thb ? 'งบ ' + baht(c.budget_thb) : '', c.lifestyle].filter(Boolean).join(' · '))}${c.notes ? '<br>' + esc(c.notes) : ''}</p>
  <h3>ประวัติค่าสายตา</h3>${rx.length ? `<div class="wrap"><table><tr><th>วันที่</th><th>ขวา SPH/CYL/AXIS</th><th>ซ้าย SPH/CYL/AXIS</th><th>PD</th><th>ADD</th><th></th></tr>${rx.map(r => `<tr><td>${day(r.exam_date || r.created_at)}</td><td>${fmtP(r.od_sph)} / ${fmtP(r.od_cyl)} / ${r.od_axis ?? '-'}</td><td>${fmtP(r.os_sph)} / ${fmtP(r.os_cyl)} / ${r.os_axis ?? '-'}</td><td>${r.pd ?? '-'}</td><td>${fmtP(r.add_power)}</td><td>${mgr() ? `<button class="btn line sm bad" data-act="delrx" data-id="${r.id}" data-cid="${id}">ลบ</button>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="tag">ยังไม่มีค่าสายตา</p>'}
  <h3>ใบเสนอราคา</h3>${qs.map(q => `<div class="row"><span>${esc(q.quote_number || 'รอออกเลข')} · ${day(q.created_at)}</span><span>${baht(q.total_thb)} <span class="st ${q.status}">${QST[q.status]}</span></span></div>`).join('') || '<p class="tag">ยังไม่มี</p>'}
  <div class="foot"><button class="btn line" data-act="close">ปิด</button><button class="btn line" data-act="editcust" data-id="${id}">แก้ไขข้อมูล</button><button class="btn" data-act="newrx" data-id="${id}">เพิ่มค่าสายตา</button></div>`);
}
function prodForm(p = {}) {
  dialog(`<form data-form="prod" data-id="${p.id || ''}"><h2>${p.id ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า'}</h2>${fld('product_name', 'ชื่อสินค้า', p.product_name, 'text', 'required')}<div class="two"><label>ประเภท<select name="product_type">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${p.product_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${fld('retail_price_thb', 'ราคาขาย (บาท)', p.retail_price_thb ?? 0, 'number', 'min="0" required')}${fld('sku', 'SKU', p.sku)}${fld('brand', 'แบรนด์', p.brand)}${mgr() ? fld('cost_thb', 'ต้นทุน (บาท)', p.cost_thb, 'number', 'min="0"') : ''}${fld('stock_qty', 'จำนวนคงเหลือ (เว้นว่าง = ไม่ติดตาม)', p.stock_qty, 'number', 'step="1"')}</div>${fld('description', 'รายละเอียดสั้น ๆ', p.description)}${fld('features', 'แท็กการใช้งาน: general, screen, drive, outdoor, progressive (คั่นด้วยคอมมา)', (p.features || []).join(', '))}<label class="chk"><input type="checkbox" name="active" ${p.active === false ? '' : 'checked'}> เปิดขาย (แสดงใน Sales Studio)</label>${foot('บันทึกสินค้า')}</form>`);
}
function quoteSheet(id) {
  const q = find('quotes', id), items = live('quote_items').filter(i => i.quote_id === id);
  dialog(`<div class="sheet"><h2>ใบเสนอราคา ${esc(q.quote_number || '')}</h2><div class="meta">${esc(shop?.name || 'Social Eyewear')} · ${day(q.created_at)} · ลูกค้า: ${esc(custName(q.customer_id))}${q.valid_until ? ` · ใช้ได้ถึง ${day(q.valid_until)}` : ''}</div>
  <table><tr><th>รายการ</th><th>จำนวน</th><th>ราคา/หน่วย</th><th style="text-align:right">รวม</th></tr>${items.map(i => `<tr><td>${esc(i.item_name_snapshot)}</td><td>${i.quantity}</td><td>${baht(i.unit_price_thb)}</td><td style="text-align:right">${baht(i.line_total_thb)}</td></tr>`).join('')}</table>
  <div class="row"><span>รวม</span><span>${baht(q.subtotal_thb)}</span></div>${q.discount_thb ? `<div class="row"><span>ส่วนลด</span><span>-${baht(q.discount_thb)}</span></div>` : ''}
  <div class="row" style="border:0"><b>รวมสุทธิ</b><span class="total">${baht(q.total_thb)}</span></div>${q.notes ? `<p class="tag">หมายเหตุ: ${esc(q.notes)}</p>` : ''}
  <form data-form="quote" data-id="${id}" class="noprint"><div class="two"><label>สถานะ<select name="status">${Object.entries(QST).map(([k, l]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${fld('valid_until', 'ใช้ได้ถึง', q.valid_until || '', 'date')}</div><label>หมายเหตุ<textarea name="notes" rows="2">${esc(q.notes)}</textarea></label><div class="foot"><button type="button" class="btn line" data-act="close">ปิด</button><button type="button" class="btn line" data-act="print">พิมพ์ / PDF</button><button class="btn" type="submit">บันทึก</button></div></form></div>`);
}

const SAMPLE = [['lens', 'เลนส์ Single Vision ใส', 1500, 'general'], ['lens', 'เลนส์ Blue Light Cut', 2800, 'screen,general'], ['lens', 'เลนส์ Photochromic', 4200, 'outdoor,drive'], ['lens', 'เลนส์ Anti-Glare Drive', 3900, 'drive'], ['lens', 'เลนส์ Progressive Premium', 9800, 'progressive'], ['frame', 'กรอบ Titanium Round', 5900, ''], ['frame', 'กรอบ Acetate Classic', 3500, ''], ['service', 'ค่าตรวจวัดสายตา', 300, '']];

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id, a = b.dataset.act;
  if (a === 'go') { S.v = id; render(); if (id === 'settings') loadStaff(); }
  else if (a === 'need') { S.need = id; render(); }
  else if (a === 'ptype') { S.ptype = id; render(); }
  else if (a === 'add') { const p = find('products', id), x = S.cart.find(i => i.id === id); x ? x.qty++ : S.cart.push({ id, name: p.product_name, type: p.product_type, price: p.retail_price_thb, qty: 1 }); render(); }
  else if (a === 'qty') { const x = S.cart.find(i => i.id === id); x.qty += +b.dataset.d; if (x.qty < 1) S.cart = S.cart.filter(i => i !== x); render(); }
  else if (a === 'mkquote') {
    if (!S.cart.length) return toast('เลือกสินค้าอย่างน้อย 1 รายการก่อน');
    const sub = cartSub(), disc = Math.min(S.disc, sub), qid = uid();
    save('quotes', { id: qid, customer_id: S.cust || null, quote_number: null, status: 'draft', subtotal_thb: sub, discount_thb: disc, total_thb: sub - disc, notes: S.notes || null, valid_until: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), deleted_at: null });
    S.cart.forEach(i => save('quote_items', { id: uid(), quote_id: qid, product_id: i.id, item_name_snapshot: i.name, product_type: i.type, quantity: i.qty, unit_price_thb: i.price, line_total_thb: i.price * i.qty, deleted_at: null }));
    S.cart = []; S.disc = 0; S.notes = ''; S.v = 'quotes'; commit(); toast('สร้างใบเสนอราคาแล้ว');
  }
  else if (a === 'newcust') custForm({}, b.dataset.from || '');
  else if (a === 'editcust') custForm(find('customer_profiles', id));
  else if (a === 'viewcust') custView(id);
  else if (a === 'delcust') { if (confirm('ลบลูกค้ารายนี้? (ใบเสนอราคาเดิมยังอยู่)')) softDelete('customer_profiles', id); }
  else if (a === 'newrx') rxForm(id);
  else if (a === 'delrx') { if (confirm('ลบค่าสายตานี้?')) { softDelete('prescriptions', id); custView(b.dataset.cid); } }
  else if (a === 'newprod') prodForm(); else if (a === 'editprod') prodForm(find('products', id));
  else if (a === 'delprod') { if (confirm('ลบสินค้านี้?')) softDelete('products', id); }
  else if (a === 'sample') { SAMPLE.forEach(([product_type, product_name, retail_price_thb, f]) => save('products', { id: uid(), product_type, product_name, retail_price_thb, features: f ? f.split(',') : [], active: true, deleted_at: null })); commit(); }
  else if (a === 'viewq') quoteSheet(id);
  else if (a === 'delq') { if (confirm('ลบใบเสนอราคานี้?')) softDelete('quotes', id); }
  else if (a === 'csvcust') download('customers.csv', csv([['รหัส', 'ชื่อ', 'โทรศัพท์', 'งบ', 'ไลฟ์สไตล์', 'ยินยอม'], ...live('customer_profiles').map(c => [c.customer_code, c.full_name, c.phone, c.budget_thb, c.lifestyle, c.consent_recorded_at ? 'ใช่' : 'ไม่'])]));
  else if (a === 'csvq') download('quotes.csv', csv([['เลขที่', 'วันที่', 'ลูกค้า', 'รวม', 'ส่วนลด', 'สุทธิ', 'สถานะ'], ...live('quotes').map(q => [q.quote_number, q.created_at.slice(0, 10), custName(q.customer_id), q.subtotal_thb, q.discount_thb, q.total_thb, QST[q.status]])]));
  else if (a === 'backup') download('smart-optic-backup-' + now().slice(0, 10) + '.json', JSON.stringify(db, null, 1), 'application/json');
  else if (a === 'print') window.print();
  else if (a === 'close') closeDlg();
  else if (a === 'syncnow') sync();
  else if (a === 'logout') { if (!pendingCount() || confirm('ยังมีข้อมูลที่ไม่ได้ซิงก์ ออกจากระบบต่อหรือไม่? (ข้อมูลยังอยู่ในเครื่อง)')) { sess = null; ls.set('sess', null); S.staff = null; render(); } }
  else if (a === 'rmstaff') { if (confirm('ถอดพนักงานคนนี้ออกจากร้าน?')) api(`/rest/v1/shop_members?shop_id=eq.${shop.id}&user_id=eq.${id}`, { method: 'DELETE' }).then(loadStaff).catch(err => toast(errText(err))); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.bind; if (!k) return;
  if (k === 'cust') { S.cust = e.target.value; render(); }
  else if (k === 'disc') { S.disc = Math.max(0, Math.round(+e.target.value || 0)); render(); }
  else if (k === 'notes') S.notes = e.target.value;
  else if (k === 'qstatus') { save('quotes', { ...find('quotes', e.target.dataset.id), status: e.target.value }); commit(); }
  else if (k === 'url' || k === 'key') { ls.set(k, e.target.value.trim()); toast('บันทึกการตั้งค่าแล้ว'); setStatus(); }
});
document.addEventListener('input', e => { const k = e.target.dataset.bind; if (k === 'q' || k === 'pq') { S[k] = e.target.value; const p = e.target.selectionStart; render(); const i = $(`[data-bind=${k}]`); i.focus(); i.setSelectionRange(p, p); } });
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
  const d = Object.fromEntries(new FormData(f)), k = f.dataset.form, id = f.dataset.id;
  try {
    if (k === 'cust') {
      const o = id ? find('customer_profiles', id) : {}, nid = id || uid();
      save('customer_profiles', { ...o, id: nid, full_name: d.full_name.trim(), customer_code: d.customer_code.trim() || null, phone: d.phone.trim() || null, budget_thb: num(d.budget_thb), lifestyle: d.lifestyle.trim() || null, notes: d.notes.trim() || null, consent_recorded_at: d.consent ? (o.consent_recorded_at || now()) : null, deleted_at: null });
      if (f.dataset.from === 'studio') S.cust = nid; closeDlg(); commit(); toast('บันทึกลูกค้าแล้ว');
    } else if (k === 'rx') {
      save('prescriptions', { id: uid(), customer_id: f.dataset.cid, exam_date: d.exam_date || null, od_sph: num(d.od_sph), od_cyl: num(d.od_cyl), od_axis: num(d.od_axis), os_sph: num(d.os_sph), os_cyl: num(d.os_cyl), os_axis: num(d.os_axis), pd: num(d.pd), add_power: num(d.add_power), notes: d.notes.trim() || null, deleted_at: null });
      commit(); custView(f.dataset.cid); toast('บันทึกค่าสายตาแล้ว');
    } else if (k === 'prod') {
      const o = id ? find('products', id) : {};
      save('products', { ...o, id: id || uid(), product_name: d.product_name.trim(), product_type: d.product_type, retail_price_thb: Math.round(+d.retail_price_thb) || 0, sku: d.sku.trim() || null, brand: d.brand.trim() || null, cost_thb: mgr() ? num(d.cost_thb) : (o.cost_thb ?? null), stock_qty: num(d.stock_qty), description: d.description.trim() || null, features: d.features.split(',').map(s => s.trim()).filter(Boolean), active: !!d.active, deleted_at: null });
      closeDlg(); commit(); toast('บันทึกสินค้าแล้ว');
    } else if (k === 'quote') {
      save('quotes', { ...find('quotes', id), status: d.status, valid_until: d.valid_until || null, notes: d.notes.trim() || null }); closeDlg(); commit(); toast('บันทึกใบเสนอราคาแล้ว');
    } else if (k === 'auth') {
      await auth(e.submitter?.value === 'signup' ? 'signup' : 'login', d.email.trim(), d.password); toast('เข้าสู่ระบบแล้ว'); render(); await sync(); if (!shop) S.v = 'settings'; render(); loadStaff();
    } else if (k === 'shop') {
      await api('/rest/v1/rpc/create_shop', { method: 'POST', body: JSON.stringify({ p_name: d.name }) }); toast('สร้างร้านแล้ว'); await sync(); loadStaff();
    } else if (k === 'staff') {
      await api('/rest/v1/rpc/add_staff', { method: 'POST', body: JSON.stringify({ p_shop: shop.id, p_email: d.email.trim(), p_role: d.role }) }); f.reset(); toast('เพิ่มพนักงานแล้ว'); loadStaff();
    }
  } catch (err) { toast(errText(err)); }
});
window.addEventListener('online', () => { setStatus(); sync(); }); window.addEventListener('offline', setStatus);
setInterval(sync, 60000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
persist(); render(); sync();
})();
