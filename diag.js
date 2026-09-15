/* Учёт тендеров — видимый бут-лог (TTDiag).
   Подключается в <head> ДО auth.js (index.html, balance.html).
   Страницы без diag.js работают как раньше: auth.js/common.js зовут
   TTDiag только через гард window.TTDiag && TTDiag.log(...).

   Тихий режим: лог копится в памяти всегда (window.TTDiag.entries()),
   но панель показывается ТОЛЬКО по ?debug=1 в URL — никакого автопоказа.
   Секреты не логируются: только «has session», роль из tt_users, тексты ошибок. */
(function () {
  var MAX_ENTRIES = 500; // защита от спама в долгих сессиях

  var _entries = [];
  var _panel = null;
  var _list = null;

  function _now() {
    return (window.performance && performance.now) ? Math.round(performance.now()) : Date.now();
  }

  function _pad(n, w) {
    var s = String(n);
    while (s.length < w) s = ' ' + s;
    return s;
  }

  function _lineText(e) {
    return _pad(e.t, 6) + 'мс  ' + e.step + (e.detail ? '  |  ' + e.detail : '');
  }

  function _fullText() {
    var head = '[TTDiag] ' + location.pathname + '  ' + new Date().toISOString() + '\n' +
      navigator.userAgent + '\n\n';
    var lines = [];
    for (var i = 0; i < _entries.length; i++) lines.push(_lineText(_entries[i]));
    return head + lines.join('\n');
  }

  function _appendLine(e) {
    if (!_list) return;
    var div = document.createElement('div');
    div.textContent = _lineText(e); // textContent — без HTML-инъекций
    _list.appendChild(div);
    _list.scrollTop = _list.scrollHeight;
  }

  function _fallbackCopy(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function _mkBtn(label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;' +
      'font:11px Consolas,Menlo,monospace;padding:2px 8px;margin-left:6px;cursor:pointer';
    return b;
  }

  function _build() {
    if (_panel || !document.body) return;

    _panel = document.createElement('div');
    _panel.id = 'tt-diag';
    _panel.style.cssText = 'position:fixed;bottom:8px;right:8px;width:420px;max-width:calc(100vw - 16px);' +
      'max-height:45vh;display:none;flex-direction:column;background:#14171e;color:#c9d1d9;' +
      'font:11px/1.6 Consolas,Menlo,monospace;border:1px solid #30363d;border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:2147483647;text-align:left';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;padding:6px 8px;border-bottom:1px solid #30363d;flex:0 0 auto';
    var title = document.createElement('span');
    title.textContent = 'Диагностика загрузки';
    title.style.cssText = 'flex:1;color:#8b949e';

    var btnCopy = _mkBtn('копировать');
    btnCopy.addEventListener('click', function () {
      var txt = _fullText();
      function done(ok) {
        btnCopy.textContent = ok ? 'скопировано' : 'ошибка копирования';
        setTimeout(function () { btnCopy.textContent = 'копировать'; }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(_fallbackCopy(txt)); });
      } else {
        done(_fallbackCopy(txt));
      }
    });

    var btnClose = _mkBtn('закрыть');
    btnClose.addEventListener('click', function () {
      _panel.style.display = 'none';
    });

    header.appendChild(title);
    header.appendChild(btnCopy);
    header.appendChild(btnClose);

    _list = document.createElement('div');
    _list.style.cssText = 'overflow:auto;padding:6px 8px;white-space:pre-wrap;word-break:break-word;flex:1 1 auto';

    _panel.appendChild(header);
    _panel.appendChild(_list);
    document.body.appendChild(_panel);

    for (var i = 0; i < _entries.length; i++) _appendLine(_entries[i]);
  }

  function log(step, detail) {
    var e = {
      t: _now(),
      step: String(step),
      detail: (detail === undefined || detail === null) ? '' : String(detail)
    };
    _entries.push(e);
    if (_entries.length > MAX_ENTRIES) _entries.shift();
    _appendLine(e);
  }

  function show() {
    if (!document.body) return; // до DOMContentLoaded показать некуда — покажет _arm
    _build();
    if (_panel) _panel.style.display = 'flex';
  }

  function hide() {
    if (_panel) _panel.style.display = 'none';
  }

  function _arm() {
    if (/[?&]debug=1(&|$)/.test(location.search)) show();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _arm);
  } else {
    _arm();
  }

  window.TTDiag = {
    log: log,
    show: show,
    hide: hide,
    entries: function () { return _entries.slice(); }
  };

  log('diag:start', document.readyState);
})();
