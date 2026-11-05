/* ============================================================
   面试妙记 · Interview Notes V2（妙记化：边录边出字 / 传音频转写 / 问AI / 彩色分人）
   录音：getUserMedia + MediaRecorder → 智谱 glm-asr-2512 逐段转写（15s 一段，边录边滚）
   上传：任意录音文件 → 手机本地解码切片 → 同一转写管线
   铁律执行：常量置顶 / 白名单同步 / catch 不静默 / MediaRecorder 每段新建
   ============================================================ */

'use strict';

/* ---------- 常量（置顶：loadState 链路绝不引用后文 —— TDZ 铁律） ---------- */
var STORE_KEY = 'ivnotes.v1';
var ASR_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
var CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
var ASR_MODEL = 'glm-asr-2512';
var CHAT_MODEL = 'glm-4-flash';
var SEG_MS = 15000;          /* 录音切片：15s 一段，转写更快滚出来（< 30s 接口上限） */
var MAX_SESSION_MIN = 60;    /* 单场录音最长 60 分钟 */
var UP_SEG_SEC = 25;         /* 上传转写切片：25s 一段 */
var MAX_UP_MIN = 30;         /* 上传音频最长 30 分钟（手机内存限制，诚实上限） */
/* 白名单：加新字段必须同步这里（数据吞字段事故铁律） */
var REC_FIELDS = ['id', 'ts', 'title', 'company', 'role', 'text', 'review', 'stars', 'audioSecs', 'createdAt', 'aiMsgs'];

/* ---------- 状态 ---------- */
var state = { recs: [], key: '' };
var editingId = null;

function loadState() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    var j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return;
    state.recs = sanitizeRecs(j.recs);
    state.key = typeof j.key === 'string' ? j.key : '';
  } catch (e) {
    /* catch 不静默当空库（V32 事故铁律）：坏数据≠空库，保留现场只提示 */
    console.warn('load fail', e);
    toast('本地数据读取异常，先继续用；别清浏览器数据，找我修');
  }
}
function sanitizeRecs(arr) {
  if (!Array.isArray(arr)) return [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i];
    if (!r || typeof r !== 'object' || !r.id || !r.ts) continue;
    var o = {};
    for (var k = 0; k < REC_FIELDS.length; k++) {
      var f = REC_FIELDS[k];
      if (r[f] === undefined) continue;
      if (f === 'stars') { if (r[f] >= 0 && r[f] <= 5) o[f] = Math.round(Number(r[f])); }
      else if (f === 'audioSecs') { if (isFinite(Number(r[f])) && Number(r[f]) >= 0) o[f] = Math.round(Number(r[f])); }
      else if (f === 'aiMsgs') {
        if (Array.isArray(r[f])) o[f] = r[f].filter(function (m) { return m && typeof m === 'object'; }).slice(0, 30)
          .map(function (m) { return { r: m.r === 'ai' ? 'ai' : 'user', t: String(m.t || '').slice(0, 4000) }; });
      }
      else o[f] = String(r[f]).slice(0, 300000);
    }
    o.id = o.id || ('r' + o.ts);
    out.push(o);
  }
  out.sort(function (a, b) { return Number(b.ts) - Number(a.ts); });
  return out;
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('本地存满了？删几条旧记录再存'); }
}

/* ---------- 工具 ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtDate(ts) {
  /* 兼容：时间戳（数字/数字串）/ '2026-11-05' 字符串（iOS Safari 不认横杠格式，换斜杠） */
  var d = new Date(/^[0-9]+$/.test(String(ts)) ? Number(ts) : String(ts || '').replace(/-/g, '/'));
  if (isNaN(d.getTime())) return String(ts || '');
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtSec(s) {
  s = Math.max(0, Math.round(s));
  var m = Math.floor(s / 60), ss = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
}
var toastTimer = null;
function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
}
function findRec(id) { for (var i = 0; i < state.recs.length; i++) if (state.recs[i].id === id) return state.recs[i]; return null; }
function nowTs() { return String(Date.now()); }

