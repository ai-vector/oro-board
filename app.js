// ORO dashboard: renders data/latest.json (written by collect.py). All times are shown in EDT.
'use strict';

const TZ = 'America/New_York';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem('oro-dash:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('oro-dash:' + k, v); } catch { /* private window */ } },
};

// ---- formatting ----
function toDate(ts) {
  if (!ts) return null;
  let s = String(ts).replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]$|[+-]\d\d:\d\d$/.test(s)) s += 'Z';  // API stamps are UTC without a suffix
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const fmtT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
const edt = ts => { const d = toDate(ts); return d ? fmtT.format(d) : '—'; };
function rel(ts) {
  const d = toDate(ts); if (!d) return '';
  const m = Math.round((d - Date.now()) / 60000), a = Math.abs(m);
  const t = a < 60 ? `${a} min` : a < 2880 ? `${(a / 60).toFixed(1)} h` : `${(a / 1440).toFixed(1)} d`;
  return m >= 0 ? `in ${t}` : `${t} ago`;
}
const sc = v => v == null ? '—' : Number(v).toFixed(3);
const pct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';
const usd = v => v == null ? '—' : '$' + Number(v).toFixed(2);
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
const addr = a => a ? `<span class="addr" title="${esc(a)} (click to copy)" data-copy="${esc(a)}">${esc(short(a))}</span>` : '—';
const status = (lvl, text) => `<span class="status ${lvl}"><i></i>${esc(text)}</span>`;
const delta = v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(3)}</span>`;

// ---- state ----
const S = {
  d: null, tab: location.hash.slice(1) || store.get('tab') || 'overview', race: null, ckRace: null,
  lbMode: store.get('lbMode') || 'overall', q: {}, sort: {}, open: new Set(), more: {}, flags: {},
};
let X = null;  // derived lookups
const TABLES = {};

function derive(d) {
  const myHot = new Set((d.my?.hotkeys || []).map(h => h.hotkey));
  const myCold = d.my?.coldkey;
  const owners = d.owners || {};
  const chainBy = new Map((d.chain?.neurons || []).map(n => [n.hotkey, n]));
  const races = (d.races || []).slice().sort((a, b) => a.race.race_number - b.race.race_number);
  // race_rank is the crown order (by Overall); add the rank by raw race score next to it.
  // The defending incumbent of races 1-2 is missing from their qualifier lists: add it back from the race row.
  for (const r of races) {
    const w = r.race;
    if (w.winner_agent_version_id && w.winner_score != null && !r.qualifiers.some(q => q.agent_version_id === w.winner_agent_version_id))
      r.qualifiers.push({ agent_version_id: w.winner_agent_version_id, agent_name: w.winner_agent_name,
        miner_hotkey: (d.leaderboard?.entries || []).find(e => e.agent_version_id === w.winner_agent_version_id)?.miner_hotkey ?? null,
        qualification_type: 'INCUMBENT', race_score: w.winner_score, race_rank: 1, qualifying_score: null, weighted_score: null });
    const scored = r.qualifiers.filter(q => q.race_score != null).sort((a, b) => b.race_score - a.race_score);
    scored.forEach((q, i) => { q.raw_rank = i && q.race_score === scored[i - 1].race_score ? scored[i - 1].raw_rank : i + 1; });
  }
  const isMine = hk => myHot.has(hk) || (!!myCold && owners[hk] === myCold);
  const kingId = d.king?.top_agent_version_id;
  const overallRace = [...races].reverse().find(r => r.qualifiers.some(q => q.weighted_score != null));
  return { myHot, myCold, owners, chainBy, races, isMine, kingId, overallRace };
}

function agentCell(r) {
  // hotkey and coldkey ride along as a tooltip (click copies the hotkey) to keep tables narrow
  const tip = `hotkey ${r.miner_hotkey}\ncoldkey ${X.owners[r.miner_hotkey] || '?'}\n(click to copy hotkey)`;
  let s = `<span class="agent" title="${esc(tip)}" data-copy="${esc(r.miner_hotkey)}">${esc(r.agent_name)}</span>` + (r.version_number ? ` <span class="muted">v${r.version_number}</span>` : '');
  if (X.isMine(r.miner_hotkey)) s += '<span class="badge ours">ours</span>';
  else s += teamBadge(teamOf(r.miner_hotkey));
  if (r.agent_version_id && r.agent_version_id === X.kingId) s += '<span class="badge king">king</span>';
  if (r.is_discarded) s += '<span class="badge">discarded</span>';
  if (r.is_miner_banned) s += '<span class="badge">banned</span>';
  return s;
}

// ---- sortable table ----
function drawTable(id) {
  const spec = TABLES[id]; const box = document.getElementById('tbl-' + id);
  if (!spec || !box) return;
  const { cols, opt = {} } = spec;
  let rows = spec.rows();
  const st = S.sort[id] || opt.sort || { k: cols[0].k, dir: 1 };
  const col = cols.find(c => c.k === st.k) || cols[0];
  const val = r => col.v ? col.v(r) : r[col.k];
  rows = rows.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * st.dir;
  });
  const limit = S.more[id] ? Infinity : (opt.limit || Infinity);
  const shown = rows.slice(0, limit);
  const head = cols.map(c => `<th class="${c.num ? 'num' : ''}" data-table="${id}" data-k="${c.k}"${c.k === col.k ? ` aria-sort="${st.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = shown.map(r => {
    const key = opt.key ? opt.key(r) : null;
    const cls = [opt.rowClass?.(r), opt.expand ? 'click' : ''].filter(Boolean).join(' ');
    let tr = `<tr class="${cls}"${opt.expand ? ` data-open="${esc(id + '|' + key)}"` : ''}>` +
      cols.map(c => `<td class="${[c.num ? 'num' : '', c.cls || ''].join(' ')}">${c.f ? c.f(r) : esc(r[c.k] ?? '—')}</td>`).join('') + '</tr>';
    if (opt.expand && S.open.has(id + '|' + key)) tr += `<tr class="detail"><td colspan="${cols.length}">${opt.expand(r)}</td></tr>`;
    return tr;
  }).join('');
  const more = rows.length > shown.length ? `<div class="more"><button data-more="${id}">Show all ${rows.length} rows</button></div>` : '';
  box.innerHTML = `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="muted">No rows</td></tr>`}</tbody></table></div>` +
    `<div class="muted" style="font-size:12px;margin-top:4px">${shown.length} of ${rows.length} rows</div>${more}`;
}
const tableBox = id => `<div id="tbl-${id}"></div>`;
const search = (id, ph) => `<input type="search" data-search="${id}" placeholder="${esc(ph)}" value="${esc(S.q[id] || '')}">`;
const match = (id, ...fields) => {
  const q = (S.q[id] || '').trim().toLowerCase();
  return !q || fields.some(f => String(f ?? '').toLowerCase().includes(q));
};
const flag = (id, label) => `<label class="chk"><input type="checkbox" data-flag="${id}"${S.flags[id] ? ' checked' : ''}> ${esc(label)}</label>`;

