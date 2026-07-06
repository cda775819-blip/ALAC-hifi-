// ═══════════════════════════════════════════════════════════════
//  utils/logger.js — 调试日志系统
//  来源: app.js L20-85
// ═══════════════════════════════════════════════════════════════

const D = {
  entries: [],
  _errCount: 0, _okCount: 0,
  _startTime: 0,

  reset() {
    this.entries = [];
    this._errCount = 0; this._okCount = 0;
    this._startTime = Date.now();
    $('#debugBody').innerHTML = '<div class="debug-empty">等待文件加载...</div>';
    $('#debugErrCount').style.display = 'none';
    $('#debugOkCount').style.display = 'none';
    $('#debugConsole').classList.remove('open');
  },

  log(level, tag, msg) {
    const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(2);
    this.entries.push({ elapsed, level, tag, msg });
    if (level === 'err') this._errCount++;
    if (level === 'ok') this._okCount++;
    this._render();
  },

  info(tag, msg) { this.log('info', tag, msg); },
  ok(tag, msg) { this.log('ok', tag, msg); },
  warn(tag, msg) { this.log('warn', tag, msg); },
  err(tag, msg) { this.log('err', tag, msg); },

  _render() {
    const body = $('#debugBody');
    if (this.entries.length === 1 && this.entries[0].tag === 'INIT') {
      body.innerHTML = '';
    }
    if (this._suppressDOM) return;
    const recent = this.entries.slice(-1);
    for (const e of recent) {
      const div = document.createElement('div');
      div.className = 'debug-entry';
      div.innerHTML = `<span class="ts">+${e.elapsed}s</span><span class="tag ${e.level}">${e.tag}</span><span class="msg">${e.msg}</span>`;
      body.appendChild(div);
      body.scrollTop = body.scrollHeight;
    }
    const maxDOM = 500;
    while (body.children.length > maxDOM) body.removeChild(body.firstChild);
    const maxData = 1000;
    if (this.entries.length > maxData) this.entries = this.entries.slice(-maxData);
    $('#debugErrCount').textContent = this._errCount;
    $('#debugErrCount').style.display = this._errCount > 0 ? '' : 'none';
    $('#debugOkCount').textContent = this._okCount;
    $('#debugOkCount').style.display = this._okCount > 0 ? '' : 'none';
    if (this._errCount > 0) {
      $('#debugConsole').classList.add('open');
    }
  }
};

function toggleDebug() {
  $('#debugConsole').classList.toggle('open');
}
window.toggleDebug = toggleDebug;