/* ---------- 页面切换 ---------- */
function showPage(name) {
  if (name === 'list' && rec.busy) { toast('还录着呢，先停了再走'); return; }
  ['pg-list', 'pg-rec', 'pg-edit', 'pg-set'].forEach(function (p) { $(p).classList.remove('active'); });
  $('pg-' + name).classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'list') renderList();
  if (name === 'edit') renderEdit();
}

/* ---------- 录音引擎（V102 验证路线：iOS 全系可用） ---------- */
var rec = {
  stream: null, mr: null,
  busy: false, sec: 0, timer: null, startAt: 0, segStart: 0,
  stopping: false,        /* true = 用户按了停，最后一片吐完不再重开 */
  segElapsed: 0,          /* 当前段起点（秒）：给每段转写打时间戳 */
  parts: [],              /* [{idx,text,err,pending}] */
  partBlobs: {},          /* idx → Blob，转完即删 */
  segIdx: 0, transcribing: false
};

function recSupport() { return !!(navigator.mediaDevices && window.MediaRecorder); }
function pickMime() {
  return MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
}
var MIME = '';

function newSegRecorder() {
  /* MediaRecorder 停过就不能复用（InvalidStateError）——每段必须 new（iOS 实测坑） */
  var chunks = [];
  var mr = new MediaRecorder(rec.stream, MIME ? { mimeType: MIME } : undefined);
  mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = function () {
    var blob = new Blob(chunks, { type: mr.mimeType || MIME || 'audio/mp4' });
    var idx = rec.segIdx++;
    var secs = (Date.now() - rec.segStart) / 1000;
    if (blob.size > 800) enqueuePart(blob, idx, secs, rec.segElapsed);   /* <0.8KB 视为空段丢弃 */
    if (!rec.stopping) startSeg();
    else teardownMic();
  };
  return mr;
}
function startSeg() {
  rec.segStart = Date.now();
  rec.segElapsed = rec.startAt ? (rec.segStart - rec.startAt) / 1000 : 0;
  rec.mr = newSegRecorder();
  try { rec.mr.start(); } catch (e) { teardownMic(); rec.busy = false; renderRecBtn(); toast('录音出问题了，重新点一次'); }
}
function teardownMic() {
  if (rec.stream) rec.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
}

async function recStart() {
  if (rec.busy) return;
  if (!recSupport()) { toast('这台设备不支持录音，用下面的「粘贴文字」也行'); return; }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    MIME = pickMime();
    rec.parts = []; rec.partBlobs = {}; rec.segIdx = 0;
    rec.stopping = false; rec.sec = 0; rec.startAt = Date.now();
    rec.busy = true; renderRecBtn();
    startSeg();
    rec.timer = setInterval(function () {
      rec.sec = Math.round((Date.now() - rec.startAt) / 1000);
      $('rec-time').textContent = fmtSec(rec.sec);
      $('rec-count').textContent = rec.parts.filter(function (p) { return !p.pending; }).length + ' 段已转';
      /* 到点切片：停当前段（onstop 里自动重开新段） */
      if (Date.now() - rec.segStart >= SEG_MS && rec.mr && rec.mr.state === 'recording') {
        try { rec.mr.stop(); } catch (e) {}
      }
      if (rec.sec >= MAX_SESSION_MIN * 60) { toast('到 60 分钟上限，自动收尾'); recFinish(); }
    }, 400);
    toast('开录了。想起什么说什么，我边录边转');
  } catch (e) {
    var nm = String((e && e.name) || '');
    if (nm === 'NotAllowedError') toast('麦克风被拒：设置 → Safari → 麦克风 → 允许');
    else toast('麦克风没打开（' + nm + '），或用「粘贴文字」');
  }
}
function recFinish() {
  if (!rec.busy) return;
  rec.stopping = true;
  try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); else teardownMic(); } catch (e) { teardownMic(); }
}