// ---- header strip ----
function drawStrip() {
  const cur = X.races[X.races.length - 1]?.race, k = S.d.king;
  const parts = [];
  if (cur) {
    const nx = nextEvent(cur);
    parts.push(`Race <b>${cur.race_number}</b> ${esc(stateWord(cur))} · ${cur.qualifier_count ?? '—'} qualifiers` + (nx ? ` · ${nx.word} ${edt(nx.at)}` : ''));
  }
  // between races the API can report no king at all (every field null)
  if (k?.top_agent_version_id) {
    const kq = X.races.flatMap(r => r.qualifiers).find(q => q.agent_version_id === k.top_agent_version_id);
    parts.push(`King <b>${esc(kq?.agent_name || short(k.top_miner_hotkey))}</b> ${sc(k.top_score)} · to beat <b>${sc(k.challenge_threshold)}</b>`);
    if (k.payout?.usd_per_day != null) parts.push(`${usd(k.payout.usd_per_day)}/day` + (k.payout.tao_per_day != null ? ` (τ${k.payout.tao_per_day.toFixed(1)})` : ''));
  } else if (k) parts.push('No king right now');
  $('#strip').innerHTML = parts.map(p => `<span>${p}</span>`).join('');
  $('#fresh').textContent = `snapshot ${edt(S.d.generated_at)}`;
}

// ---- alerts: only what needs action ----
function alerts() {
  const out = [];
  for (const e of S.d.errors || []) {
    const name = e.split(':')[0], sec = S.d.sections?.[name];
    out.push(['warning', name, sec?.stale ? `fetch failed · showing ${edt(sec.at)}` : 'fetch failed']);
  }
  for (const h of S.d.my?.hotkeys || []) {
    if (!h.registered) continue;
    if (h.inference && !h.inference.ok) out.push(['critical', h.name, h.inference.detail]);
    else if (h.inference && !h.inference.providers?.some(p => p.connected)) out.push(['serious', h.name, 'no inference provider connected']);
    if (!h.immune && !(h.incentive > 0)) out.push(['serious', h.name, `prune risk · 0 incentive · queue #${h.prune_position ?? '—'}/${h.prune_pool}`]);
  }
  for (const k of S.d.credits?.keys || []) {
    const u = k.limit ? k.usage / k.limit : 0;
    if (u >= 0.5) out.push([u >= 0.8 ? 'critical' : 'warning', `${k.name} key`, `${pct(u, 0)} used · ${usd(k.limit_remaining)} left`]);
  }
  const order = { critical: 0, serious: 1, warning: 2 };
  return out.sort((a, b) => order[a[0]] - order[b[0]]);
}

// ---- helpers ----
function bestOurs(race) {
  const mine = race.qualifiers.filter(q => X.isMine(q.miner_hotkey));
  const scored = mine.filter(q => q.race_score != null).sort((a, b) => b.race_score - a.race_score);
  return { mine, best: scored[0] };
}
const isLive = race => race.race.status !== 'RACE_COMPLETE';
const stateWord = r => r.status.replace('RACE_', '').replace(/_/g, ' ').toLowerCase();
// the next moment that matters for a race that is not complete: qualifying closes, or the race ends
const nextEvent = r => r.status === 'RACE_COMPLETE' ? null
  : r.status.startsWith('QUALIFYING') ? { word: 'closes', at: r.qualifying_closes_at } : { word: 'ends', at: r.projected_completion_at };
