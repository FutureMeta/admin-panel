/* MetaMC Console — dati, palette e logica condivisa fra le pagine.
   Caricato da ogni pagina in <helmet>; espone window.MetaMC. */
(function () {
  const SCREENS = [
    {id:'sistema', label:'Design system'},
    {id:'login', label:'Login'},
    {id:'invito', label:'Invito'},
    {id:'shell', label:'App shell'},
    {id:'panoramica', label:'Panoramica'},
    {id:'towny', label:'Dettaglio Towny'},
    {id:'utenti', label:'Utenti & Ruoli'},
    {id:'registro', label:'Registro attività'},
    {id:'responsive', label:'Responsive'}
  ];
  
  const MODES = [
    {key:'vw', name:'Vanilla War', color:'#E8822B', gray:'#9A9A9A', marker:'cerchio'},
    {key:'sv', name:'Survival', color:'#1F6E95', gray:'#5C5C5C', marker:'quadrato'},
    {key:'tw', name:'Towny', color:'#F2CC7B', gray:'#D2D2D2', marker:'triangolo'},
    {key:'oa', name:'Oasis', color:'#57B8A6', gray:'#7E7E7E', marker:'rombo'}
  ];
  
  const I = {
    grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    modes:'M4 20V11M9.3 20V4M14.7 20v-6M20 20v-9',
    report:'M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h5',
    users:'M16 20v-1.6a4 4 0 0 0-4-4H7.5a4 4 0 0 0-4 4V20M9.7 10.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2M17 10.5a3 3 0 1 0 0-6M20.5 20v-1.6a4 4 0 0 0-2.8-3.8',
    log:'M12 7.5V12l3 1.8M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z',
    search:'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
    bell:'M18.5 8.5a6.5 6.5 0 1 0-13 0c0 6.5-2.5 7.8-2.5 7.8h18s-2.5-1.3-2.5-7.8M13.8 20a2 2 0 0 1-3.6 0',
    chev:'M9 6l6 6-6 6',
    cal:'M3.5 9h17M7.5 3.5v3.5M16.5 3.5v3.5M5 5.5h14v15H5z',
    globe:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
    shield:'M12 21s7-3.2 7-9V5.6L12 3 5 5.6V12c0 5.8 7 9 7 9z',
    panel:'M4 4h16v16H4zM9.5 4v16'
  };
  const NAV = [
    { area:'Analisi', items:[
      { label:'Panoramica network', icon:I.grid, screen:'panoramica' },
      { label:'Dettaglio modalità', icon:I.modes, screen:'towny' }
    ]},
    { area:'Amministrazione', items:[
      { label:'Utenti & Ruoli', icon:I.users, screen:'utenti' },
      { label:'Registro attività', icon:I.log, screen:'registro' }
    ]}
  ];
  const BREAD = {
    shell:'App shell', panoramica:'Panoramica network', towny:'Dettaglio modalità · Towny',
    utenti:'Utenti & Ruoli', registro:'Registro attività'
  };
  const RAMP = ['#0F212A','#16394B','#1E5670','#4C6E72','#8A7147','#C08129','#F0A63F'];
  const fmt = n => Number(n).toLocaleString('it-IT');
  const hx = v => Math.round(v * 100) / 100;
  
  function lerpHex(a, b, t) {
    const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const [r1,g1,b1] = p(a), [r2,g2,b2] = p(b);
    const c = v => Math.round(v).toString(16).padStart(2,'0');
    return '#' + c(r1+(r2-r1)*t) + c(g1+(g2-g1)*t) + c(b1+(b2-b1)*t);
  }
  function rampColor(t) {
    const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(x));
    return lerpHex(RAMP[i], RAMP[i+1], x - i);
  }
  function linePath(pts) {
    let d = '', pen = false;
    pts.forEach(p => {
      if (!p) { pen = false; return; }
      d += (pen ? ' L' : ' M') + hx(p[0]) + ' ' + hx(p[1]);
      pen = true;
    });
    return d.trim();
  }
  function areaPath(pts, y0) {
    let d = '', run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      d += ' M' + hx(run[0][0]) + ' ' + y0;
      run.forEach(p => { d += ' L' + hx(p[0]) + ' ' + hx(p[1]); });
      d += ' L' + hx(run[run.length-1][0]) + ' ' + y0 + ' Z';
      run = [];
    };
    pts.forEach(p => { if (!p) flush(); else run.push(p); });
    flush();
    return d.trim();
  }
  function arcPath(cx, cy, r0, r1, a0, a1) {
    const P = (r, a) => [hx(cx + r*Math.cos(a)), hx(cy + r*Math.sin(a))];
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const [x1,y1] = P(r1,a0), [x2,y2] = P(r1,a1), [x3,y3] = P(r0,a1), [x4,y4] = P(r0,a0);
    return `M${x1} ${y1} A${r1} ${r1} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${r0} ${r0} 0 ${large} 0 ${x4} ${y4} Z`;
  }
  const HOURLY = [520,380,265,180,null,null,120,165,210,255,300,355,430,465,520,585,640,735,860,1010,1135,1204,1080,847];
  const SHARES = {vw:0.368, sv:0.285, tw:0.198, oa:0.128, other:0.021};
  const NOW_MODE = {vw:312, sv:241, tw:168, oa:108, other:18};
  const OTHER = {key:'other', name:'Altre modalità', color:'#8FA3AD', gray:'#8A8A8A', marker:'linea'};

  const PAGE_OF = {
    sistema:'0-design-system.dc.html', login:'1-login.dc.html', invito:'2-accettazione-invito.dc.html',
    shell:'3-app-shell.dc.html', panoramica:'4-panoramica-network.dc.html', towny:'5-dettaglio-modalita.dc.html',
    utenti:'6-utenti-e-ruoli.dc.html', registro:'7-registro-attivita.dc.html', responsive:'8-responsive.dc.html'
  };

  function hexField() {
    const out = [];
    const r = 46, dx = r * 1.5, dy = r * Math.sqrt(3);
    for (let c = -1; c < 14; c++) {
      for (let row = -1; row < 10; row++) {
        const cx = c * dx, cy = row * dy + (c % 2 ? dy / 2 : 0);
        const pts = [];
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 180 * (60 * i);
          pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
        }
        const d = Math.hypot(cx - 300, cy - 420) / 620;
        const t = Math.max(0, 1 - d);
        const seed = (c * 7 + row * 13) % 11;
        const accent = seed === 0 || seed === 6;
        out.push({
          points: pts.join(' '),
          fill: accent ? 'rgba(219,110,25,' + (0.05 * t).toFixed(3) + ')' : 'rgba(36,120,161,' + (0.045 * t).toFixed(3) + ')',
          stroke: accent ? 'rgba(219,110,25,' + (0.16 * t).toFixed(3) + ')' : 'rgba(255,255,255,' + (0.05 * t).toFixed(3) + ')'
        });
      }
    }
    return out;
  }
  function netStatus(ctx) {
    const s = ctx.props.statoNetwork || 'Online';
    if (s === 'Degradato') return { label:'Network degradato', sub:'1 nodo in errore · Oasis', color:'var(--warn)', soft:'var(--warn-soft)' };
    if (s === 'Offline') return { label:'Network offline', sub:'nessun nodo raggiungibile', color:'var(--err)', soft:'var(--err-soft)' };
    return { label:'Network online', sub:'4 modalità · 12 nodi', color:'var(--ok)', soft:'var(--ok-soft)' };
  }
  function overview(ctx) {
    const X0 = 56, X1 = 1108, Y0 = 16, Y1 = 268, MAX = 1350;
    const n = HOURLY.length;
    const xs = i => X0 + i * (X1 - X0) / (n - 1);
    const ys = v => Y1 - (v / MAX) * (Y1 - Y0);
    const hidden = ctx.state.hidden || {};

    const totalPts = HOURLY.map((v, i) => v == null ? null : [xs(i), ys(v)]);
    const prevPts = HOURLY.map((v, i) => {
      const base = v == null ? [180,150][i - 4] : v;
      return [xs(i), ys(base * (0.88 + 0.06 * Math.sin(i)))];
    });
    const modeSeries = [...MODES, OTHER].map(m => {
      const share = SHARES[m.key];
      const pts = HOURLY.map((v, i) => {
        if (v == null) return null;
        const drift = 1 + 0.12 * Math.sin(i / 3 + m.key.length);
        const val = i === n - 1 ? NOW_MODE[m.key] : v * share * drift;
        return [xs(i), ys(val)];
      });
      return { ...m, d: linePath(pts), opacity: hidden[m.key] ? 0 : 0.9 };
    });

    const yTicks = [0, 350, 700, 1050, 1350].map(v => ({ v, label: fmt(v), y: ys(v) }));
    const xTicks = [0,3,6,9,12,15,18,21,23].map(i => ({ x: xs(i), label: String(i).padStart(2,'0') + ':00' }));

    const heat = [];
    const days = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
    days.forEach((d, di) => {
      const cells = [];
      for (let h = 0; h < 24; h++) {
        const evening = Math.exp(-Math.pow(h - 21.3, 2) / 12);
        const afternoon = Math.exp(-Math.pow(h - 15.5, 2) / 26) * 0.55;
        const weekend = di >= 5 ? 1.24 : 1;
        const night = h < 6 ? 0.18 : 1;
        const t = Math.min(1, (evening + afternoon) * weekend * night * (0.92 + 0.1 * Math.sin(di * 2 + h)));
        const val = Math.round(t * 1310);
        cells.push({ h, val, label: fmt(val), color: rampColor(t * 0.98 + 0.02), t });
      }
      heat.push({ day: d, cells });
    });

    const daily = [];
    let ma = [];
    for (let i = 0; i < 30; i++) {
      const wk = [1,1.02,1.05,1.08,1.18,1.3,1.22][i % 7];
      const tot = i === 29 ? 3918 : Math.round((2650 + i * 22) * wk * (0.97 + 0.05 * Math.sin(i * 1.7)));
      const nuovi = i === 29 ? 214 : Math.round(tot * (0.052 + 0.014 * Math.sin(i * 0.9)));
      daily.push({ tot, nuovi, ret: tot - nuovi, i });
    }
    const dMax = 4600, bw = 26, bgap = 6;
    const dBars = daily.map(d => {
      const x = 44 + d.i * (bw + bgap);
      const hTot = (d.tot / dMax) * 190;
      const hNew = (d.nuovi / dMax) * 190;
      return { x, w: bw, yRet: 210 - hTot, hRet: hTot - hNew, yNew: 210 - hNew, hNew, ...d };
    });
    daily.forEach((d, i) => {
      const w = daily.slice(Math.max(0, i - 6), i + 1);
      ma.push([44 + i * (bw + bgap) + bw / 2, 210 - (w.reduce((s, x) => s + x.tot, 0) / w.length / dMax) * 190]);
    });

    const spark = (seed, up) => {
      const pts = [];
      for (let i = 0; i < 22; i++) {
        const v = 0.5 + 0.32 * Math.sin(i / 2.4 + seed) + (up ? i * 0.016 : -i * 0.012) + 0.08 * Math.sin(i * 1.7 + seed);
        pts.push([i * (86 / 21), 30 - Math.max(0.05, Math.min(0.95, v)) * 26]);
      }
      return linePath(pts);
    };

    const kpis = [
      {label:'Giocatori online ora', value:'847', unit:'gioc.', delta:'+6,4%', note:'vs stessa ora ieri', tone:'ok', d:spark(0.4,true)},
      {label:'Picco odierno', value:'1.204', unit:'gioc.', delta:'+2,1%', note:'alle 21:47', tone:'ok', d:spark(1.2,true)},
      {label:'Giocatori unici oggi', value:'3.918', unit:'gioc.', delta:'+4,8%', note:'vs ieri', tone:'ok', d:spark(2.1,true)},
      {label:'Nuovi giocatori oggi', value:'214', unit:'gioc.', delta:'+12,6%', note:'vs ieri', tone:'ok', d:spark(4.5,true)},
      {label:'Record storico', value:'2.615', unit:'gioc.', delta:'14/12/2025', note:'nessuna variazione', tone:'muted', d:spark(5.9,false)}
    ].map(k => ({
      ...k,
      color: k.tone === 'ok' ? 'var(--ok)' : k.tone === 'err' ? 'var(--err)' : 'var(--tx-muted)',
      soft: k.tone === 'ok' ? 'var(--ok-soft)' : k.tone === 'err' ? 'var(--err-soft)' : 'transparent'
    }));

    const dist = [
      {...MODES[0], online:312, quota:'36,8%', delta:'+1,4 pt', picco:'468', unici:'1.612', sess:'38m 04s'},
      {...MODES[1], online:241, quota:'28,5%', delta:'−0,6 pt', picco:'355', unici:'1.204', sess:'51m 22s'},
      {...MODES[2], online:168, quota:'19,8%', delta:'+0,9 pt', picco:'232', unici:'742', sess:'63m 41s'},
      {...MODES[3], online:108, quota:'12,8%', delta:'−1,7 pt', picco:'199', unici:'589', sess:'29m 55s'},
      {...OTHER, online:18, quota:'2,1%', delta:'+0,4 pt', picco:'34', unici:'96', sess:'12m 40s'}
    ];
    let a = -Math.PI / 2;
    const donut = dist.map(d => {
      const sweep = (d.online / 847) * Math.PI * 2;
      const seg = { color: d.color, d: arcPath(90, 90, 54, 76, a + 0.018, a + sweep - 0.018), name: d.name };
      a += sweep;
      return seg;
    });

    return {
      chartTotalArea: areaPath(totalPts, Y1),
      chartTotalLine: linePath(totalPts),
      chartPrev: linePath(prevPts),
      modeSeries,
      legend: [...[...MODES, OTHER].map(m => ({
        key: m.key, name: m.name, color: m.color,
        opacity: hidden[m.key] ? 0.35 : 1,
        go: () => ctx.setState(s => ({ hidden: { ...(s.hidden||{}), [m.key]: !(s.hidden||{})[m.key] } }))
      }))],
      yTicks, xTicks,
      gapX: xs(4) , gapW: xs(5) - xs(4) + (xs(1) - xs(0)),
      peakX: xs(21), peakY: ys(1204), peakLabelY: ys(1204) - 14,
      annos: [
        { x: xs(6), xLabel: xs(6) + 7, label: 'Riavvio programmato 06:00' },
        { x: xs(19), xLabel: xs(19) + 7, label: 'Torneo Vanilla War 19:00' }
      ],
      skeletons: [{w1:'42%', w2:'68%'}, {w1:'36%', w2:'54%'}, {w1:'40%', w2:'40%'}],
      iconSearch: I.search, iconChev: I.chev, iconBell: I.bell, iconGlobe: I.globe, iconCal: I.cal,
      heat, heatHours: [0,3,6,9,12,15,18,21].map(h => String(h).padStart(2,'0')),
      dBars, maPath: linePath(ma),
      kpis, dist, donut,
      countries: [
        {name:'Italia', share:71.4, val:'2.797'},
        {name:'Germania', share:4.1, val:'161'},
        {name:'Francia', share:3.2, val:'125'},
        {name:'Spagna', share:2.8, val:'110'},
        {name:'Svizzera', share:2.1, val:'82'},
        {name:'Regno Unito', share:1.9, val:'74'},
        {name:'Romania', share:1.6, val:'63'},
        {name:'Albania', share:1.3, val:'51'},
        {name:'Paesi Bassi', share:1.1, val:'43'},
        {name:'Belgio', share:0.9, val:'35'}
      ].map(c => ({ ...c, bar: (c.share / 71.4 * 100).toFixed(1) + '%', pct: c.share.toFixed(1).replace('.', ',') + '%', color: rampColor(0.25 + c.share / 90) })),
      regions: [
        {name:'Lombardia', pct:'18,2%', w:'100%'},
        {name:'Lazio', pct:'11,4%', w:'63%'},
        {name:'Campania', pct:'9,8%', w:'54%'},
        {name:'Veneto', pct:'8,1%', w:'45%'},
        {name:'Sicilia', pct:'7,6%', w:'42%'},
        {name:'Piemonte', pct:'6,9%', w:'38%'},
        {name:'Emilia-Romagna', pct:'6,4%', w:'35%'},
        {name:'Puglia', pct:'5,7%', w:'31%'}
      ],
      clientVersions: [
        {name:'1.21.x', pct:'52,1%', w:'100%'},
        {name:'1.20.x', pct:'26,8%', w:'51%'},
        {name:'1.19.x', pct:'11,3%', w:'22%'},
        {name:'1.8.9', pct:'6,9%', w:'13%'},
        {name:'Altre', pct:'2,9%', w:'6%'}
      ]
    };
  }
  function admin(ctx) {
    const TW = '#F2CC7B';
    const lvl = ['Nessuno','Lettura','Scrittura','Gestione'];
    const mkRow = (module, level) => ({
      module,
      cells: lvl.map(l => ({
        on: l === level,
        bg: l === level ? 'var(--ac-soft)' : 'transparent',
        dot: l === level ? 'var(--ac)' : 'var(--bd-strong)',
        fg: l === level ? 'var(--ac-text)' : 'var(--tx-disabled)'
      }))
    });
    const users = [
      {name:'Vally90', real:'vally90@metamc.it', role:'Founder', rc:'var(--ac-text)', rs:'var(--ac-soft)', mods:'Tutti i moduli', last:'oggi, 23:04', st:'Attivo', sc:'var(--ok)', ss:'var(--ok-soft)', skin:'#8B5E34', ini:'VA'},
      {name:'Psicosi', real:'psicosi@metamc.it', role:'Owner', rc:'var(--ac-text)', rs:'var(--ac-soft)', mods:'Tutti i moduli', last:'oggi, 22:41', st:'Attivo', sc:'var(--ok)', ss:'var(--ok-soft)', skin:'#2F6E8F', ini:'PS'},
      {name:'SadKiwi', real:'sadkiwi@metamc.it', role:'Sr. Admin', rc:'var(--info)', rs:'var(--info-soft)', mods:'6 moduli', last:'oggi, 19:12', st:'Attivo', sc:'var(--ok)', ss:'var(--ok-soft)', skin:'#3E7C63', ini:'SA'},
      {name:'sbrodino', real:'sbrodino@metamc.it', role:'Developer', rc:'var(--tx-secondary)', rs:'var(--s-inset)', mods:'5 moduli', last:'ieri, 03:27', st:'Attivo', sc:'var(--ok)', ss:'var(--ok-soft)', skin:'#A8434F', ini:'SB'},
      {name:'Miky88', real:'miky88@metamc.it', role:'Moderatore', rc:'var(--tx-secondary)', rs:'var(--s-inset)', mods:'2 moduli', last:'mai', st:'Invito in attesa', sc:'var(--info)', ss:'var(--info-soft)', skin:'#6B5AA6', ini:'MI'}
    ];
    const logs = [
      {id:'l1', t:'23:04:18', d:'16/08/2026', actor:'Vally90', skin:'#8B5E34', ini:'VA', act:'Ruolo modificato', obj:'Admin modalità', ip:'93.51.14.7', sens:true},
      {id:'l2', t:'22:47:02', d:'16/08/2026', actor:'Psicosi', skin:'#2F6E8F', ini:'PS', act:'Invito inviato', obj:'kryos@metamc.it', ip:'185.62.44.19', sens:false},
      {id:'l3', t:'22:12:55', d:'16/08/2026', actor:'sbrodino', skin:'#A8434F', ini:'SB', act:'Export CSV', obj:'Andamento online · 30g', ip:'2.44.108.51', sens:false},
      {id:'l4', t:'21:58:31', d:'16/08/2026', actor:'Vally90', skin:'#8B5E34', ini:'VA', act:'Accesso revocato', obj:'sbrodino · Ban manager', ip:'93.51.14.7', sens:true},
      {id:'l5', t:'20:33:09', d:'16/08/2026', actor:'SadKiwi', skin:'#3E7C63', ini:'SA', act:'Annotazione aggiunta', obj:'Riavvio Towny 20:30', ip:'79.24.201.88', sens:false}
    ];
    const open = ctx.state.logOpen;

    const tSpark = (seed, up) => {
      const pts = [];
      for (let i = 0; i < 22; i++) {
        const v = 0.5 + 0.3 * Math.sin(i / 2.4 + seed) + (up ? i * 0.015 : -i * 0.011) + 0.07 * Math.sin(i * 1.7 + seed);
        pts.push([i * (86 / 21), 30 - Math.max(0.05, Math.min(0.95, v)) * 26]);
      }
      return linePath(pts);
    };
    const tHeat = [];
    ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'].forEach((d, di) => {
      const cells = [];
      for (let h = 0; h < 24; h++) {
        const evening = Math.exp(-Math.pow(h - 21.1, 2) / 13);
        const afternoon = Math.exp(-Math.pow(h - 16, 2) / 30) * 0.6;
        const weekend = di >= 5 ? 1.2 : 1;
        const night = h < 6 ? 0.2 : 1;
        const t = Math.min(1, (evening + afternoon) * weekend * night * (0.9 + 0.12 * Math.sin(di * 1.6 + h)));
        const val = Math.round(t * 258);
        cells.push({ h, val, label: fmt(val), color: rampColor(t * 0.98 + 0.02), t });
      }
      tHeat.push({ day: d, cells });
    });
    const tDaily = [];
    const tMa = [];
    for (let i = 0; i < 30; i++) {
      const wk = [1,1.02,1.06,1.09,1.2,1.32,1.24][i % 7];
      const tot = i === 29 ? 742 : Math.round((520 + i * 4.2) * wk * (0.96 + 0.06 * Math.sin(i * 1.4)));
      const nuovi = i === 29 ? 61 : Math.round(tot * (0.062 + 0.016 * Math.sin(i * 0.8)));
      tDaily.push({ tot, nuovi, ret: tot - nuovi, i });
    }
    const tMax = 950, tbw = 26, tbgap = 6;
    const tBars = tDaily.map(d => {
      const x = 44 + d.i * (tbw + tbgap);
      const hTot = (d.tot / tMax) * 190;
      const hNew = (d.nuovi / tMax) * 190;
      return { x, w: tbw, yRet: 210 - hTot, hRet: hTot - hNew, yNew: 210 - hNew, hNew, ...d };
    });
    tDaily.forEach((d, i) => {
      const w = tDaily.slice(Math.max(0, i - 6), i + 1);
      tMa.push([44 + i * (tbw + tbgap) + tbw / 2, 210 - (w.reduce((s, x) => s + x.tot, 0) / w.length / tMax) * 190]);
    });

    return {
      townyKpis: [
        {label:'Giocatori online ora', value:'168', unit:'gioc.', delta:'+3,1%', note:'vs stessa ora ieri', tone:'ok', d:tSpark(0.4,true)},
        {label:'Picco odierno', value:'232', unit:'gioc.', delta:'+1,8%', note:'alle 21:40', tone:'ok', d:tSpark(1.2,true)},
        {label:'Giocatori unici oggi', value:'742', unit:'gioc.', delta:'+6,8%', note:'vs ieri', tone:'ok', d:tSpark(2.1,true)},
        {label:'Nuovi giocatori oggi', value:'61', unit:'gioc.', delta:'+9,4%', note:'vs ieri', tone:'ok', d:tSpark(4.5,true)},
        {label:'Record storico', value:'604', unit:'gioc.', delta:'02/01/2026', note:'nessuna variazione', tone:'muted', d:tSpark(5.9,false)}
      ].map(k => ({
        ...k,
        color: k.tone === 'ok' ? 'var(--ok)' : k.tone === 'err' ? 'var(--err)' : 'var(--tx-muted)',
        soft: k.tone === 'ok' ? 'var(--ok-soft)' : k.tone === 'err' ? 'var(--err-soft)' : 'transparent'
      })),
      townyHeat: tHeat,
      townyBars: tBars,
      townyMaPath: linePath(tMa),
      townyCountries: [
        {name:'Italia', share:72.1, val:'535'},
        {name:'Germania', share:4.4, val:'33'},
        {name:'Francia', share:3.1, val:'23'},
        {name:'Spagna', share:2.6, val:'19'},
        {name:'Svizzera', share:2.2, val:'16'},
        {name:'Romania', share:1.9, val:'14'},
        {name:'Regno Unito', share:1.6, val:'12'},
        {name:'Albania', share:1.3, val:'10'},
        {name:'Paesi Bassi', share:1.1, val:'8'},
        {name:'Belgio', share:0.8, val:'6'}
      ].map(c => ({ ...c, pct: c.share.toFixed(1).replace('.', ',') + '%', color: rampColor(0.25 + c.share / 90) })),
      townyMetrics: [
        {k:'Chunk rivendicati', v:'38.412', d:'+1.204 · 7g'},
        {k:'Nuove città (7g)', v:'12', d:'−3 vs settimana prec.'},
        {k:'Città abbandonate (7g)', v:'8', d:'+2 vs settimana prec.'},
        {k:'Saldo economico città', v:'4,2 Mln', d:'+3,1% · 7g'}
      ],
      townyTop: [
        {p:'1', name:'LucaFerraro', skin:'#8B5E34', ini:'LU', h:'214h 32m', s:'89 sessioni', w:'100%'},
        {p:'2', name:'Sara_Bellini', skin:'#A8434F', ini:'SA', h:'198h 04m', s:'102 sessioni', w:'92%'},
        {p:'3', name:'MatteoRinaldi', skin:'#2F6E8F', ini:'MA', h:'181h 47m', s:'76 sessioni', w:'85%'},
        {p:'4', name:'NikoDeLuca', skin:'#3E7C63', ini:'NI', h:'163h 12m', s:'71 sessioni', w:'76%'},
        {p:'5', name:'Giulia_Conti', skin:'#6B5AA6', ini:'GI', h:'149h 58m', s:'94 sessioni', w:'70%'},
        {p:'6', name:'AlessioMarchetti', skin:'#B07A2E', ini:'AL', h:'138h 21m', s:'63 sessioni', w:'64%'},
        {p:'7', name:'ChiaraGrasso', skin:'#4F7F8C', ini:'CH', h:'126h 09m', s:'58 sessioni', w:'59%'},
        {p:'8', name:'FedericoBenini', skin:'#8A5A75', ini:'FE', h:'119h 44m', s:'51 sessioni', w:'56%'}
      ],
      townyColor: TW,
      users,
      userFilters: ['Tutti gli stati','Tutti i ruoli','Tutti i moduli'],
      permLevels: lvl,
      permGroups: [
        {area:'Analisi', rows:[mkRow('Panoramica network','Lettura'), mkRow('Dettaglio modalità','Scrittura')]},
        {area:'Amministrazione', rows:[mkRow('Utenti & Ruoli','Nessuno'), mkRow('Registro attività','Lettura')]}
      ],
      logs: logs.map(l => ({
        ...l,
        toggle: () => ctx.setState(s => ({logOpen: s.logOpen === l.id ? null : l.id})),
        open: open === l.id,
        rot: open === l.id ? 'rotate(90deg)' : 'none',
        bg: open === l.id ? 'var(--s-inset)' : 'transparent'
      })),
      logFilters: ['Tutti gli utenti','Tutti i moduli','Tutte le azioni','16/08/2026'],
      pendingInvites: [
        {mail:'miky88@metamc.it', role:'Moderatore', by:'Psicosi', exp:'scade tra 4 giorni', c:'var(--info)'},
        {mail:'zenith@metamc.it', role:'Sr. Admin', by:'Vally90', exp:'scade tra 6 giorni', c:'var(--info)'},
        {mail:'ops@metamc.it', role:'Developer', by:'Vally90', exp:'scaduto il 12/08', c:'var(--err)'}
      ],
      sessions: [
        {who:'Vally90', skin:'#8B5E34', ini:'VA', ip:'93.51.14.7', ua:'Chrome 128 · macOS', when:'attiva ora'},
        {who:'Psicosi', skin:'#2F6E8F', ini:'PS', ip:'185.62.44.19', ua:'Firefox 130 · Windows', when:'da 2h 14m'},
        {who:'sbrodino', skin:'#A8434F', ini:'SB', ip:'2.44.108.51', ua:'Chrome 128 · Linux', when:'da 41m'}
      ],
      inviteOpen: !!ctx.state.invite,
      stop: (e) => e.stopPropagation(),
      newModeOpen: !!ctx.state.newMode,
      toggleNewMode: () => ctx.setState(s => ({newMode: !s.newMode})),
      newModeColor: ctx.state.newColor || '#9B8FD9',
      newModeColors: [
        '#E8822B','#F2A65A','#D9B44A','#F2CC7B','#8FBF6A','#57B8A6','#2FA189','#5FB0C9',
        '#3FA3D4','#1F6E95','#6E86C9','#9B8FD9','#B884D4','#C4566A','#E0736F','#B0603A',
        '#8FA3AD','#6E828C','#C9D3D8','#4C6E72'
      ].map(hex => ({
        hex,
        go: () => ctx.setState({newColor: hex}),
        ring: hex === (ctx.state.newColor || '#9B8FD9') ? '0 0 0 2px var(--s-elevated),0 0 0 4px var(--ac)' : 'none'
      })),
      serverModes: ['Elenco server','Pattern sul nome'].map(l => ({
        label: l,
        go: () => ctx.setState({src: l === 'Elenco server' ? 'lista' : 'pattern'}),
        bg: (ctx.state.src || 'lista') === (l === 'Elenco server' ? 'lista' : 'pattern') ? 'var(--s-overlay)' : 'transparent',
        fg: (ctx.state.src || 'lista') === (l === 'Elenco server' ? 'lista' : 'pattern') ? 'var(--tx-primary)' : 'var(--tx-muted)'
      })),
      srcIsList: (ctx.state.src || 'lista') === 'lista',
      srcIsPattern: ctx.state.src === 'pattern',
      serverChips: ['duels_1','duels_2'],
      matchOp: ctx.state.matchOp || 'Inizia con',
      matchHint: 'Tutti i server il cui nome ' + ({'Inizia con':'inizia con','Contiene':'contiene','Finisce con':'finisce con'}[ctx.state.matchOp || 'Inizia con']) + ' questa stringa vengono sommati in un unico valore.',
      matchMenuOpen: !!ctx.state.matchMenu,
      toggleMatchMenu: () => ctx.setState(s => ({matchMenu: !s.matchMenu})),
      matchOps: ['Inizia con','Contiene','Finisce con'].map(l => ({
        label: l,
        go: () => ctx.setState({matchOp: l, matchMenu: false}),
        bg: l === (ctx.state.matchOp || 'Inizia con') ? 'var(--ac-soft)' : 'transparent',
        fg: l === (ctx.state.matchOp || 'Inizia con') ? 'var(--ac-text)' : 'var(--tx-secondary)'
      })),
      patternMatches: ['duels_1','duels_2','duels_3','duels_eu'],
      userMenuOpen: !!ctx.state.userMenu,
      userMenuRot: ctx.state.userMenu ? 'rotate(-90deg)' : 'rotate(90deg)',
      toggleUserMenu: () => ctx.setState(s => ({userMenu: !s.userMenu})),
      toggleInvite: () => ctx.setState(s => ({invite: !s.invite})),
      respKpis: [
        {label:'Online', value:'847', delta:'+6,4%', dc:'var(--ok)'},
        {label:'Picco', value:'1.204', delta:'21:47', dc:'var(--tx-muted)'},
        {label:'Unici', value:'3.918', delta:'+2,1%', dc:'var(--ok)'},
        {label:'Sessione', value:'42m', delta:'−1m', dc:'var(--err)'},
        {label:'Nuovi', value:'214', delta:'+18', dc:'var(--ok)'},
        {label:'Record', value:'2.361', delta:'14/03', dc:'var(--tx-muted)'}
      ],
      respKpisMob: [
        {label:'Picco odierno', value:'1.204', delta:'21:47', dc:'var(--tx-muted)'},
        {label:'Unici oggi', value:'3.918', delta:'+2,1%', dc:'var(--ok)'},
        {label:'Sessione media', value:'42m 18s', delta:'−1m 04s', dc:'var(--err)'},
        {label:'Nuovi oggi', value:'214', delta:'+18 vs ieri', dc:'var(--ok)'}
      ],
      respModes: [
        {name:'Vanilla War', color:'#E8822B', online:'312', w:'100%'},
        {name:'Survival', color:'#1F6E95', online:'241', w:'77%'},
        {name:'Towny', color:'#F2CC7B', online:'168', w:'54%'},
        {name:'Oasis', color:'#57B8A6', online:'108', w:'35%'},
        {name:'Altre modalità', color:'#8FA3AD', online:'18', w:'6%'}
      ],
      respBands: [
        {h:'21:00–22:00', v:'1.198', w:'100%', c:'#F0A63F'},
        {h:'20:00–21:00', v:'1.064', w:'89%', c:'#C08129'},
        {h:'22:00–23:00', v:'972', w:'81%', c:'#8A7147'}
      ],
      respTabs: [
        {label:'Panoramica', icon:I.grid, fg:'var(--ac-text)'},
        {label:'Modalità', icon:I.modes, fg:'var(--tx-muted)'},
        {label:'Registro', icon:I.log, fg:'var(--tx-muted)'},
        {label:'Utenti', icon:I.users, fg:'var(--tx-muted)'}
      ],
      inviteModuleRows: [
        {m:'Panoramica network', l:'Lettura'},
        {m:'Dettaglio modalità', l:'Lettura'},
        {m:'Registro attività', l:'Nessuno'}
      ]
    };
  }
  function baseVals(ctx, forced) {
    const scr = forced || ctx.state.screen;
    const ls = ctx.state.loginState;
    const theme = ctx.state.theme || (ctx.props.tema === 'Chiaro' ? 'light' : 'dark');
    const col = ctx.state.collapsedOverride === null ? !!ctx.props.sidebarCollassata : ctx.state.collapsedOverride;
    const net = netStatus(ctx);
    const LSTATES = [
      {id:'default', label:'Credenziali'},
      {id:'error', label:'Errore'},
      {id:'sospeso', label:'Sospeso'},
      {id:'2fa', label:'2FA'}
    ];
    const screens = SCREENS.map(s => ({
      ...s,
      go: () => ctx.setState({screen:s.id}),
      bg: s.id===scr ? 'var(--ac-soft)' : 'transparent',
      fg: s.id===scr ? 'var(--ac-text)' : 'var(--tx-secondary)',
      bd: s.id===scr ? 'rgba(219,110,25,.45)' : 'var(--bd-subtle)'
    }));

    return {
      theme,
      rootRef: ctx.rootRef,
      netLabel: net.label, netSub: net.sub, netColor: net.color, netSoft: net.soft,
      themeLabel: theme === 'dark' ? 'scuro' : 'chiaro',
      toggleTheme: () => ctx.setState({theme: theme === 'dark' ? 'light' : 'dark'}),
      screens,
      isSistema: scr === 'sistema',
      isLogin: scr === 'login',
      isInvito: scr === 'invito',
      inApp: ['shell','panoramica','towny','utenti','registro'].indexOf(scr) >= 0,
      isShellDoc: scr === 'shell',
      isPanoramica: scr === 'panoramica',
      isTowny: scr === 'towny',
      isUtenti: scr === 'utenti',
      isRegistro: scr === 'registro',
      isResponsive: scr === 'responsive',
      collapsed: col,
      sidebarW: col ? '68px' : '248px',
      navGroups: NAV.map(g => ({
        area: g.area,
        items: g.items.map(it => ({
          ...it,
          go: () => ctx.setState({screen: it.screen}),
          href: PAGE_OF[it.screen] || '#',
          bg: it.screen === scr ? 'var(--ac-soft)' : 'transparent',
          fg: it.screen === scr ? 'var(--ac-text)' : 'var(--tx-secondary)',
          bar: it.screen === scr ? 'var(--ac)' : 'transparent'
        }))
      })),
      toggleSidebar: () => ctx.setState({collapsedOverride: !col}),
      showLabels: !col,
      periods: ['24h','7g','30g','90g','1y'].map(p => ({
        label: p,
        go: () => ctx.setState({period:p}),
        bg: p === ctx.state.period ? 'var(--s-overlay)' : 'transparent',
        fg: p === ctx.state.period ? 'var(--tx-primary)' : 'var(--tx-muted)'
      })),
      showFilters: scr !== 'utenti' && scr !== 'registro',
      modeTabs: MODES.map(m => ({
        name: m.name,
        go: () => ctx.setState({modeSel: m.name}),
        dot: m.color,
        bg: m.name === 'Towny' ? 'var(--s-overlay)' : 'transparent',
        fg: m.name === 'Towny' ? 'var(--tx-primary)' : 'var(--tx-muted)'
      })),
      periodLabel: ctx.state.period,
      modeSel: ctx.state.modeSel,
      breadcrumb: BREAD[scr] || 'Console',
      togglePalette: () => ctx.setState(s => ({palette: !s.palette})),
      paletteOpen: !!ctx.state.palette,
      paletteItems: [
        {icon:'search', label:'Vai a Panoramica network', hint:'G poi P'},
        {icon:'modes', label:'Filtra su Towny', hint:'M poi T'},
        {icon:'users', label:'Invita utente…', hint:'I'},
        {icon:'report', label:'Esporta CSV del widget attivo', hint:'⌘E'},
        {icon:'log', label:'Apri registro attività', hint:'G poi R'}
      ],
      ...overview(ctx),
      ...admin(ctx),
      loginStates: LSTATES.map(s => ({
        ...s,
        go: () => ctx.setState({loginState:s.id}),
        bg: s.id===ls ? 'var(--ac-soft)' : 'var(--s-elevated)',
        fg: s.id===ls ? 'var(--ac-text)' : 'var(--tx-secondary)',
        bd: s.id===ls ? 'rgba(219,110,25,.45)' : 'var(--bd-subtle)'
      })),
      showCreds: ls !== '2fa',
      is2fa: ls === '2fa',
      isError: ls === 'error',
      isSospeso: ls === 'sospeso',
      fieldBorder: ls === 'error' ? 'rgba(219,52,52,.55)' : 'var(--bd-subtle)',
      goto2fa: () => ctx.setState({loginState:'2fa'}),
      backToCreds: () => ctx.setState({loginState:'default'}),
      otpCells: ['4','8','1','5','',''].map((v, i) => ({
        v,
        bd: i === 4 ? 'var(--ac)' : 'var(--bd-subtle)',
        ring: i === 4 ? '0 0 0 3px var(--ac-soft)' : 'none'
      })),
      hexField: hexField(),
      loginStats: [
        {value:'847', label:'online adesso'},
        {value:'4', label:'modalità attive'},
        {value:'2022', label:'dal'}
      ],
      inviteModules: [
        {name:'Panoramica network', level:'Lettura', color:'var(--info)', soft:'var(--info-soft)'},
        {name:'Dettaglio modalità', level:'Lettura', color:'var(--info)', soft:'var(--info-soft)'},
        {name:'Registro attività', level:'Lettura', color:'var(--info)', soft:'var(--info-soft)'}
      ],
      modes: MODES,
      surfaces: [
        {name:'Base', token:'--s-base', val:'var(--s-base)'},
        {name:'Surface', token:'--s-surface', val:'var(--s-surface)'},
        {name:'Elevated', token:'--s-elevated', val:'var(--s-elevated)'},
        {name:'Overlay', token:'--s-overlay', val:'var(--s-overlay)'},
        {name:'Inset', token:'--s-inset', val:'var(--s-inset)'}
      ],
      roleColors: [
        {name:'Testo primario', token:'--tx-primary', val:'var(--tx-primary)'},
        {name:'Testo secondario', token:'--tx-secondary', val:'var(--tx-secondary)'},
        {name:'Testo muted', token:'--tx-muted', val:'var(--tx-muted)'},
        {name:'Testo disabled', token:'--tx-disabled', val:'var(--tx-disabled)'},
        {name:'Accento', token:'--ac', val:'var(--ac)'},
        {name:'Accento hover', token:'--ac-hover', val:'var(--ac-hover)'},
        {name:'Accento pressed', token:'--ac-pressed', val:'var(--ac-pressed)'},
        {name:'Accento soft', token:'--ac-soft', val:'var(--ac-soft)'},
        {name:'Blu brand', token:'--blu', val:'var(--blu)'},
        {name:'Blu data-viz', token:'--blu-viz', val:'var(--blu-viz)'},
        {name:'Success', token:'--ok', val:'var(--ok)'},
        {name:'Warning', token:'--warn', val:'var(--warn)'},
        {name:'Danger', token:'--err', val:'var(--err)'},
        {name:'Info', token:'--info', val:'var(--info)'},
        {name:'Bordo subtle', token:'--bd-subtle', val:'var(--bd-subtle)'},
        {name:'Bordo strong', token:'--bd-strong', val:'var(--bd-strong)'}
      ],
      categorical: ['#E8822B','#1F6E95','#F2CC7B','#57B8A6','#9B8FD9','#C4566A','#8FA3AD','#D9E2E7'],
      ramp: ['#0F212A','#16394B','#1E5670','#4C6E72','#8A7147','#C08129','#F0A63F'],
      diverging: ['#1F6E95','#3E7E96','#5E8391','#33454E','#B0793F','#D07A2C','#E8822B'],
      typeScale: [
        {token:'--t-display', family:'var(--font-display)', size:'34px', lh:'40px', weight:'700', ls:'-.02em', sample:'847 online', spec:'Montserrat 34/40 700 -2%'},
        {token:'--t-h1', family:'var(--font-display)', size:'24px', lh:'32px', weight:'700', ls:'-.01em', sample:'Panoramica network', spec:'Montserrat 24/32 700 -1%'},
        {token:'--t-h2', family:'var(--font-display)', size:'18px', lh:'26px', weight:'600', ls:'0', sample:'Andamento online', spec:'Montserrat 18/26 600'},
        {token:'--t-h3', family:'var(--font-ui)', size:'15px', lh:'22px', weight:'600', ls:'0', sample:'Distribuzione per modalità', spec:'Inter 15/22 600'},
        {token:'--t-body', family:'var(--font-ui)', size:'14px', lh:'22px', weight:'400', ls:'0', sample:'Popolazione corrente ripartita per modalità di gioco.', spec:'Inter 14/22 400'},
        {token:'--t-sm', family:'var(--font-ui)', size:'13px', lh:'20px', weight:'400', ls:'0', sample:'Ultimo aggiornamento 12 secondi fa', spec:'Inter 13/20 400'},
        {token:'--t-micro', family:'var(--font-ui)', size:'11px', lh:'14px', weight:'600', ls:'.1em', sample:'PICCO ODIERNO', spec:'Inter 11/14 600 +10% maiuscolo'},
        {token:'--t-mono', family:'var(--font-mono)', size:'12px', lh:'18px', weight:'400', ls:'0', sample:'a3f9-1c04-88de · 93.51.14.7', spec:'JetBrains Mono 12/18 400'}
      ],
      spacing: [
        {token:'--sp1', val:'4px'},{token:'--sp2', val:'8px'},{token:'--sp3', val:'12px'},
        {token:'--sp4', val:'16px'},{token:'--sp6', val:'24px'},{token:'--sp8', val:'32px'},
        {token:'--sp12', val:'48px'},{token:'--sp16', val:'64px'}
      ],
      radii: [{val:'4px'},{val:'6px'},{val:'8px'},{val:'12px'},{val:'16px'}],
      elevations: [
        {token:'--e1', val:'var(--e1)'},{token:'--e2', val:'var(--e2)'},{token:'--e3', val:'var(--e3)'}
      ],
      badges: [
        {label:'Online', color:'var(--ok)', soft:'var(--ok-soft)'},
        {label:'Degradato', color:'var(--warn)', soft:'var(--warn-soft)'},
        {label:'Offline', color:'var(--err)', soft:'var(--err-soft)'},
        {label:'Invito in attesa', color:'var(--info)', soft:'var(--info-soft)'},
        {label:'Azione sensibile', color:'var(--ac-text)', soft:'var(--ac-soft)'}
      ]
    };
  }

  window.MetaMC = { SCREENS, MODES, I, NAV, BREAD, RAMP, HOURLY, SHARES, NOW_MODE, OTHER,
    fmt, hx, lerpHex, rampColor, linePath, areaPath, arcPath,
    hexField, netStatus, overview, admin, baseVals };
})();