/* 转写队列：串行保序，防 429 */
async function enqueuePart(blob, idx, secs, st) {
  rec.partBlobs[idx] = blob;
  rec.parts.push({ idx: idx, text: '', err: '', pending: true, secs: secs, st: st || 0 });
  renderLiveText();
  if (rec.transcribing) return;
  rec.transcribing = true;
  try {
    for (var guard = 0; guard < 10000; guard++) {
      var next = null;
      for (var i = 0; i < rec.parts.length; i++) {
        if (rec.parts[i].pending && rec.partBlobs[rec.parts[i].idx]) { next = rec.parts[i]; break; }
      }
      if (!next) break;
      next.pending = false;
      try { next.text = await asrOnce(rec.partBlobs[next.idx]); }
      catch (err) { next.err = String((err && err.message) || err).slice(0, 80); }
      delete rec.partBlobs[next.idx];
      renderLiveText();
    }
  } finally { rec.transcribing = false; }
}

/* 单段转写：multipart 直传（V102 已验证格式）；429/5xx 自动等 2.5s 重试一次 */
async function asrOnce(blob) {
  var attempt = async function () {
    var fd = new FormData();
    fd.append('model', ASR_MODEL);
    fd.append('stream', 'false');
    var ty = String(blob.type || '');
    var ext = ty.indexOf('wav') > -1 ? 'wav' : (ty.indexOf('mp4') > -1 ? 'mp4' : 'webm');
    fd.append('file', blob, 'seg.' + ext);
    var r = await fetch(ASR_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + state.key },
      body: fd
    });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return String((j && (j.text || (j.data && j.data.text))) || '').trim();
  };
  try { return await attempt(); }
  catch (e) {
    if (/HTTP (429|5\d\d)/.test(String((e && e.message) || e))) {
      await new Promise(function (res) { setTimeout(res, 2500); });
      return await attempt();
    }
    throw e;
  }
}

/* 录音收尾：建记录 */
async function finishRecording() {
  clearInterval(rec.timer);
  rec.busy = false;
  renderRecBtn();
  var totalSec = Math.round((Date.now() - rec.startAt) / 1000);
  /* 等队列里还没转完的段（最多 120s） */
  var waited = 0;
  while (rec.transcribing && waited < 120000) { await new Promise(function (res) { setTimeout(res, 1000); }); waited += 1000; }
  var sorted = rec.parts.slice().sort(function (a, b) { return a.idx - b.idx; });
  var full = [], errs = 0;
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].text) full.push('[' + fmtSec(sorted[i].st || 0) + '] ' + sorted[i].text);
    else if (sorted[i].err) errs++;
  }
  if (!full.length) {
    toast(errs ? '没转出来：' + (sorted[0] && sorted[0].err || '钥匙/网络问题') : '没录到声音');
    showPageForce('list');
    return;
  }
  var r = {
    id: 'r' + nowTs(), ts: nowTs(), createdAt: nowTs(),
    title: '', company: '', role: '',
    text: full.join('\n'),
    review: '', stars: 0, audioSecs: totalSec, aiMsgs: []
  };
  state.recs.unshift(r);
  saveState();
  if (errs) toast('已存，' + errs + ' 小段没转出来（可手打补上）');
  else toast('✓ 转写完成，写写复盘');
  editingId = r.id;
  showPageForce('edit');
}
function showPageForce(name) { /* 收尾跳页不受「录着呢」拦截 */ ['pg-list', 'pg-rec', 'pg-edit', 'pg-set'].forEach(function (p) { $(p).classList.remove('active'); }); $('pg-' + name).classList.add('active'); if (name === 'list') renderList(); if (name === 'edit') renderEdit(); }