const clock = ts => edt(ts).replace(/^\w+ \d+, /, '');
const rk = (n, score) => n == null ? '—' : `<b>#${n}</b>${score != null ? ` <span class="muted">${sc(score)}</span>` : ''}`;
const rowOurs = hk => X.isMine(hk) ? 'ours' : '';
const tile = (k, v, d = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

// ---- team labels (teams.py): coldkey -> team, team -> Discord names; the newer `at` wins per record ----
const TM = { doc: { teams: {}, coldkeys: {} } };
const teamOfCold = ck => (ck && TM.doc.coldkeys[ck]?.team) || '';
const teamOf = hk => teamOfCold(X.owners[hk]);
const teamInfo = name => (name && !TM.doc.teams[name]?.deleted && TM.doc.teams[name]) || {};
const teamNames = () => [...new Set([...Object.keys(TM.doc.teams).filter(n => !TM.doc.teams[n].deleted),
  ...Object.values(TM.doc.coldkeys).map(c => c.team).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
const canEditTeams = () => MODE === 'local' || !!S.d?.edit?.token;
const teamBadge = name => name ? `<span class="badge team" title="${esc(teamInfo(name).discord ? 'Discord: ' + teamInfo(name).discord : 'team')}">${esc(name)}</span>` : '';
const teamText = ck => { const t = teamOfCold(ck); return [t, teamInfo(t).discord, teamInfo(t).note]; };  // for filters

function mergeTeams(a, b) {
  const canon = r => JSON.stringify(r, Object.keys(r).sort());
  const out = {};
  for (const sec of ['teams', 'coldkeys']) {
    const x = a?.[sec] || {}, y = b?.[sec] || {};
    out[sec] = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const p = x[k], q = y[k];
      out[sec][k] = !p ? q : !q ? p : (p.at > q.at || (p.at === q.at && canon(p) > canon(q))) ? p : q;
    }
  }
  return out;
}

// hosted page: the shared copy is teams.enc on the repo's `teams` branch, encrypted with the login key
const ghApi = (path, opt = {}) => fetch(`https://api.github.com/repos/${S.d.edit.repo}/${path}`, { cache: 'no-store', ...opt,
  headers: { Authorization: `Bearer ${S.d.edit.token}`, Accept: 'application/vnd.github+json', ...(opt.headers || {}) } });
async function encryptBlob(obj) {
  const gz = await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const key = await crypto.subtle.importKey('raw', KEY, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
  const b = u => btoa(Array.from(u, c => String.fromCharCode(c)).join(''));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: META.iter, salt: META.salt, iv: b(iv), ct: b(ct) };
}
async function remoteTeams() {
  const e = S.d.edit, r = await ghApi(`contents/${e.path}?ref=${e.branch}&t=${Date.now()}`);
  if (r.status === 404) return { doc: { teams: {}, coldkeys: {} }, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const info = await r.json();
  return { doc: await decryptBlob(JSON.parse(atob(info.content.replace(/\s/g, ''))), KEY), sha: info.sha };
}
async function loadTeams() {
  try {
    if (MODE === 'local') TM.doc = await (await fetch('api/teams', { cache: 'no-store' })).json();
    else TM.doc = mergeTeams(S.d.teams, S.d.edit?.token ? (await remoteTeams()).doc : null);
  } catch (err) {
    if (MODE === 'static') TM.doc = mergeTeams(S.d.teams, null);
    console.warn('team labels:', err.message);
  }
}
async function saveTeams(ops) {
  if (MODE === 'local') {
    const r = await fetch('api/teams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ops) });
    if (!r.ok) throw new Error(`server ${r.status}`);
    TM.doc = await r.json(); return;
  }
  const at = new Date().toISOString(), mine = { teams: {}, coldkeys: {} };
  for (const o of ops) mine[o.sec][o.key] = { ...o.val, at };
  for (let i = 0; i < 3; i++) {  // a concurrent writer moves the sha: re-read, re-merge, retry
    const { doc, sha } = await remoteTeams();
    const merged = mergeTeams(mergeTeams(S.d.teams, doc), mine);
    const r = await ghApi(`contents/${S.d.edit.path}`, { method: 'PUT', body: JSON.stringify({ message: 'team labels', branch: S.d.edit.branch,
      content: btoa(JSON.stringify(await encryptBlob(merged))), ...(sha ? { sha } : {}) }) });
    if (r.ok) { TM.doc = merged; return; }
    if (![409, 422].includes(r.status) || i === 2) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  }
}

// the edit dialog: one coldkey (assign / remove / set the team's Discord names) or one team (rename, Discord, note)
const DLG = { mode: null, key: null };
function openTeamDialog(mode, key) {
  DLG.mode = mode; DLG.key = key;
  const name = mode === 'coldkey' ? teamOfCold(key) : key, info = teamInfo(name);
  $('#team-title').textContent = mode === 'coldkey' ? 'Coldkey team' : 'Edit team';
  $('#team-who').textContent = mode === 'coldkey' ? short(key) : `${Object.values(TM.doc.coldkeys).filter(c => c.team === key).length} coldkeys`;
  $('#team-list').innerHTML = teamNames().map(n => `<option value="${esc(n)}">`).join('');
  $('#team-name').value = name; $('#team-discord').value = info.discord || ''; $('#team-note').value = info.note || '';
  $('#team-clear').hidden = mode !== 'coldkey' || !name;
  $('#team-msg').textContent = '';
  $('#teamdlg').showModal(); $('#team-name').focus();
}
$('#team-name').addEventListener('change', () => {  // picking an existing team shows its Discord names
  const info = teamInfo($('#team-name').value.trim());
  if (info.at) { $('#team-discord').value = info.discord || ''; $('#team-note').value = info.note || ''; }
});
$('#team-cancel').addEventListener('click', () => $('#teamdlg').close());
async function submitTeam(clear) {
  const name = clear ? '' : $('#team-name').value.trim(), discord = $('#team-discord').value.trim(), note = $('#team-note').value.trim();
  const ops = [];
  if (DLG.mode === 'coldkey') {
    ops.push({ sec: 'coldkeys', key: DLG.key, val: { team: name } });
    const info = teamInfo(name);
    if (name && (!info.at || info.discord !== discord || info.note !== note)) ops.push({ sec: 'teams', key: name, val: { discord, note } });
  } else {
    if (!name) { $('#team-msg').textContent = 'A team needs a name.'; return; }
    ops.push({ sec: 'teams', key: name, val: { discord, note } });
    if (name !== DLG.key) {  // rename: move every coldkey, then retire the old name
      for (const [ck, c] of Object.entries(TM.doc.coldkeys)) if (c.team === DLG.key) ops.push({ sec: 'coldkeys', key: ck, val: { team: name } });
      ops.push({ sec: 'teams', key: DLG.key, val: { deleted: true } });
    }
  }
  const btn = $('#team-save'); btn.disabled = true; $('#team-msg').textContent = 'Saving…';
  try { await saveTeams(ops); $('#teamdlg').close(); render(); }
  catch (err) { $('#team-msg').textContent = 'Not saved: ' + err.message; }
  finally { btn.disabled = false; }
}
$('#teamform').addEventListener('submit', e => { e.preventDefault(); submitTeam(false); });
$('#team-clear').addEventListener('click', () => submitTeam(true));

const TABS = {
  overview() {
    const cur = X.races[X.races.length - 1];
    const acc = S.d.credits?.account, keys = S.d.credits?.keys || [];
    const hks = S.d.my?.hotkeys || [], regs = hks.filter(h => h.registered);
    const entries = cur ? bestOurs(cur).mine : [];
    const al = alerts();
    // one box per race, one line per agent we entered: raw rank and raw score (qualifying score while not scored)
    const perRace = X.races.map(r => {
      const mine = bestOurs(r).mine.slice().sort((a, b) => (a.raw_rank ?? 1e9) - (b.raw_rank ?? 1e9) || (b.qualifying_score ?? 0) - (a.qualifying_score ?? 0));
      const ran = r.qualifiers.filter(q => q.race_score != null).length;
      const line = q => `<div class="mrow"><span class="nm" title="${esc(q.agent_name)} v${q.version_number ?? ''}">${esc(q.agent_name)}</span>` +
        (q.race_score != null ? `<b>#${q.raw_rank}</b><span>${sc(q.race_score)}</span>` : `<span class="muted">q</span><span>${sc(q.qualifying_score)}</span>`) + '</div>';
      return `<div class="mini${mine.length ? ' has' : ''}"><div class="k">R${r.race.race_number} <span class="muted">${ran ? `· ${ran} ran` : `· ${esc(stateWord(r.race))}`}</span></div>
        ${mine.length ? mine.map(line).join('') : '<div class="muted none">no entry</div>'}</div>`;
    }).join('');
    const html = `
      ${al.length ? `<div class="alerts">${al.map(([l, who, t]) => `<div class="alert ${l}">${status(l, '')}<b>${esc(who)}</b><span>${esc(t)}</span></div>`).join('')}</div>` : ''}
      <div class="tiles" style="margin-top:12px">
        ${tile(`Race ${cur?.race.race_number ?? '—'} · ${cur ? stateWord(cur.race) : ''}`,
          cur && isLive(cur) ? `${nextEvent(cur.race).word} ${clock(nextEvent(cur.race).at)}` : cur ? sc(Math.max(...cur.qualifiers.map(q => q.race_score ?? 0))) : '—',
          `${cur?.race.qualifier_count ?? '—'} qualifiers${cur && isLive(cur) ? ` · ${rel(nextEvent(cur.race).at)}` : ' · top raw'}`)}
        ${tile(`Ours in R${cur?.race.race_number ?? ''}`, esc(entries.map(q => q.agent_name).join(' · ') || 'none'),
          entries.map(q => q.race_score != null ? `${esc(q.agent_name)} raw #${q.raw_rank} · ${sc(q.race_score)}` : `${esc(q.agent_name)} q ${sc(q.qualifying_score)}`).join('<br>'))}
        ${tile('Hotkeys', `${regs.length}/${hks.length} registered`,
          (S.d.my?.wallet?.free_tao != null ? `coldkey τ${S.d.my.wallet.free_tao.toFixed(4)} free · fee τ${S.d.my.wallet.burn_tao.toFixed(4)}<br>` : '') +
          regs.map(h => `${h.name} ${h.last_submit && !h.last_submit.free ? `cooldown → ${edt(h.last_submit.cooldown_until)}` : 'can submit'}`).join('<br>'))}
        ${tile('Credit left', acc ? usd(acc.total_credits - acc.total_usage) : '—', [
          ...keys.map(k => `${esc(k.name)} ${usd(k.limit_remaining)}`),
          ...(S.d.credits?.inactive || []).map(k => `${esc(k.name)} <span class="neg">rejected</span>`),
          ...(S.d.credits?.other || []).map(k => `${esc(k.name)} <span class="${k.state === 'critical' ? 'neg' : 'muted'}">${k.state === 'good' ? 'valid' : k.state === 'idle' ? 'submit only' : 'invalid'}</span>`),
        ].join(' · '))}
      </div>
      <h2>Our raw rank per race</h2>
      <div class="minis">${perRace}</div>`;
    return { html };
  },

  overall() {
    const seg = `<div class="seg">${[['overall', 'Overall'], ['all', 'All submissions']].map(([k, l]) => `<button data-lbmode="${k}" aria-pressed="${S.lbMode === k}">${l}</button>`).join('')}</div>`;
    if (S.lbMode === 'overall') {
      const src = X.overallRace;
      if (!src) return { html: seg + '<p class="muted">No race has Overall scores yet.</p>' };
      const n = src.race.race_number, wins = [n - 2, n - 1, n].filter(x => x > 0);
      const rows = src.qualifiers.filter(q => q.weighted_score != null);
      const win = (q, r) => (q.window || []).find(w => w.race_number === r);
      TABLES.ov = {
        rows: () => rows.filter(q => match('ov', q.agent_name, q.miner_hotkey, X.owners[q.miner_hotkey], ...teamText(X.owners[q.miner_hotkey])) && (!S.flags.ovMine || X.isMine(q.miner_hotkey))),
        cols: [
          { k: 'weighted_score', label: 'Overall', num: true, f: q => `<b>${sc(q.weighted_score)}</b>` },
          { k: 'agent_name', label: 'Agent', f: agentCell, v: q => q.agent_name.toLowerCase() },
          ...wins.map(r => ({ k: 'r' + r, label: `R${r} raw`, num: true, v: q => win(q, r)?.rank ?? null,
            f: q => { const w = win(q, r); return w && w.raw_score != null ? rk(w.rank, w.raw_score) : '<span class="muted">—</span>'; } })),
          { k: 'qualifying_score', label: 'Qualifying', num: true, f: q => sc(q.qualifying_score) },
        ],
        opt: { sort: { k: 'weighted_score', dir: -1 }, limit: 100, rowClass: q => rowOurs(q.miner_hotkey) },
      };
      return { html: `<div class="controls">${seg}${search('ov', 'Filter agent, team, hotkey, coldkey')}${flag('ovMine', 'ours')}</div>
        <p class="muted note">After R${n} · raw rank and score in each window race · — = not run</p>${tableBox('ov')}`, tables: ['ov'] };
    }
    const entries = S.d.leaderboard?.entries || [];
    TABLES.lb = {
      rows: () => entries.filter(e => match('lb', e.agent_name, e.miner_hotkey, X.owners[e.miner_hotkey], ...teamText(X.owners[e.miner_hotkey]))
        && (!S.flags.lbMine || X.isMine(e.miner_hotkey)) && (!S.flags.lbClean || !(e.is_discarded || e.is_miner_banned))),
      cols: [
        { k: 'agent_name', label: 'Agent', f: agentCell, v: e => e.agent_name.toLowerCase() },
        { k: 'race_score', label: 'Race', num: true, f: e => sc(e.race_score) },
        { k: 'final_score', label: 'Qualifying', num: true, f: e => sc(e.final_score) },
        { k: 'eligible_at', label: 'Eligible', f: e => edt(e.eligible_at) },
        { k: 'state', label: 'State', v: e => e.is_current_top ? 0 : e.is_active_qualifier ? 1 : e.eliminated_at ? 3 : 2,
          f: e => e.is_current_top ? status('good', 'king') : e.is_active_qualifier ? status('good', 'racing') : e.eliminated_at ? status('idle', 'eliminated') : status('idle', 'idle') },
      ],
      opt: { sort: { k: 'race_score', dir: -1 }, limit: 200, rowClass: e => rowOurs(e.miner_hotkey) },
    };
    return { html: `<div class="controls">${seg}${search('lb', 'Filter agent, team, hotkey, coldkey')}${flag('lbMine', 'ours')}${flag('lbClean', 'hide discarded')}</div>${tableBox('lb')}`, tables: ['lb'] };
  },

  races() {
    const race = X.races.find(r => r.race.race_number === S.race) || X.races[X.races.length - 1];
    if (!race) return { html: '<p class="muted">No races.</p>' };
    S.race = race.race.race_number;
    const r = race.race, live = isLive(race);
    const { mine, best } = bestOurs(race);
    const top = race.qualifiers.filter(q => q.raw_rank === 1);
    const seg = `<div class="seg">${X.races.map(x => `<button data-race="${x.race.race_number}" aria-pressed="${x.race.race_number === S.race}">R${x.race.race_number}</button>`).join('')}</div>`;
    // a running race has no race scores yet: rank by qualifying score instead
    const qRank = new Map(race.qualifiers.slice().sort((a, b) => (b.qualifying_score ?? 0) - (a.qualifying_score ?? 0)).map((q, i) => [q, i + 1]));
    TABLES.race = {
      rows: () => race.qualifiers.filter(q => match('race', q.agent_name, q.miner_hotkey, X.owners[q.miner_hotkey], ...teamText(X.owners[q.miner_hotkey])) && (!S.flags.raceMine || X.isMine(q.miner_hotkey))),
      cols: live ? [
        { k: 'qrank', label: 'Q rank', num: true, v: q => qRank.get(q), f: q => `<b>#${qRank.get(q)}</b>` },
        { k: 'agent_name', label: 'Agent', f: agentCell, v: q => q.agent_name.toLowerCase() },
        { k: 'qualifying_score', label: 'Qualifying', num: true, f: q => sc(q.qualifying_score) },
      ] : [
        { k: 'raw_rank', label: 'Raw rank', num: true, f: q => q.raw_rank ? `<b>#${q.raw_rank}</b>` : '—' },
        { k: 'agent_name', label: 'Agent', f: agentCell, v: q => q.agent_name.toLowerCase() },
        { k: 'race_score', label: 'Race score', num: true, f: q => `<b>${sc(q.race_score)}</b>` },
        { k: 'qualifying_score', label: 'Qualifying', num: true, f: q => sc(q.qualifying_score) },
        { k: 'weighted_score', label: 'Overall', num: true, f: q => sc(q.weighted_score) },
      ],
      opt: { sort: live ? { k: 'qrank', dir: 1 } : { k: 'raw_rank', dir: 1 }, limit: 100, rowClass: q => rowOurs(q.miner_hotkey) },
    };
    const html = `<div class="controls">${seg}</div>
      <div class="tiles">
        ${tile(`R${r.race_number} · ${stateWord(r)}`, live ? `${nextEvent(r).word} ${clock(nextEvent(r).at)}` : edt(r.race_completed_at).replace(/ E[DS]T$/, ''),
          `${race.qualifiers.length} agents` + (r.race_started_at ? ` · started ${edt(r.race_started_at)}` : ''))}
        ${live ? tile('Top qualifying', sc(race.qualifiers.reduce((m, q) => Math.max(m, q.qualifying_score ?? 0), 0)), `threshold ${sc(r.qualifying_threshold)}`) : `
        ${tile('Top raw', top.length ? sc(top[0].race_score) : '—', esc(top.map(q => q.agent_name).join(', ')))}
        ${tile('Top-50 mean', r.top50_mean != null ? sc(r.top50_mean) : '—', r.top50_std != null ? `± ${sc(r.top50_std)}` : '')}`}
        ${tile('Ours', best ? `#${best.raw_rank}` : mine.length ? `${mine.length} in` : '—',
          mine.map(q => `${esc(q.agent_name)} ${q.race_score != null ? `#${q.raw_rank} · ${sc(q.race_score)}` : `q ${sc(q.qualifying_score)}`}`).join('<br>') || 'no entry')}
      </div>
      ${!live && r.winner_agent_name ? `<p class="muted note">Crown (by Overall): ${esc(r.winner_agent_name)} ${sc(r.winner_score)}</p>` : ''}
      <div class="controls">${search('race', 'Filter agent, team, hotkey, coldkey')}${flag('raceMine', 'ours')}</div>${tableBox('race')}`;
    return { html, tables: ['race'] };
  },

  hotkeys() {
    const my = S.d.my;
    if (!my) return { html: '<p class="muted">No hotkey data.</p>' };
    const lastRace = vid => {
      for (const r of [...X.races].reverse()) { const q = r.qualifiers.find(x => x.agent_version_id === vid); if (q) return { r, q }; }
      return null;
    };
    const card = h => {
      const inf = h.inference, a = h.agents?.[0], st = h.latest_status || {}, lr = a && lastRace(a.agent_version_id);
      const risk = !h.immune && !(h.incentive > 0);
      const head = risk ? status('serious', 'prune risk') : h.immune ? status('good', 'immune') : status('good', 'earning');
      const infOk = inf?.ok && inf.providers.some(p => p.connected);
      const cd = h.last_submit && !h.last_submit.free;
      return `<div class="card">
        <div class="cardhead"><b>${esc(h.name)}</b><span class="muted">UID ${h.uid}</span>${head}</div>
        <dl class="kv">
          <dt>Agent</dt><dd>${a ? `<b>${esc(a.agent_name)}</b> v${a.version_number}` : '—'}${h.in_current_race?.length ? ` ${status('good', 'in R' + X.races[X.races.length - 1].race.race_number)}` : st.eliminated_in_race_number ? ` <span class="muted">out in R${st.eliminated_in_race_number}</span>` : ''}</dd>
          <dt>Result</dt><dd>${lr ? (lr.q.race_score != null ? `R${lr.r.race.race_number} raw <b>#${lr.q.raw_rank}</b> · ${sc(lr.q.race_score)}` : `R${lr.r.race.race_number} q ${sc(lr.q.qualifying_score)}`) : a ? `q ${sc(a.final_score)}` : '—'}</dd>
          <dt>Incentive</dt><dd>${pct(h.incentive, 3)}${risk ? ` · queue #${h.prune_position}/${h.prune_pool}` : ''}</dd>
          <dt>Inference</dt><dd>${infOk ? status('good', 'connected') : status('critical', inf?.detail || 'not connected')}</dd>
          <dt>Submit</dt><dd>${cd ? status('warning', `cooldown → ${edt(h.last_submit.cooldown_until)}`) : status('good', 'ready')}</dd>
        </dl></div>`;
    };
    const regs = my.hotkeys.filter(h => h.registered), unreg = my.hotkeys.filter(h => !h.registered);
    const ch = S.d.chain;
    const w = my.wallet || {};
    const tao = v => v == null ? '—' : 'τ' + v.toFixed(4);
    const walletTiles = w.free_tao != null ? `<div class="tiles" style="margin-bottom:10px">
        ${tile('Coldkey balance (free)', tao(w.free_tao), `${addr(my.coldkey)} · ${edt(w.at)}`)}
        ${tile('Registration fee now', tao(w.burn_tao), w.burn_tao ? `balance covers ${Math.floor(w.free_tao / w.burn_tao)} registration${Math.floor(w.free_tao / w.burn_tao) === 1 ? '' : 's'} at this fee` : '')}
        ${tile('Registered', `${regs.length} / ${my.hotkeys.length}`, regs.map(h => `${h.name} UID ${h.uid}`).join(' · '))}
      </div>` : (w.error ? `<p class="muted note">Balance unavailable: ${esc(w.error)}</p>` : '');
    return { html: `${walletTiles}<div class="grid2">${regs.map(card).join('')}</div>
      ${unreg.length ? `<p class="note"><span class="muted">Not registered:</span> ${unreg.map(h => `${esc(h.name)}${h.agents?.[0] ? ` <span class="muted">(${esc(h.agents[0].agent_name)})</span>` : ''}`).join(' · ')}</p>` : ''}
      <p class="muted note">Coldkey ${addr(my.coldkey)}${ch ? ` · immunity ≈${(ch.immunity_period * 12 / 3600).toFixed(1)} h after registering` : ''} · queue = non-immune UIDs by emission, #1 pruned first</p>` };
  },

  credit() {
    const c = S.d.credits;
    if (!c) return { html: '<p class="muted">No credit data.</p>' };
    const acc = c.account;
    const lvl = u => u >= 0.8 ? 'critical' : u >= 0.5 ? 'warning' : 'good';
    // keys without usage data: rejected/empty OpenRouter keys, the management key, Anthropic keys
    const plainCard = (name, provider, state, detail) => `<div class="card">
        <div class="cardhead"><b>${esc(name)}</b><span class="muted">${esc(provider)}</span></div>
        <div class="note" style="margin-top:10px">${status(state, detail)}</div></div>`;
    const card = k => {
      const u = k.limit ? k.usage / k.limit : null;
      return `<div class="card">
        <div class="cardhead"><b>${esc(k.name)}</b><span class="addr">${esc(k.label || '')}</span></div>
        ${u != null ? `<div class="big">${usd(k.limit_remaining)} <span class="muted">left of ${usd(k.limit)}</span></div>
          <div class="meter"><div style="width:${Math.min(100, u * 100)}%;background:var(--${lvl(u)})"></div></div>
          ${status(lvl(u), `${pct(u, 0)} used`)}` : '<div class="muted">no limit</div>'}
        <div class="muted note">today ${usd(k.usage_daily)} · week ${usd(k.usage_weekly)}</div></div>`;
    };
    return { html: `
      <div class="grid3">
        <div class="card"><div class="cardhead"><b>Account</b></div><div class="big">${acc ? usd(acc.total_credits - acc.total_usage) : '—'} <span class="muted">left</span></div>
          <div class="muted note">${acc ? `${usd(acc.total_usage)} used of ${usd(acc.total_credits)}` : ''}</div></div>
        ${c.keys.map(card).join('')}
        ${c.inactive.map(k => plainCard(k.name, 'OpenRouter', 'critical', k.reason)).join('')}
        ${(c.other || []).map(k => plainCard(k.name, k.provider, k.state, k.detail)).join('')}
      </div>` };
  },

  coldkeys() {
    const opts = [...X.races.map(r => r.race.race_number), 'now'];
    if (!opts.includes(S.ckRace)) S.ckRace = X.races[X.races.length - 1]?.race.race_number ?? 'now';
    const seg = `<div class="seg">${opts.map(o => `<button data-ckrace="${o}" aria-pressed="${o === S.ckRace}">${o === 'now' ? 'Chain now' : 'R' + o}</button>`).join('')}</div>`;
    const chainByCold = new Map();
    for (const n of S.d.chain?.neurons || []) {
      const g = chainByCold.get(n.coldkey) || { uids: 0, incentive: 0, emission: 0 };
      g.uids++; g.incentive += n.incentive; g.emission += n.emission_share;
      chainByCold.set(n.coldkey, g);
    }
    const reg = hk => X.chainBy.get(hk);
    const edit = canEditTeams();
    const ckCell = g => g.team_group ? `<span class="muted">${g.cks.length} coldkeys</span>`
      : addr(g.coldkey === 'unknown' ? null : g.coldkey) + (g.coldkey === X.myCold ? '<span class="badge ours">ours</span>' : '');
    // team cell: a coldkey row assigns its team; a merged team row renames the team / edits its Discord names
    const teamCell = g => {
      if (!g.team_group && (g.coldkey === 'unknown' || g.coldkey === X.myCold)) return g.coldkey === X.myCold ? '<span class="muted">us</span>' : '—';
      const name = g.team_group ? g.team : teamOfCold(g.coldkey), dis = teamInfo(name).discord;
      const label = name ? `<span class="teamname">${esc(name)}</span>${dis ? ` <span class="muted">${esc(dis)}</span>` : ''}` : '+ team';
      if (!edit) return name ? label : '—';
      return `<button type="button" class="teambtn${name ? '' : ' add'}" ${g.team_group ? `data-team-rename="${esc(name)}"` : `data-team-edit="${esc(g.coldkey)}"`} title="edit team">${label}</button>`;
    };
    const agentsCell = (names, n = 4) => esc(names.slice(0, n).join(', ') + (names.length > n ? ` +${names.length - n}` : ''));
    const teamCol = { k: 'team', label: 'Team', cls: 'wrap', v: g => (g.team_group ? g.team : teamOfCold(g.coldkey)).toLowerCase() || null, f: teamCell };
    const cksNote = g => g.team_group ? `<p class="muted note">Coldkeys: ${g.cks.map(addr).join(' · ')}</p>` : '';
    // "group by team": coldkeys with the same team become one row; unlabelled coldkeys stay as they are
    const byTeam = (rows, fold) => {
      const out = new Map();
      for (const g of rows) {
        const t = g.coldkey !== X.myCold && teamOfCold(g.coldkey);
        if (!t) { out.set(g.coldkey, g); continue; }
        const cur = out.get('team:' + t);
        out.set('team:' + t, cur ? fold(cur, g) : { ...g, team_group: true, team: t, coldkey: 'team:' + t });
      }
      return [...out.values()];
    };
    const view = (rows, fold) => (S.flags.ckTeam ? byTeam(rows, fold) : rows);
    const fields = g => [...g.cks, ...g.agents, ...(g.team_group ? [g.team, teamInfo(g.team).discord] : teamText(g.coldkey))];
    let note;
    if (S.ckRace === 'now') {
      const lbBy = new Map();
      for (const e of S.d.leaderboard?.entries || []) (lbBy.get(e.miner_hotkey) || lbBy.set(e.miner_hotkey, []).get(e.miner_hotkey)).push(e);
      const groups = new Map();
      for (const n of S.d.chain?.neurons || []) {
        const g = groups.get(n.coldkey) || { coldkey: n.coldkey, members: [] };
        g.members.push({ ...n, versions: lbBy.get(n.hotkey) || [] });
        groups.set(n.coldkey, g);
      }
      const rows = [...groups.values()].map(g => {
        const vs = g.members.flatMap(m => m.versions), rs = vs.map(v => v.race_score).filter(v => v != null);
        return { ...g, cks: [g.coldkey], uids: g.members.length, incentive: g.members.reduce((s, m) => s + m.incentive, 0),
          emission: g.members.reduce((s, m) => s + m.emission_share, 0), agents: [...new Set(vs.map(v => v.agent_name))], best_race: rs.length ? Math.max(...rs) : null };
      });
      const fold = (a, b) => ({ ...a, cks: [...a.cks, ...b.cks], members: [...a.members, ...b.members], uids: a.uids + b.uids, incentive: a.incentive + b.incentive,
        emission: a.emission + b.emission, agents: [...new Set([...a.agents, ...b.agents])], best_race: Math.max(a.best_race ?? -1, b.best_race ?? -1) < 0 ? null : Math.max(a.best_race ?? -1, b.best_race ?? -1) });
      note = `${rows.length} coldkeys · ${S.d.chain?.neurons.length || 0} UIDs`;
      TABLES.ck = {
        rows: () => view(rows, fold).filter(g => match('ck', ...fields(g), ...g.members.map(m => m.hotkey)) && (!S.flags.ckMulti || g.uids > 1)),
        cols: [
          { k: 'coldkey', label: 'Coldkey', f: ckCell },
          teamCol,
          { k: 'uids', label: 'UIDs', num: true },
          { k: 'incentive', label: 'Incentive', num: true, f: g => pct(g.incentive, 2) },
          { k: 'best_race', label: 'Best race', num: true, f: g => sc(g.best_race) },
          { k: 'agents', label: 'Agents', cls: 'wrap', v: g => g.agents.length, f: g => agentsCell(g.agents) },
        ],
        opt: { sort: { k: 'incentive', dir: -1 }, limit: 100, key: g => g.coldkey, rowClass: g => g.coldkey === X.myCold ? 'ours' : '',
          expand: g => cksNote(g) + `<table><thead><tr><th>UID</th><th>Hotkey</th><th class="num">Incentive</th><th>Agents</th></tr></thead><tbody>${g.members.slice().sort((a, b) => b.incentive - a.incentive).map(m =>
            `<tr><td>${m.uid}${m.validator ? ' <span class="badge">validator</span>' : ''}</td><td>${addr(m.hotkey)}</td><td class="num">${pct(m.incentive, 2)}</td><td class="wrap">${esc(m.versions.map(v => `${v.agent_name} v${v.version_number}`).join(', ')) || '—'}</td></tr>`).join('')}</tbody></table>` },
      };
    } else {
      const race = X.races.find(r => r.race.race_number === S.ckRace), live = isLive(race);
      const groups = new Map();
      for (const q of race.qualifiers) {
        const ck = X.owners[q.miner_hotkey] || 'unknown';
        (groups.get(ck) || groups.set(ck, { coldkey: ck, entries: [] }).get(ck)).entries.push(q);
      }
      const stats = g => {
        const rs = g.entries.map(q => q.race_score).filter(v => v != null), ranks = g.entries.map(q => q.raw_rank).filter(v => v != null);
        return { ...g, n: g.entries.length, best_rank: ranks.length ? Math.min(...ranks) : null, best_race: rs.length ? Math.max(...rs) : null,
          mean_race: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, best_q: Math.max(...g.entries.map(q => q.qualifying_score ?? 0)),
          incentive_now: g.cks.reduce((s, ck) => s + (chainByCold.get(ck)?.incentive || 0), 0), agents: [...new Set(g.entries.map(q => q.agent_name))] };
      };
      const rows = [...groups.values()].map(g => stats({ ...g, cks: [g.coldkey] }));
      const fold = (a, b) => stats({ ...a, cks: [...a.cks, ...b.cks], entries: [...a.entries, ...b.entries] });
      note = `${race.qualifiers.length} entries · ${rows.length} coldkeys · ${rows.filter(g => g.n > 1).length} with several entries`;
      TABLES.ck = {
        rows: () => view(rows, fold).filter(g => match('ck', ...fields(g), ...g.entries.map(q => q.miner_hotkey)) && (!S.flags.ckMulti || g.n > 1)),
        cols: [
          { k: 'coldkey', label: 'Coldkey', f: ckCell },
          teamCol,
          { k: 'n', label: 'Entries', num: true },
          ...(live ? [{ k: 'best_q', label: 'Best qualifying', num: true, f: g => sc(g.best_q) }] : [
            { k: 'best_rank', label: 'Best raw rank', num: true, f: g => g.best_rank ? `<b>#${g.best_rank}</b>` : '—' },
            { k: 'best_race', label: 'Best race', num: true, f: g => sc(g.best_race) },
            { k: 'mean_race', label: 'Mean race', num: true, f: g => sc(g.mean_race) },
          ]),
          { k: 'incentive_now', label: 'Incentive now', num: true, f: g => pct(g.incentive_now, 2) },
          { k: 'agents', label: 'Agents', cls: 'wrap', v: g => g.agents.length, f: g => agentsCell(g.agents) },
        ],
        opt: { sort: live ? { k: 'best_q', dir: -1 } : { k: 'best_rank', dir: 1 }, limit: 100, key: g => g.coldkey, rowClass: g => g.coldkey === X.myCold ? 'ours' : '',
          expand: g => cksNote(g) + `<table><thead><tr><th class="num">Raw rank</th><th>Agent</th><th>Hotkey</th><th>Now</th><th class="num">Race</th><th class="num">Qualifying</th></tr></thead><tbody>${g.entries.slice().sort((a, b) => (a.raw_rank ?? 1e9) - (b.raw_rank ?? 1e9) || (b.qualifying_score ?? 0) - (a.qualifying_score ?? 0)).map(q =>
            `<tr><td class="num">${q.raw_rank ? '#' + q.raw_rank : '—'}</td><td>${agentCell(q)}</td><td>${addr(q.miner_hotkey)}</td><td>${reg(q.miner_hotkey) ? 'UID ' + reg(q.miner_hotkey).uid : '<span class="muted">dereg</span>'}</td><td class="num">${sc(q.race_score)}</td><td class="num">${sc(q.qualifying_score)}</td></tr>`).join('')}</tbody></table>` },
      };
    }
    const teamsN = teamNames().length;
    return { html: `<div class="controls">${seg}${search('ck', 'Filter coldkey, team, Discord, hotkey, agent')}${flag('ckMulti', 'several entries')}${flag('ckTeam', 'group by team')}</div>
      <p class="muted note">${note} · ${teamsN} team${teamsN === 1 ? '' : 's'} labelled · click a row for its hotkeys${edit ? ' · click a team cell to edit' : ' · team labels are read-only on this copy'}</p>${tableBox('ck')}`, tables: ['ck'] };
  },
};

// ---- render + events ----
function render() {
  if (!S.d) return;
  try { draw(); } catch (err) {
    // show the failure instead of leaving the page on "Loading snapshot…"
    $('#main').innerHTML = `<p class="pad">Could not draw this view: ${esc(err.message)}. Try another tab or Refresh.</p>`;
    console.error(err);
  }
}

function draw() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === S.tab));
  drawStrip();
  for (const k in TABLES) delete TABLES[k];
  const view = (TABS[S.tab] || TABS.overview)();
  $('#main').innerHTML = view.html;
  (view.tables || []).forEach(drawTable);
  view.after?.();
  const secs = S.d.sections || {};
  $('#foot').innerHTML = 'Sources: ' + Object.entries(secs).map(([k, v]) => `${k} ${edt(v.at)}${v.stale ? ' (stale)' : ''}`).join(' · ') +
    '. Times in EDT.' + (MODE === 'static' ? ' Encrypted snapshot.' : ' Local only (127.0.0.1).');
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, th[data-table], tr[data-open], .addr, .agent');
  if (!t) return;
  if (t.matches('.addr, .agent')) { navigator.clipboard?.writeText(t.dataset.copy); t.style.opacity = .5; setTimeout(() => { t.style.opacity = ''; }, 300); e.stopPropagation(); return; }
  if (t.dataset.teamEdit) { openTeamDialog('coldkey', t.dataset.teamEdit); return; }
  if (t.dataset.teamRename) { openTeamDialog('team', t.dataset.teamRename); return; }
  if (t.dataset.tab) { S.tab = t.dataset.tab; store.set('tab', S.tab); history.replaceState(null, '', '#' + S.tab); render(); return; }
  if (t.dataset.lbmode) { S.lbMode = t.dataset.lbmode; store.set('lbMode', S.lbMode); render(); return; }
  if (t.dataset.race) { S.race = +t.dataset.race; render(); return; }
  if (t.dataset.ckrace) { S.ckRace = t.dataset.ckrace === 'now' ? 'now' : +t.dataset.ckrace; S.open.clear(); render(); return; }
  if (t.dataset.more) { S.more[t.dataset.more] = true; drawTable(t.dataset.more); return; }
  if (t.matches('th[data-table]')) {
    const id = t.dataset.table, k = t.dataset.k, cur = S.sort[id] || TABLES[id].opt?.sort || {};
    S.sort[id] = { k, dir: cur.k === k ? -cur.dir : (TABLES[id].cols.find(c => c.k === k).num ? -1 : 1) };
    drawTable(id); return;
  }
  if (t.dataset.open) { const [id] = t.dataset.open.split('|'); S.open.has(t.dataset.open) ? S.open.delete(t.dataset.open) : S.open.add(t.dataset.open); drawTable(id); }
});
document.addEventListener('input', e => {
  if (e.target.dataset.search) { S.q[e.target.dataset.search] = e.target.value; drawTable(e.target.dataset.search); }
});
document.addEventListener('change', e => {
  const id = e.target.dataset.flag; if (!id) return;
  S.flags[id] = e.target.checked;
  Object.keys(TABLES).forEach(drawTable);
});

