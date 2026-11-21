'use strict';
(() => {
  // ---------- utilità ----------
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  let toastTimer;
  const toast = (msg, err) => {
    $toast.textContent = msg;
    $toast.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.add('hidden'), 3500);
  };
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch { /* vuoto */ }
    if (r.status === 401 && path !== '/api/login' && path !== '/api/pin') { location.reload(); }
    if (!r.ok) { const e = new Error(data.error || 'Errore.'); e.status = r.status; e.data = data; throw e; }
    return data;
  };
  const act = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, true); } };
  const md = (text) => {
    const out = [];
    const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const p of parts) {
      if (p.startsWith('**') && p.endsWith('**') && p.length > 4) out.push(h('b', { text: p.slice(2, -2) }));
      else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) out.push(h('code', { text: p.slice(1, -1) }));
      else out.push(p);
    }
    return out;
  };
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (ms) => new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
  const STATES = { idle: 'non avviata', running: 'in corso', paused: 'in pausa', waiting_user: 'attende te', stopped: 'fermata', finished: 'conclusa' };
  const REASONS = { limite_turni: 'limite di turni', ripetizione: 'si ripetevano', tetto_spesa: 'tetto di spesa', conclusa: 'conclusa', fermata_utente: 'fermata da te', errore: 'errore', interrotta: 'interrotta dal riavvio' };
  const isNarrow = () => matchMedia('(max-width:900px)').matches;

  // ---------- stato ----------
  const S = { me: null, sessions: [], filter: 'all', current: null, detail: null, to: 'both', draft: '' };

  const avatarEl = (who, name, size) => {
    const v = S.me && S.me.avatars[who];
    const el = h('div', { class: `av ${who} ${size || ''}` });
    if (v) el.append(h('img', { src: `/api/avatar/${who}?v=${v}`, alt: '' }));
    else el.textContent = who === 'claude' ? 'C' : who === 'chatgpt' ? 'G' : (name || 'P').slice(0, 1).toUpperCase();
    return el;
  };

  // ---------- PIN ----------
  const pinScreen = (info) => {
    let mode = info.hasPin ? 'login' : 'create';
    let first = '';
    let digits = '';
    let msg = '';
    let isErr = false;
    let lock = 0;
    const view = () => {
      const title = mode === 'login' ? `Ciao ${info.name}` : mode === 'create' ? `Ciao ${info.name}, scegli un PIN` : 'Ripeti il PIN';
      const dots = h('div', { class: 'dots' }, [0, 1, 2, 3].map((i) => h('i', { class: i < digits.length ? 'on' : '' })));
      const keys = h('div', { class: 'keys' });
      for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']) {
        keys.append(k === '' ? h('button', { class: 'ghost', disabled: true }) : h('button', { onclick: () => press(k), 'aria-label': k }, k));
      }
      const wrap = h('div', { class: 'pin' }, h('img', { class: 'logo', src: 'icon-dark-180.png', alt: 'AI Bridge' }), avatarEl('user', info.name, 'sm'), h('h1', { text: title }), h('p', { class: isErr ? 'err' : '', text: msg }), dots, keys);
      $app.replaceChildren(wrap);
    };
    const press = async (k) => {
      if (lock > Date.now()) return;
      if (k === '⌫') digits = digits.slice(0, -1);
      else if (digits.length < 4) digits += k;
      msg = ''; isErr = false;
      view();
      if (digits.length < 4) return;
      const pin = digits;
      digits = '';
      try {
        if (mode === 'login') { await api('POST', '/api/login', { pin }); return start(); }
        if (mode === 'create') { first = pin; mode = 'confirm'; return view(); }
        if (pin !== first) { mode = 'create'; msg = 'I due PIN non coincidono. Riprova.'; isErr = true; return view(); }
        await api('POST', '/api/setup', { pin }); return start();
      } catch (e) {
        isErr = true;
        if (e.status === 429) {
          const sec = e.data.retryAfterSec || 60;
          lock = Date.now() + sec * 1000;
          const tick = () => {
            const left = Math.ceil((lock - Date.now()) / 1000);
            if (left <= 0) { msg = ''; isErr = false; view(); return; }
            msg = `Troppi tentativi. Riprova tra ${left >= 60 ? Math.ceil(left / 60) + ' min' : left + ' s'}.`;
            view(); setTimeout(tick, 1000);
          };
          tick();
        } else { msg = e.status === 401 ? `PIN errato${e.data.left !== undefined ? ` · tentativi rimasti: ${e.data.left}` : ''}.` : e.message; view(); }
      }
    };
    window.onkeydown = (ev) => {
      if (/^\d$/.test(ev.key)) press(ev.key);
      else if (ev.key === 'Backspace') press('⌫');
    };
    view();
  };

  // ---------- principale ----------
  let es;
  const start = async () => {
    window.onkeydown = null;
    S.me = await api('GET', '/api/me');
    await loadList();
    render();
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('update', (ev) => {
      const id = Number(ev.data);
      clearTimeout(start.t);
      start.t = setTimeout(async () => {
        await loadList(); S.me = await api('GET', '/api/me').catch(() => S.me);
        if (S.current === id) await loadDetail(true);
        render();
      }, 150);
    });
  };
  const loadList = async () => { S.sessions = await api('GET', '/api/sessions'); };
  const loadDetail = async (keep) => {
    if (S.current === null) { S.detail = null; return; }
    try { S.detail = await api('GET', `/api/sessions/${S.current}`); } catch (e) { if (!keep) toast(e.message, true); }
  };
  const open = async (id) => {
    S.current = id; S.to = 'both';
    await loadDetail();
    render(true);
  };

  const filtered = () => S.sessions.filter((s) => S.filter === 'all' || (S.filter === 'live' ? ['running', 'paused', 'waiting_user'].includes(s.state) : ['finished', 'stopped'].includes(s.state)));

  const render = (scrollEnd) => {
    const oldFlow = document.querySelector('.flow');
    const stick = !oldFlow || scrollEnd || oldFlow.scrollHeight - oldFlow.scrollTop - oldFlow.clientHeight < 80;
    const keepList = document.querySelector('.items');
    const listTop = keepList ? keepList.scrollTop : 0;
    const ta = document.querySelector('.composer textarea');
    if (ta) S.draft = ta.value;
    const shell = h('div', { class: 'shell' + (S.current !== null ? ' inchat' : '') }, rail(), listPane(), chatPane(), bottomBar());
    $app.replaceChildren(shell);
    const f = document.querySelector('.flow');
    if (f && stick) f.scrollTop = f.scrollHeight;
    const it = document.querySelector('.items');
    if (it) it.scrollTop = listTop;
    const t2 = document.querySelector('.composer textarea');
    if (t2 && S.draft) { t2.value = S.draft; }
  };

  const FILTERS = [['all', 'Tutte'], ['live', 'Attive'], ['done', 'Concluse']];
  const rail = () => h('nav', { class: 'rail' },
    FILTERS.map(([k, label]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; render(); } }, label)),
    h('div', { class: 'sp' }),
    h('button', { onclick: profileSheet }, avatarEl('user', S.me.name, 'sm'), S.me.name));

  const bottomBar = () => h('nav', { class: 'bottom' },
    FILTERS.map(([k, label]) => h('button', { class: S.filter === k ? 'on' : '', onclick: () => { S.filter = k; S.current = null; S.detail = null; render(); } }, label)),
    h('button', { onclick: profileSheet }, 'Profilo'));

  const budgetBanner = () => {
    const b = S.me.budget;
    if (b.level === 'ok') return null;
    const txt = b.level === 'tetto' ? `Tetto settimanale raggiunto: £${b.spent.toFixed(2)} di £${b.weekly.toFixed(2)}. Le nuove discussioni sono bloccate.`
      : `Hai usato ${b.level}% del budget settimanale (£${b.spent.toFixed(2)} di £${b.weekly.toFixed(2)}).`;
    return h('div', { class: 'banner' + (b.level === '80' || b.level === 'tetto' ? ' hot' : ''), text: txt });
  };

  const stBadge = (state) => h('span', { class: 'st' + (state === 'running' ? ' run' : state === 'waiting_user' ? ' wait' : ''), text: STATES[state] || state });

  const listPane = () => {
    const items = filtered();
    return h('section', { class: 'list' },
      h('header', {}, h('h2', { text: 'AI Bridge' }), h('button', { class: 'plus', onclick: newSheet, 'aria-label': 'Nuova discussione' }, '+')),
      budgetBanner(),
      h('div', { class: 'items' },
        items.length ? items.map((s) => h('button', { class: 'item' + (s.id === S.current ? ' on' : ''), onclick: () => open(s.id) },
          h('div', { class: 'av' }, '💬'),
          h('div', { class: 't' }, h('b', { text: s.goal }), h('small', { text: s.preview || '—' })),
          h('div', {}, h('time', { text: hhmm(s.at) }), h('br'), stBadge(s.state)))) : h('div', { class: 'empty', text: 'Nessuna discussione. Tocca + per iniziare.' })));
  };

  const MODE_LABEL = { autonoma: 'Autonoma', diretta: 'Diretta', ibrida: 'Ibrida' };
  const AGENT = { claude: 'Claude', chatgpt: 'ChatGPT' };

  const chatPane = () => {
    const d = S.detail;
    if (!d) return h('section', { class: 'chat' }, h('div', { class: 'chatempty', text: 'Scegli una discussione' }));
    const live = d.live;
    const canWrite = live && d.mode !== 'autonoma' && !['waiting_user'].includes(d.state) && !(d.mode === 'ibrida' && ['finished', 'stopped'].includes(d.state)) && !(d.mode === 'diretta' && d.state === 'running');
    const bar = h('div', { class: 'bar' },
      ['autonoma', 'diretta', 'ibrida'].map((m) => h('button', { class: 'pill' + (d.mode === m ? ' on' : ''), disabled: !live, onclick: () => act(() => api('POST', `/api/sessions/${d.id}/mode`, { mode: m })) }, MODE_LABEL[m])),
      live && d.state === 'running' ? h('button', { class: 'pill', onclick: () => act(() => api('POST', `/api/sessions/${d.id}/pause`, {})) }, '⏸ Pausa') : null,
      live && d.state === 'paused' ? h('button', { class: 'pill', onclick: () => act(() => api('POST', `/api/sessions/${d.id}/resume`, {})) }, '▶ Riprendi') : null,
      live && ['running', 'paused', 'waiting_user'].includes(d.state) ? h('button', { class: 'pill danger', onclick: () => act(() => api('POST', `/api/sessions/${d.id}/stop`, {})) }, '■ Ferma') : null,
      h('button', { class: 'pill', onclick: summarySheet }, 'Riepilogo'));
    const sub = `${STATES[d.state] || d.state}${d.stopReason ? ' · ' + (REASONS[d.stopReason] || d.stopReason) : ''} · turni ${d.turns}${d.maxTurns ? '/' + d.maxTurns : ''} · £${d.spentGbp.toFixed(2)}`;
    const flow = h('div', { class: 'flow' }, h('div', { class: 'title', text: d.goal }), h('div', { class: 'sub', text: sub }), bar);
    let lastDay = '';
    for (const m of d.messages) {
      const day = dayLabel(m.at);
      if (day !== lastDay) { flow.append(h('div', { class: 'datepill', text: day })); lastDay = day; }
      flow.append(messageEl(m, d));
    }
    if (d.state === 'running') flow.append(h('div', { class: 'sys', text: 'Le AI stanno scrivendo…' }));
    if (d.state === 'waiting_user' && live && d.question) flow.append(decisionEl(d));
    const top = h('div', { class: 'top' }, h('button', { class: 'back', onclick: () => { S.current = null; S.detail = null; render(); }, 'aria-label': 'Indietro' }, '‹'),
      h('div', { class: 'ctr' }, h('span', { class: 'pill', text: 'AI Bridge' })), h('span', { class: 'back' }));
    return h('section', { class: 'chat' }, top, flow, composerEl(d, canWrite));
  };

  const messageEl = (m, d) => {
    if (m.kind === 'system' || m.from === 'system') return h('div', { class: 'sys' }, md(m.text));
    if (m.kind === 'decision_request') return h('div', { class: 'sys' }, 'Decisione richiesta: ', md(m.text));
    const me = m.from === 'user';
    const who = me ? 'user' : m.from;
    const name = me ? S.me.name : AGENT[m.from] || m.from;
    const tagTxt = m.tag === 'accordo' ? 'accordo' : m.tag === 'disaccordo' ? 'disaccordo' : m.tag === 'non_verificato' ? 'da verificare' : '';
    const dest = me && m.to && m.to.length === 1 ? ` → ${AGENT[m.to[0]]}` : '';
    const nm = h('div', { class: 'nm' }, name + dest, tagTxt ? h('span', { class: 'tag ' + (m.tag === 'disaccordo' ? 'd' : m.tag === 'non_verificato' ? 'n' : ''), text: tagTxt }) : null);
    return h('div', { class: `msg ${me ? 'me' : ''} ${who}` }, avatarEl(who, S.me.name, 'sm'),
      h('div', { class: 'bub' }, nm, h('div', {}, md(m.text)), h('span', { class: 'at', text: hhmm(m.at) })));
  };

  const decisionEl = (d) => {
    const inp = h('input', { placeholder: 'La tua decisione…', maxlength: 2000 });
    const go = () => { const t = inp.value.trim(); if (t) act(() => api('POST', `/api/sessions/${d.id}/decision`, { text: t })); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'dec' }, h('b', { text: 'Serve la tua decisione' }), h('p', { text: d.question }), h('div', { class: 'row' }, inp, h('button', { class: 'btn', onclick: go }, 'Invia')));
  };

  const composerEl = (d, canWrite) => {
    const ta = h('textarea', { rows: 1, placeholder: canWrite ? `Scrivi come ${S.me.name}…` : '', maxlength: 4000, disabled: !canWrite });
    const why = !d.live ? 'Archiviata: sola lettura.' : d.mode === 'autonoma' ? 'Modalità Autonoma: le AI parlano da sole. Passa a Ibrida o Diretta per scrivere.'
      : d.state === 'waiting_user' ? 'Rispondi prima alla decisione richiesta.' : d.mode === 'diretta' && d.state === 'running' ? 'Metti in pausa per fare una domanda diretta.'
      : d.mode === 'ibrida' && ['finished', 'stopped'].includes(d.state) ? 'Discussione chiusa: passa a Diretta per fare domande.' : '';
    const order = ['both', 'claude', 'chatgpt'];
    const toLabel = { both: 'A: Entrambe', claude: 'A: Claude', chatgpt: 'A: ChatGPT' };
    const send = () => {
      const t = ta.value.trim();
      if (!t || !canWrite) return;
      act(async () => { await api('POST', `/api/sessions/${d.id}/message`, { text: t, to: S.to }); ta.value = ''; S.draft = ''; });
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isNarrow()) { e.preventDefault(); send(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    return h('div', {}, why ? h('div', { class: 'note', text: why }) : null,
      h('div', { class: 'composer', 'data-off': canWrite ? '0' : '1' },
        h('button', { class: 'to', onclick: () => { S.to = order[(order.indexOf(S.to) + 1) % 3]; render(); }, disabled: !canWrite }, toLabel[S.to]), ta,
        h('button', { class: 'send', onclick: send, disabled: !canWrite, 'aria-label': 'Invia' }, '➤')));
  };

  // ---------- sheet ----------
  const sheet = (...kids) => {
    const veil = h('div', { class: 'veil', onclick: (e) => { if (e.target === veil) veil.remove(); } }, h('div', { class: 'sheet' }, ...kids));
    document.body.append(veil);
    return veil;
  };

  const newSheet = () => {
    let mode = 'ibrida';
    const goal = h('textarea', { placeholder: 'Di cosa devono discutere Claude e ChatGPT?', maxlength: 2000 });
    const turns = h('select', {}, [4, 6, 8, 10, 14, 20].map((n) => h('option', { value: n, selected: n === 6 }, `${n} turni`)));
    const modes = h('div', { class: 'chips' });
    const paint = () => modes.replaceChildren(...['autonoma', 'diretta', 'ibrida'].map((m) => h('button', { class: 'pill' + (mode === m ? ' on' : ''), onclick: () => { mode = m; paint(); } }, MODE_LABEL[m])));
    paint();
    const chips = h('div', { class: 'chips' }, S.me.templates.map((t) => h('button', { class: 'pill', onclick: () => { goal.value = t.testo; goal.focus(); } }, t.titolo)));
    const veil = sheet(h('h3', { text: 'Nuova discussione' }), h('div', {}, h('label', { text: 'Modelli pronti' }), chips), h('div', {}, h('label', { text: 'Obiettivo' }), goal),
      h('div', {}, h('label', { text: 'Modalità' }), modes), h('div', {}, h('label', { text: 'Limite' }), turns),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => act(async () => {
        const r = await api('POST', '/api/sessions', { goal: goal.value, mode, maxTurns: Number(turns.value) });
        veil.remove(); await loadList(); await open(r.id);
      }) }, 'Avvia'), ' ', h('button', { class: 'btn alt', onclick: () => veil.remove() }, 'Annulla')));
  };

  const summarySheet = () => {
    const d = S.detail; if (!d) return;
    const r = d.report;
    const sec = (title, arr) => h('div', { class: 'sec' }, h('h4', { text: title }), arr.length ? h('ul', {}, arr.map((x) => h('li', {}, md(x)))) : h('small', { text: 'Niente per ora.' }));
    const veil = sheet(h('h3', { text: 'Riepilogo' }), sec('Fatti (accordi)', r.accordi), sec('Ipotesi da verificare', r.nonVerificato), sec('Disaccordi', r.disaccordi),
      sec(`Decisioni di ${S.me.name}`, r.decisioniUtente.map((x) => `${x.domanda} → ${x.risposta}`)),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `/api/sessions/${d.id}/report.txt`, download: `rapporto-${d.id}.txt` }, 'Scarica rapporto'), ' ', h('button', { class: 'btn alt', onclick: () => veil.remove() }, 'Chiudi')),
      h('small', { class: 'note', text: 'Il salvataggio su Drive parte solo se lo chiedi e lo autorizzi ogni volta.' }));
  };

  const profileSheet = () => {
    const me = S.me;
    const name = h('input', { value: me.name, maxlength: 30 });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden' });
    let target = 'user';
    file.addEventListener('change', () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        URL.revokeObjectURL(url);
        c.toBlob((blob) => act(async () => {
          const r = await fetch(`/api/avatar/${target}`, { method: 'PUT', body: blob });
          if (!r.ok) throw new Error((await r.json()).error || 'Foto non accettata.');
          S.me = await api('GET', '/api/me'); document.querySelector('.veil')?.remove(); render(); profileSheet();
        }), 'image/jpeg', 0.9);
      };
      img.onerror = () => toast('Non riesco a leggere questa immagine.', true);
      img.src = url;
    });
    const avBtn = (who, label) => h('div', {}, h('button', { class: `av big ${who}`, onclick: () => { target = who; file.click(); }, 'aria-label': `Cambia foto ${label}` }, S.me.avatars[who] ? h('img', { src: `/api/avatar/${who}?v=${S.me.avatars[who]}`, alt: '' }) : '+'), label);
    const b = me.budget;
    const veil = sheet(h('h3', { text: 'Profilo' }),
      h('div', { class: 'avrow' }, avBtn('user', me.name), avBtn('claude', 'Claude'), avBtn('chatgpt', 'ChatGPT')), file,
      h('div', {}, h('label', { text: 'Il tuo nome' }), name),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/api/profile', { name: name.value }); S.me = await api('GET', '/api/me'); veil.remove(); render(); }) }, 'Salva nome'), ' ',
        h('button', { class: 'btn alt', onclick: () => { veil.remove(); pinSheet(); } }, 'Cambia PIN')),
      h('div', {}, h('label', { text: 'Collegamenti' }),
        h('div', { class: me.connections.claude ? 'ok' : 'ko', text: `Claude: ${me.connections.claude ? 'chiave presente' : 'chiave mancante'}` }),
        h('div', { class: me.connections.chatgpt ? 'ok' : 'ko', text: `ChatGPT: ${me.connections.chatgpt ? 'accesso fatto' : 'accesso da fare'}` }),
        me.demo ? h('div', { text: 'Modalità prova: risposte simulate, nessun costo.' }) : null),
      h('div', {}, h('label', { text: 'Spesa settimanale' }), h('div', { text: `£${b.spent.toFixed(2)} di £${b.weekly.toFixed(2)}` })),
      h('div', { class: 'row' }, h('button', { class: 'btn alt', onclick: () => act(async () => { await api('POST', '/api/logout', {}); location.reload(); }) }, 'Esci'), ' ', h('button', { class: 'btn alt', onclick: () => veil.remove() }, 'Chiudi')),
      h('small', { class: 'note', text: 'Le foto restano su questo computer, non vanno su GitHub.' }));
  };

  const pinSheet = () => {
    const cur = h('input', { type: 'password', inputmode: 'numeric', maxlength: 4, placeholder: 'PIN attuale' });
    const nxt = h('input', { type: 'password', inputmode: 'numeric', maxlength: 4, placeholder: 'Nuovo PIN (4 cifre)' });
    const veil = sheet(h('h3', { text: 'Cambia PIN' }), cur, nxt,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/api/pin', { current: cur.value, next: nxt.value }); veil.remove(); toast('PIN cambiato.'); }) }, 'Salva'), ' ', h('button', { class: 'btn alt', onclick: () => veil.remove() }, 'Annulla')));
  };

  // ---------- avvio ----------
  (async () => {
    try {
      const info = await api('GET', '/api/public');
      if (info.authed) await start(); else pinScreen(info);
    } catch (e) { $app.replaceChildren(h('div', { class: 'pin' }, h('h1', { text: 'AI Bridge' }), h('p', { class: 'err', text: 'Il server non risponde. Controlla che sia avviato.' }))); }
  })();
})();