/* ---------- 录音页渲染 ---------- */
function renderLiveText() {
  var box = $('live-text');
  var sorted = rec.parts.slice().sort(function (a, b) { return a.idx - b.idx; });
  var html = '';
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    var ts = '<span class="lt-t">[' + fmtSec(p.st || 0) + ']</span>';
    if (p.pending) html += '<p class="lt pending">' + ts + '▍转写中…</p>';
    else if (p.text) html += '<p class="lt">' + ts + esc(p.text) + '</p>';
    else if (p.err) html += '<p class="lt err">' + ts + '（这段没转出来：' + esc(p.err) + '）</p>';
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
function renderRecBtn() {
  var b = $('rec-btn');
  if (rec.busy) { b.className = 'big-rec recing'; b.innerHTML = '<span class="br-in"></span>'; }
  else { b.className = 'big-rec'; b.innerHTML = '<span class="br-dot"></span><span class="br-lab">录音</span>'; }
}

/* ---------- 列表页 ---------- */
function renderList() {
  var el = $('rec-list');
  if (!state.recs.length) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">🎙️</div><p class="empty-t">还没有面试记录</p><p class="sub">面试完出来，点下面大按钮开录<br>想起什么说什么，自动转成文字</p></div>';
    return;
  }
  var h = '';
  for (var i = 0; i < state.recs.length; i++) {
    var r = state.recs[i];
    var stars = r.stars
      ? '<span class="on">' + '★'.repeat(r.stars) + '</span><span class="dim">' + '★'.repeat(5 - r.stars) + '</span>'
      : '<span class="dim">未评分</span>';
    h += '<button class="rec-row" data-act="open" data-id="' + esc(r.id) + '">' +
      '<div class="rr-l1"><b>' + esc(r.title || r.company || '未命名复盘') + '</b><span class="rr-stars">' + stars + '</span></div>' +
      '<div class="rr-l2">' + esc(fmtDate(r.ts)) + (r.audioSecs ? ' · ' + fmtSec(r.audioSecs) : '') + (r.role ? ' · ' + esc(r.role) : '') + '</div>' +
      '<div class="rr-l3">' + esc((r.text || '').slice(0, 64)) + ((r.text || '').length > 64 ? '…' : '') + '</div>' +
      '</button>';
  }
  el.innerHTML = h;
}

/* ---------- 编辑页 ---------- */
function renderEdit() {
  var r = findRec(editingId);
  if (!r) { showPageForce('list'); return; }
  $('ed-title').value = r.title || '';
  $('ed-company').value = r.company || '';
  $('ed-role').value = r.role || '';
  $('ed-text').value = r.text || '';
  switchTab(false);   /* 每次进编辑页回到原文 tab，防文字被分人视图藏住 */
  renderStars(r.stars);
  renderReview(r);
  $('ed-meta').textContent = esc(fmtDate(r.ts)) + (r.audioSecs ? ' · 录了 ' + fmtSec(r.audioSecs) : '');
}
function renderStars(n) {
  var h = '';
  for (var i = 1; i <= 5; i++) h += '<button class="star' + (i <= n ? ' on' : '') + '" data-act="star" data-n="' + i + '" aria-label="' + i + '分">★</button>';
  $('ed-stars').innerHTML = h;
}
function renderReview(r) {
  var box = $('ed-review');
  if (!r.review) { box.innerHTML = '<p class="sub">还没生成——点上面「✦ AI 复盘」，我帮你挑出问了哪些题、哪里答砸了、下次怎么改</p>'; return; }
  box.innerHTML = r.review
    .split('\n')
    .filter(function (l) { return l.trim(); })
    .map(function (l) {
      var t = esc(l.trim());
      if (/^[#＃]/.test(t)) return '<h4>' + t.replace(/^[#＃]+\s*/, '') + '</h4>';
      if (/^[-•·]/.test(t)) return '<li>' + t.replace(/^[-•·]\s*/, '') + '</li>';
      if (/^\d+[.、)）]/.test(t)) return '<li>' + t.replace(/^\d+[.、)）]\s*/, '') + '</li>';
      return '<p>' + t + '</p>';
    })
    .join('');
}
function saveEditField(field, val) {
  var r = findRec(editingId);
  if (!r) return;
  r[field] = String(val || '').slice(0, 300000);
  saveState();
}