// theme toggle: OS default, then light/dark override
const savedTheme = store.get('theme'); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  store.set('theme', document.documentElement.dataset.theme);
});

// ---- data: local server (plain JSON) or hosted page (encrypted data.enc + login) ----
let MODE = 'local', KEY = null, META = null;  // META: salt + iterations of data.enc, reused for teams.enc
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const KEY_SLOT = 'oro-dash:key';

async function deriveKey(user, pass, meta) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${user}\n${pass}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(meta.salt), iterations: meta.iter }, base, 256);
  return new Uint8Array(bits);
}
async function decryptBlob(blob, raw) {
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.ct));  // throws on a wrong key
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}
const fetchBlob = async () => { const r = await fetch('data.enc?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
function savedKey(salt) {
  for (const s of [sessionStorage, localStorage]) {
    try { const v = JSON.parse(s.getItem(KEY_SLOT) || 'null'); if (v && v.salt === salt) return b64(v.key); } catch { /* storage blocked */ }
  }
  return null;
}
function forgetKey() { for (const s of [sessionStorage, localStorage]) { try { s.removeItem(KEY_SLOT); } catch { /* storage blocked */ } } }

async function accept(d) {
  const before = JSON.stringify(TM.doc);
  const changed = !S.d || S.d.generated_at !== d.generated_at;
  S.d = d; X = derive(d);
  await loadTeams();
  if ((changed || JSON.stringify(TM.doc) !== before) && !document.querySelector('#main input:focus') && !$('#teamdlg').open) render();
}

async function load() {
  try {
    if (MODE === 'static') accept(await decryptBlob(await fetchBlob(), KEY));
    else accept(await (await fetch('data/latest.json', { cache: 'no-store' })).json());
  } catch (err) {
    if (!S.d) $('#main').innerHTML = `<p class="pad">No snapshot yet. Run <code>python3 collect.py</code> or wait for the server's first refresh. (${esc(err.message)})</p>`;
  }
}

function showLogin(msg = '') {
  document.body.classList.add('locked');
  $('#login').hidden = false; $('#login-err').textContent = msg;
  $('#login-user').focus();
}
$('#login').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#login button'); btn.disabled = true; $('#login-err').textContent = '';
  try {
    const blob = await fetchBlob();
    const raw = await deriveKey($('#login-user').value.trim(), $('#login-pass').value, blob);
    const d = await decryptBlob(blob, raw).catch(() => null);
    if (!d) { $('#login-err').textContent = 'Wrong username or password.'; return; }
    KEY = raw;
    const slot = JSON.stringify({ salt: blob.salt, key: btoa(String.fromCharCode(...raw)) });
    try { ($('#login-remember').checked ? localStorage : sessionStorage).setItem(KEY_SLOT, slot); } catch { /* storage blocked */ }
    $('#login-pass').value = '';
    $('#login').hidden = true; document.body.classList.remove('locked');
    accept(d); setInterval(load, 120000);
  } catch (err) {
    $('#login-err').textContent = 'Could not load data: ' + err.message;
  } finally { btn.disabled = false; }
});
$('#logout').addEventListener('click', () => { forgetKey(); location.reload(); });

$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh'); b.disabled = true; b.textContent = 'Refreshing…';
  try {
    if (MODE === 'local') {
      await fetch('api/refresh', { method: 'POST' });
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const st = await (await fetch('api/status', { cache: 'no-store' })).json();
        if (!st.running) break;
      }
    }
    await load();
  } finally { b.disabled = false; b.textContent = 'Refresh'; }
});

(async function start() {
  let blob = null;
  try { blob = await fetchBlob(); } catch { /* no data.enc: local server */ }
  if (!blob) { load(); setInterval(load, 60000); return; }
  MODE = 'static'; META = { salt: blob.salt, iter: blob.iter }; $('#logout').hidden = false;
  KEY = savedKey(blob.salt);
  if (KEY) {
    try { accept(await decryptBlob(blob, KEY)); setInterval(load, 120000); return; } catch { forgetKey(); KEY = null; }
  }
  showLogin();
})();