/* ---------- AI 复盘（销售面试定制） ---------- */
async function aiReview() {
  var r = findRec(editingId);
  if (!r) return;
  if (!state.key) { toast('先去右上角设置里填好钥匙'); showPage('set'); return; }
  if (!(r.text || '').trim()) { toast('还没有文字内容，先录音或粘贴'); return; }
  var btn = $('ai-btn');
  btn.disabled = true; btn.textContent = '分析中…';
  try {
    var sys = '你是一位资深销售岗面试教练。以下是候选人一场销售岗面试的转写记录，两种可能：①候选人面试后口述的复盘；②现场实录，带「面试官：」「我：」等说话人标记和[分:秒]时间戳。口语和转写噪音请理解意图、自动忽略。\n' +
      '输出中文复盘报告，严格按以下六段（# 开头做段标题）：\n' +
      '# 面试官问了哪些题\n（逐条编号还原真实问题；有说话人标记的按标记区分谁问的）\n' +
      '# 每题答得怎么样\n（每题一行：问题关键词 → 好/一般/砸，加一句理由）\n' +
      '# 砸了的怎么救\n（给砸了/一般的题写出更好的回答示范，可直接背的话术）\n' +
      '# 值得复用的素材\n（口述/实录里讲得好、下一面能直接复用的故事和金句）\n' +
      '# 下次面试前准备\n（最多3条，可执行）\n' +
      '# 过的预判\n（大/中/小 + 一句话理由；信息不足就写「信息不足，不猜」）\n' +
      '要求：全部基于转写内容，不编造；每条简洁。';
    var res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.key },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: (r.company ? '公司：' + r.company + '\n' : '') + (r.role ? '岗位：' + r.role + '\n\n' : '\n') + r.text }
        ],
        temperature: 0.3
      })
    });
    var j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
    var txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (!txt) throw new Error('AI 没返回内容');
    r.review = txt;
    saveState();
    renderReview(r);
    toast('✓ 复盘生成好了');
  } catch (err) {
    var m = String((err && err.message) || err);
    if (/401|auth/i.test(m)) toast('钥匙不对：去设置里检查');
    else if (/余额|1113|quota/i.test(m)) toast('账户额度不够了');
    else toast('生成失败（' + m.slice(0, 40) + '）再试一次');
  } finally {
    btn.disabled = false; btn.textContent = '✦ AI 复盘';
  }
}

/* ---------- 粘贴导入（豆包实录文字 → 这边沉淀） ---------- */
function openPaste() { $('paste-sheet').classList.add('show'); $('paste-mask').classList.add('show'); $('paste-area').value = ''; }
function closePaste() { $('paste-sheet').classList.remove('show'); $('paste-mask').classList.remove('show'); }
function savePaste() {
  var txt = $('paste-area').value.trim();
  if (!txt) { toast('先粘贴点文字进来'); return; }
  var r = {
    id: 'r' + nowTs(), ts: nowTs(), createdAt: nowTs(),
    title: '', company: '', role: '',
    text: txt, review: '', stars: 0, audioSecs: 0, aiMsgs: []
  };
  state.recs.unshift(r);
  saveState();
  closePaste();
  toast('✓ 已导入，可以生成 AI 复盘了');
  editingId = r.id;
  showPageForce('edit');
}

/* ---------- 删除 ---------- */
function askDelete(id) {
  var r = findRec(id);
  if (!r) return;
  $('modal-text').textContent = '删掉「' + (r.title || r.company || '这条复盘') + '」？删了就找不回来了';
  $('modal').classList.add('show');
  $('modal-ok').onclick = function () {
    $('modal').classList.remove('show');
    state.recs = state.recs.filter(function (x) { return x.id !== id; });
    saveState(); renderList();
    toast('已删除');
  };
}
function askWipe() {
  $('modal-text').textContent = '清空所有面试记录？此操作不可恢复（建议先逐条导出备份）';
  $('modal').classList.add('show');
  $('modal-ok').onclick = function () {
    $('modal').classList.remove('show');
    state.recs = [];
    saveState(); renderList();
    toast('已清空');
  };
}

/* ---------- 导出 ---------- */
function exportOne() {
  var r = findRec(editingId);
  if (!r) return;
  var blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '面试复盘_' + (r.title || r.company || r.ts) + '.json';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  toast('已导出备份文件（在"文件"App里能找到）');
}

/* ============================================================
   V2 新增：传音频转写 / 问 AI / 分人视图
   ============================================================ */

/* ---------- 传音频转写（妙记同款：语音备忘录/豆包导出 → 全文） ---------- */
var up = { busy: false, cancel: false, done: 0, total: 0 };
function openUpload() {
  $('up-sheet').classList.add('show'); $('up-mask').classList.add('show');
  $('up-file').value = '';
  upProgUI();
}
function closeUpload() {
  if (up.busy) up.cancel = true;
  $('up-sheet').classList.remove('show'); $('up-mask').classList.remove('show');
}
function upProgUI() {
  var p = $('up-prog');
  if (!up.busy) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  var pct = up.total ? Math.round(up.done / up.total * 100) : 3;
  $('up-fill').style.width = pct + '%';
  $('up-status').textContent = '转写中… 第 ' + Math.min(up.done + 1, up.total) + ' / ' + up.total + ' 段（中途关闭=放弃本次）';
}
/* 解码兼容：Safari 新版 promise / 老版回调，两种都接 */
function decodeAb(ctx, ab) {
  return new Promise(function (res, rej) {
    var p = ctx.decodeAudioData(ab, res, function (e) { rej(e || new Error('decode fail')); });
    if (p && p.then) p.then(res, function (e) { rej(e); });
  });
}
/* Float32 → 16bit PCM WAV Blob */
function wavBlob(f32, rate) {
  var n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  var ws = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (var i = 0; i < n; i++) { var s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
function audioDur(url) {
  return new Promise(function (res) {
    var a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = function () { res(a.duration || 0); };
    a.onerror = function () { res(0); };
    a.src = url;
  });
}
async function handleUpload(file) {
  if (up.busy) return;
  if (!state.key) { toast('先去右上角设置填钥匙'); showPage('set'); return; }
  if (!file) return;
  if (file.size > 300 * 1024 * 1024) { toast('文件超过 300MB，处理不了'); return; }
  up.busy = true; up.cancel = false; up.done = 0; up.total = 0; upProgUI();
  try {
    var url = URL.createObjectURL(file);
    var dur = await audioDur(url);
    URL.revokeObjectURL(url);
    if (dur && dur > MAX_UP_MIN * 60 + 5) throw new Error('音频 ' + fmtSec(dur) + '，超过 30 分钟上限');
    var ab = await file.arrayBuffer();
    /* 优先用 OfflineAudioContext 解码：直接重采样到 16k，省内存 */
    var buf;
    try { buf = await decodeAb(new OfflineAudioContext(1, 160, 16000), ab); }
    catch (e) {
      var c2 = new (window.AudioContext || window.webkitAudioContext)();
      buf = await decodeAb(c2, ab);
      try { c2.close(); } catch (e2) {}
    }
    var total = buf.duration;
    if (total > MAX_UP_MIN * 60 + 5) throw new Error('音频 ' + fmtSec(total) + '，超过 30 分钟上限');
    if (total < 0.5) throw new Error('音频太短或读不出来，换个文件试试');
    var rate = buf.sampleRate, n = buf.length;
    var mono = new Float32Array(n);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < n; i++) mono[i] += d[i];
    }
    if (buf.numberOfChannels > 1) { var inv = 1 / buf.numberOfChannels; for (var j = 0; j < n; j++) mono[j] *= inv; }
    up.total = Math.ceil(total / UP_SEG_SEC); up.done = 0; upProgUI();
    var lines = [];
    for (var s = 0; s < up.total; s++) {
      if (up.cancel) throw new Error('已取消');
      var st = s * UP_SEG_SEC, len = Math.min(UP_SEG_SEC, total - st);
      var seg = mono.subarray(Math.round(st * rate), Math.round((st + len) * rate));
      var t = await asrOnce(wavBlob(seg, rate));
      if (t) lines.push('[' + fmtSec(st) + '] ' + t);
      up.done = s + 1; upProgUI();
    }
    if (!lines.length) throw new Error('没转出内容（可能全程静音或格式问题）');
    var r = {
      id: 'r' + nowTs(), ts: nowTs(), createdAt: nowTs(),
      title: (file.name || '').replace(/\.[^.]+$/, '').slice(0, 40) || '上传转写',
      company: '', role: '', text: lines.join('\n'),
      review: '', stars: 0, audioSecs: Math.round(total), aiMsgs: []
    };
    state.recs.unshift(r); saveState();
    closeUpload(); editingId = r.id; showPageForce('edit');
    toast('✓ 全文转好了，可以 AI 复盘');
  } catch (err) {
    var m = String((err && err.message) || err);
    if (m === '已取消') toast('已取消');
    else toast('转写失败：' + m.slice(0, 50));
  } finally {
    up.busy = false; upProgUI();
  }
}

/* ---------- 问 AI（妙记同款：对着单场记录追问） ---------- */
function openAsk() {
  if (!findRec(editingId)) return;
  renderAsk();
  $('ask-sheet').classList.add('show'); $('ask-mask').classList.add('show');
}
function closeAsk() { $('ask-sheet').classList.remove('show'); $('ask-mask').classList.remove('show'); }
function renderAsk() {
  var r = findRec(editingId);
  var ms = (r && r.aiMsgs) || [];
  var h = '';
  if (!ms.length) h = '<p class="ask-empty">还没问过。试试：面试官哪几个问题在反复考察我？</p>';
  for (var i = 0; i < ms.length; i++) {
    h += '<div class="ask-msg ' + (ms[i].r === 'ai' ? 'ai' : 'me') + '">' + esc(ms[i].t) + '</div>';
  }
  var el = $('ask-list'); el.innerHTML = h; el.scrollTop = el.scrollHeight;
}
async function askSend() {
  var r = findRec(editingId);
  if (!r) return;
  var inp = $('ask-in');
  var q = inp.value.trim();
  if (!q) return;
  if (!state.key) { toast('先去设置填钥匙'); return; }
  if (!(r.text || '').trim()) { toast('这场还没有文字内容，先录音/粘贴/上传'); return; }
  inp.value = '';
  if (!Array.isArray(r.aiMsgs)) r.aiMsgs = [];
  r.aiMsgs.push({ r: 'user', t: q });
  r.aiMsgs.push({ r: 'ai', t: '…' });
  if (r.aiMsgs.length > 30) r.aiMsgs = r.aiMsgs.slice(-30);
  renderAsk(); saveState();
  var aiIdx = r.aiMsgs.length - 1;
  try {
    var sys = '你是一位资深销售岗面试教练。以下是这场面试的转写记录（可能是候选人面试后口述的复盘，也可能带「面试官：」「我：」说话人标记和[分:秒]时间戳）。回答用户关于这场面试的问题：全部基于转写内容不编造；引用原文可带[时间]；简洁、具体、可操作。转写记录：\n' + String(r.text).slice(0, 12000);
    var msgs = [{ role: 'system', content: sys }];
    var hist = r.aiMsgs.slice(0, -2).slice(-8);
    for (var i = 0; i < hist.length; i++) msgs.push({ role: hist[i].r === 'ai' ? 'assistant' : 'user', content: hist[i].t });
    msgs.push({ role: 'user', content: q });
    var res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.key },
      body: JSON.stringify({ model: CHAT_MODEL, messages: msgs, temperature: 0.4 })
    });
    var j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
    var txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (!txt) throw new Error('AI 没返回内容');
    r.aiMsgs[aiIdx].t = txt;
  } catch (err) {
    var m = String((err && err.message) || err);
    r.aiMsgs[aiIdx].t = (/401|auth/i.test(m)) ? '（钥匙不对，去设置检查）' : '（出错了：' + m.slice(0, 40) + '，再问一次试试）';
  }
  renderAsk(); saveState();
}

/* ---------- 分人视图（豆包/飞书粘入的说话人标记 → 彩色） ---------- */
var PEOPLE_THEM = ['面试官', 'HR', 'hr', '对方', '经理', '主管', '老板', '总监'];
var PEOPLE_ME = ['我', '本人', '候选人'];
function renderPeople() {
  var r = findRec(editingId);
  var el = $('ed-people');
  var lines = String((r && r.text) || '').split('\n');
  var all = PEOPLE_THEM.concat(PEOPLE_ME);
  /* 行首可有 [分:秒] 时间戳（录音/上传转写），说话人标记在其后 */
  var rx = new RegExp('^\\s*(\\[\\d{1,2}:\\d{2}\\])?\\s*(' + all.join('|') + ')[：:]\\s*');
  var h = '', found = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l.trim()) continue;
    var m = l.match(rx);
    if (m) {
      var me = PEOPLE_ME.indexOf(m[2]) > -1;
      var tm = m[1] ? '<span class="lt-t">' + m[1] + '</span>' : '';
      h += '<div class="sp-line">' + tm + '<span class="sp-chip ' + (me ? 'me' : 'them') + '">' + esc(m[2]) + '</span><span class="sp-txt">' + esc(l.slice(m[0].length)) + '</span></div>';
      found++;
    } else {
      h += '<div class="sp-line"><span class="sp-chip none">·</span><span class="sp-txt">' + esc(l) + '</span></div>';
    }
  }
  el.innerHTML = found >= 2 ? h
    : '<p class="sp-hint">没找到「面试官：」「我：」这类说话人标记。<br>从豆包/飞书复制时保留标记，粘进来就自动彩色分人</p>';
}
function switchTab(people) {
  $('ed-text').classList.toggle('hidden', !!people);
  $('ed-people').classList.toggle('hidden', !people);
  var tabs = document.querySelectorAll('.t-tab');
  if (tabs[0]) tabs[0].classList.toggle('active', !people);
  if (tabs[1]) tabs[1].classList.toggle('active', !!people);
  if (people) renderPeople();
}

/* ---------- 事件（单点委托） ---------- */
document.addEventListener('click', function (e) {
  var t = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!t) {
    /* 点空白关弹层：必须覆盖所有弹层（V105 教训） */
    if (e.target.id === 'paste-mask') closePaste();
    if (e.target.id === 'up-mask') closeUpload();
    if (e.target.id === 'ask-mask') closeAsk();
    if (e.target.id === 'modal-bg') $('modal').classList.remove('show');
    return;
  }
  var act = t.getAttribute('data-act');
  if (act === 'go-rec') showPage('rec');
  else if (act === 'rec-toggle') { rec.busy ? recFinish() : recStart(); }
  else if (act === 'open') { editingId = t.getAttribute('data-id'); showPage('edit'); }
  else if (act === 'del') askDelete(t.getAttribute('data-id'));
  else if (act === 'del-cur') askDelete(editingId);
  else if (act === 'back-list') showPage('list');
  else if (act === 'back-rec') showPage('rec');
  else if (act === 'go-set') showPage('set');
  else if (act === 'ai-review') aiReview();
  else if (act === 'star') {
    var n = Number(t.getAttribute('data-n'));
    var r = findRec(editingId);
    if (r) { r.stars = (r.stars === n ? 0 : n); saveState(); renderStars(r.stars); renderList(); }
  }
  else if (act === 'open-paste') openPaste();
  else if (act === 'close-paste') closePaste();
  else if (act === 'save-paste') savePaste();
  else if (act === 'open-up') openUpload();
  else if (act === 'close-up') closeUpload();
  else if (act === 'open-ask') openAsk();
  else if (act === 'close-ask') closeAsk();
  else if (act === 'ask-send') askSend();
  else if (act === 'tab-text') switchTab(false);
  else if (act === 'tab-people') switchTab(true);
  else if (act === 'export') exportOne();
  else if (act === 'wipe') askWipe();
});

document.addEventListener('input', function (e) {
  var id = e.target && e.target.id;
  if (id === 'ed-title') saveEditField('title', e.target.value);
  else if (id === 'ed-company') saveEditField('company', e.target.value);
  else if (id === 'ed-role') saveEditField('role', e.target.value);
  else if (id === 'ed-text') saveEditField('text', e.target.value);
  else if (id === 'set-key') { state.key = e.target.value.trim(); saveState(); }
});

/* 上传文件选择 + 问AI回车发送 */
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'up-file' && e.target.files && e.target.files[0]) handleUpload(e.target.files[0]);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target && e.target.id === 'ask-in' && !e.shiftKey) { e.preventDefault(); askSend(); }
});

$('modal-cancel').onclick = function () { $('modal').classList.remove('show'); };

/* 离开页面前强制落盘 */
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', function () { if (document.hidden) saveState(); });

/* ---------- 启动 ---------- */
loadState();
renderRecBtn();
showPageForce('list');
