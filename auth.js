/* Учёт тендеров — защита страниц.
   Адаптация kp_project/auth.js: роль из tt_users, без presence. */
(function () {
  /* ═══ Выбор базы Supabase: прокси или прямой URL ═══
     Разным машинам нужны РАЗНЫЕ пути: у одних провайдер душит netlify.app
     (прокси), у других режет QUIC к Cloudflare (прямой supabase.co).
     Кандидаты в порядке приоритета: прокси Netlify (дефолт, 2026-09-16),
     затем прямой URL. Выбранная база запоминается в localStorage tt_base:
     на старте берётся мгновенно (нулевая задержка), а параллельно в фоне
     probe проверяет, жива ли она — мёртвый кеш при живой второй базе
     перезаписывается (+ один reload, пока страница не загрузила данные).
     Без кеша обе базы пробуются наперегонки GET /auth/v1/health (c apikey:
     на обеих отдаёт 200, а любой статус <500 = канал жив). Обе мертвы →
     прокси (дефолт), ключ не пишется — дальше сработает обычный экран
     «Сервер недоступен + Повторить». Локальная разработка (не-https) —
     прямой URL без probe. Компактная копия этой логики живёт в login.html
     (он не подключает auth.js) — менять синхронно. */
  var SUPA_BASES = [
    'https://newproject-sb.netlify.app',        // прокси Netlify (дефолт)
    'https://uclzyzztoripulpcpshp.supabase.co'  // прямой URL
  ];
  var BASE_KEY = 'tt_base';
  var BASE_RELOAD_FLAG = 'tt_base_reloaded'; // sessionStorage: reload на живую базу максимум один раз
  var PROBE_TIMEOUT_MS = 2500;
  /* Ключ сессии ФИКСИРОВАН: дефолт supabase-js — sb-<хост базы>-auth-token,
     т.е. при смене базы сессия «терялась» бы. Значение равно старому дефолту
     прокси, чтобы существующие сессии пережили этот деплой. */
  var STORAGE_KEY = 'sb-newproject-sb-auth-token';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjbHp5enp0b3JpcHVscGNwc2hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3ODIyNzMsImV4cCI6MjA5MjM1ODI3M30.rX-WT1WdZiwRakVcUEkcg-_dnWzfU49LvgTNHYgBYQ0';

  var _sb = null;
  var _user = null; // { user_id, role, display_name, email }

  // Бут-лог: пишем только если diag.js подключён (tender.html живёт без него).
  // Без секретов: токены не логируем, сессия — только has/none + TTL в секундах.
  function _diag(step, detail) {
    if (window.TTDiag && window.TTDiag.log) window.TTDiag.log(step, detail);
  }

  // Оверлей на время проверки доступа
  var SPINNER_HTML = '<div style="text-align:center"><div style="width:40px;height:40px;border:3px solid #E3E8F0;border-top-color:#1565C0;border-radius:50%;animation:auth-spin 0.8s linear infinite;margin:0 auto 16px"></div><div style="color:#666;font-size:14px">Проверка доступа...</div></div><style>@keyframes auth-spin{to{transform:rotate(360deg)}}</style>';
  var _overlay = document.createElement('div');
  _overlay.id = 'auth-overlay';
  _overlay.style.cssText = 'position:fixed;inset:0;background:#F0F4F8;z-index:999999;display:flex;align-items:center;justify-content:center;';
  _overlay.innerHTML = SPINNER_HTML;
  document.head.parentNode.insertBefore(_overlay, document.head.nextSibling);

  function _toLogin() {
    sessionStorage.setItem('auth_redirect', window.location.pathname + window.location.search);
    window.location.replace('/login.html');
  }

  /* ═══ Лок для supabase-js: navigator.locks с таймаутом ═══
     supabase-js 2.110 по умолчанию работает вообще без лока (lock:null),
     т.е. межвкладочные гонки ротации refresh-токена не сериализуются.
     Чистый navigator.locks может ждать вечно, если замороженная фоновая
     вкладка держит блокировку. Компромисс: ждём эксклюзивный лок не дольше
     LOCK_TIMEOUT_MS, после — выполняем fn без лока (console.warn), редкую
     межвкладочную гонку разруливают внутренние commit-guard'ы supabase-js.
     Семантика: пока fn выполняется под локом, лок держится (возвращаем
     промис fn из колбэка request). */
  var LOCK_TIMEOUT_MS = 3000;
  function _lockWithTimeout(name, _acquireTimeout, fn) {
    if (!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request)) {
      return fn(); // среды без Web Locks — без сериализации, как раньше
    }
    return new Promise(function (resolve, reject) {
      var started = false; // fn уже запущен (под локом или по таймауту) — защита от двойного запуска/резолва
      var ctrl = new AbortController();
      var timer = setTimeout(function () {
        if (started) return;
        started = true;
        console.warn('[auth] lock "' + name + '" не получен за ' + LOCK_TIMEOUT_MS + 'мс — выполняем без блокировки');
        _diag('lock:timeout', name + ' > ' + LOCK_TIMEOUT_MS + 'мс — выполняем без блокировки');
        ctrl.abort(); // убираем своё ожидание из очереди LockManager
        Promise.resolve().then(fn).then(resolve, reject);
      }, LOCK_TIMEOUT_MS);
      navigator.locks.request(name, { mode: 'exclusive', signal: ctrl.signal }, function () {
        if (started) return; // таймаут сработал на той же итерации — fn уже выполняется без лока
        started = true;
        clearTimeout(timer);
        _diag('lock:ok', name);
        var p = Promise.resolve().then(fn);
        p.then(resolve, reject);
        // держим лок до завершения fn; свой catch — чтобы отклонение fn
        // не всплыло второй раз через промис request()
        return p.catch(function () {});
      }).catch(function () {
        if (started) return; // AbortError после таймаута — fn уже запущен
        started = true;      // иная ошибка LockManager до старта fn — выполняем без лока
        clearTimeout(timer);
        _diag('lock:error', name + ' — ошибка LockManager, выполняем без лока');
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  }

  /* ═══ Проверка роли: hedged — GET и POST rpc наперегонки ═══
     У части машин локальный софт (антивирус/расширение) «отравляет» GET к
     /rest/v1/* — первый GET виснет без ответа, а POST проходят. Вместо
     последовательных попыток (GET → 6с → rpc) оба канала бегут наперегонки:
     GET tt_users стартует сразу; если за HEDGE_DELAY_MS не ответил —
     параллельно стартует POST rpc('tt_whoami') (security invoker, тот же
     RLS-контекст, jsonb-строка tt_users или null). Побеждает первый успешный
     результат, проигравший обрывается через AbortController (реальный обрыв
     fetch — abort резолвится в {error}, до unhandledrejection не доходит).
     Память канала (общая с common.js): localStorage tt_net_pref='rpc' —
     ставится при ЛЮБОЙ победе rpc (проигрыш GET в гонке уже означает, что
     канал GET медленный или мёртвый); при 'rpc' хедж-задержка = 0 (rpc сразу
     вместе с GET) и мутации в common.js идут сразу через rpc; GET победил при
     'rpc' — ключ удаляется.
     Семантика исходов:
       - успех с data от любого канала  → role:ok (как раньше);
       - data=null от ЛЮБОГО канала     → валидный ответ «роли нет» → signOut;
       - ошибка/обрыв одного канала     → ждём второй (сеть НЕ разлогинивает);
       - оба канала мертвы / общий таймаут 12с → сообщение + кнопка «Повторить»;
       - исключение в обработке результата → login (как раньше). */
  var ROLE_TIMEOUT_MS = 12000;  // общий потолок на оба канала
  var ROLE_HEDGE_DELAY_MS = 400;
  var NET_PREF_KEY = 'tt_net_pref';
  var _roleChecking = false; // проверка уже идёт — защита от повторного запуска (двойной клик по «Повторить»)

  function _netPref() { try { return localStorage.getItem(NET_PREF_KEY); } catch (e) { return null; } }
  function _netPrefSet() { try { localStorage.setItem(NET_PREF_KEY, 'rpc'); } catch (e) { /* private mode */ } }
  function _netPrefClear() { try { localStorage.removeItem(NET_PREF_KEY); } catch (e) { /* private mode */ } }

  function _showRetry(session) {
    _overlay.innerHTML = '<div style="text-align:center"><div style="color:#666;font-size:14px;margin-bottom:16px">Сервер недоступен. Проверьте интернет / VPN.</div><button id="auth-retry-btn" style="background:#1565C0;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;font-weight:600;cursor:pointer">Повторить</button></div>';
    // Обработчик вешается на свежесозданную кнопку; при клике innerHTML
    // заменяется на спиннер — кнопка и обработчик удаляются, дублей нет.
    _overlay.querySelector('#auth-retry-btn').addEventListener('click', function () {
      if (_roleChecking) return;
      _diag('role:retry-click', 'повторная проверка по кнопке');
      _overlay.innerHTML = SPINNER_HTML;
      _checkRole(session);
    });
  }

  // Проверка роли — вызывается, когда клиент гарантированно определился с сессией
  function _checkRole(session) {
    _diag('role:start', session ? 'has session' : 'no session');
    if (!session) {
      _diag('role:no-session', '→ login');
      _toLogin();
      return;
    }
    if (_roleChecking) return;
    _roleChecking = true;
    var _email = session.user.email || '';

    var pref = _netPref();
    var delay = pref === 'rpc' ? 0 : ROLE_HEDGE_DELAY_MS;
    var settled = false;
    var getFailed = false, rpcFailed = false, rpcStarted = false;
    var getCtrl = new AbortController();
    var rpcCtrl = new AbortController();
    var hedgeTimer = null;
    // Общий потолок: оба канала молчат 12с → обрыв и кнопка «Повторить»
    var deadline = setTimeout(function () {
      if (settled) return;
      settled = true;
      _diag('role:unavailable', 'оба канала молчат ' + ROLE_TIMEOUT_MS + 'мс → кнопка «Повторить»');
      getCtrl.abort();
      rpcCtrl.abort();
      _roleChecking = false;
      _showRetry(session);
    }, ROLE_TIMEOUT_MS);

    function _cleanup() {
      clearTimeout(deadline);
      if (hedgeTimer) clearTimeout(hedgeTimer);
    }

    function _bothDead() {
      if (settled) return;
      settled = true;
      _cleanup();
      _roleChecking = false;
      _diag('role:unavailable', 'оба канала неудачны → кнопка «Повторить»');
      _showRetry(session);
    }

    // Успешный ответ канала (data может быть null — валидное «роли нет»)
    function _apply(data, chan) {
      if (settled) return;
      settled = true;
      _cleanup();
      if (chan === 'get') {
        rpcCtrl.abort(); // проигравший rpc обрывается (резолвится {error} → _chanFail при settled молчит)
        if (pref === 'rpc') {
          _netPrefClear();
          _diag('net:pref', 'GET победил при tt_net_pref=rpc — ключ удалён (сеть выздоровела)');
        }
      } else {
        // Любая победа rpc = канал GET медленный или мёртвый → запоминаем rpc
        _netPrefSet();
        _diag('net:pref', 'rpc выиграл гонку — tt_net_pref=rpc');
        getCtrl.abort(); // проигравший GET
      }
      if (!data) {
        // Аккаунт есть, но роли в tt_users нет — доступа к системе нет
        _roleChecking = false;
        _diag('role:not-found', 'нет записи в tt_users (' + chan + ') → signOut');
        _sb.auth.signOut().then(_toLogin);
        return;
      }
      try {
        _roleChecking = false;
        _user = data;
        _user.email = _email;
        _diag(chan === 'rpc' ? 'role:rpc-ok' : 'role:ok', _user.role);
        document.body.classList.add('role-' + _user.role);
        _overlay.style.display = 'none';
        window.Auth.isReady = true;
        _diag('auth:ready', 'dispatch auth-ready');
        document.dispatchEvent(new Event('auth-ready'));
      } catch (err) {
        // Исключение в обработке результата (не транспорт) — как раньше, → login
        _diag('role:exception', ((err && err.message) || String(err)) + ' → login');
        _toLogin();
      }
    }

    // Ошибка/обрыв канала: сеть НЕ разлогинивает — ждём второй канал
    function _chanFail(chan, why) {
      if (chan === 'get') {
        getFailed = true;
        if (settled) return; // abort проигравшего — тихо, tt_net_pref уже записан в _apply
        _diag('role:get-fail', why);
        if (!rpcStarted) {
          if (hedgeTimer) clearTimeout(hedgeTimer);
          _startRpc(); // GET упал раньше хеджа — rpc немедленно
        } else if (rpcFailed) {
          _bothDead();
        }
      } else {
        rpcFailed = true;
        if (settled) return;
        _diag('role:rpc-fail', why);
        if (getFailed) _bothDead(); // иначе ждём GET (его оборвёт общий deadline)
      }
    }

    function _startRpc() {
      if (rpcStarted || settled) return;
      rpcStarted = true;
      _diag('role:rpc-start', 'POST rpc tt_whoami');
      _sb.rpc('tt_whoami').abortSignal(rpcCtrl.signal).then(function (result) {
        if (result.error) {
          _chanFail('rpc', result.error.message || result.error.code || 'неизвестная ошибка');
          return;
        }
        // rpc отдаёт jsonb: объект-строку tt_users или null — семантика та же, что maybeSingle
        _apply(result.data, 'rpc');
      }, function (err) {
        _chanFail('rpc', (err && err.message) || String(err));
      });
    }

    _diag('role:attempt', delay === 0 ? 'GET tt_users + rpc сразу (tt_net_pref=rpc)'
      : 'GET tt_users; rpc через ' + delay + 'мс, если GET молчит');
    _sb.from('tt_users').select('user_id,role,display_name')
      .eq('user_id', session.user.id).abortSignal(getCtrl.signal).maybeSingle()
      .then(function (result) {
        if (result.error) {
          _chanFail('get', result.error.message || result.error.code || 'неизвестная ошибка');
          return;
        }
        _apply(result.data, 'get');
      }, function (err) {
        _chanFail('get', (err && err.message) || String(err));
      });
    if (delay === 0) _startRpc();
    else hedgeTimer = setTimeout(_startRpc, delay);
  }

  /* ═══ Probe и выбор базы (см. комментарий у SUPA_BASES) ═══ */

  // Канал жив = любой ответ со статусом <500 за PROBE_TIMEOUT_MS
  function _probe(base) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); reject(new Error('таймаут ' + PROBE_TIMEOUT_MS + 'мс')); }, PROBE_TIMEOUT_MS);
      fetch(base + '/auth/v1/health', { headers: { apikey: ANON }, signal: ctrl.signal, cache: 'no-store' })
        .then(function (r) {
          clearTimeout(timer);
          if (r.status < 500) resolve(base);
          else reject(new Error('status ' + r.status));
        }, function (e) {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  // Обе базы наперегонки; победитель — первый живой ответ; обе мертвы → null
  function _probeFirst() {
    return new Promise(function (resolve) {
      var left = SUPA_BASES.length;
      var done = false;
      SUPA_BASES.forEach(function (base) {
        _probe(base).then(function () {
          if (done) return;
          done = true;
          resolve(base);
        }, function () {
          left--;
          if (!done && left === 0) resolve(null);
        });
      });
    });
  }

  /* Фоновая проверка кешированной базы: мертва при живой второй →
     перезаписать tt_base; reload — максимум один раз (флаг в sessionStorage)
     и только пока auth ещё не готов (страница не загрузила данные). */
  function _recheckBase(cached) {
    _probe(cached).then(function () {
      _diag('base:recheck', 'кешированная база жива');
    }, function (e) {
      var other = SUPA_BASES[cached === SUPA_BASES[0] ? 1 : 0];
      _diag('base:recheck', 'кеш мёртв (' + ((e && e.message) || e) + ') — probe ' + other);
      _probe(other).then(function () {
        try { localStorage.setItem(BASE_KEY, other); } catch (err) { return; }
        _diag('base:recheck', 'tt_base → ' + other);
        var reloaded = null;
        try { reloaded = sessionStorage.getItem(BASE_RELOAD_FLAG); } catch (err) { reloaded = '1'; } // private mode: без reload, чтобы не зациклиться
        if (!reloaded && !window.Auth.isReady) {
          try { sessionStorage.setItem(BASE_RELOAD_FLAG, '1'); } catch (err) { return; }
          _diag('base:reload', 'перезагрузка на живую базу');
          window.location.reload();
        }
      }, function () {
        _diag('base:recheck', 'обе базы не отвечают — остаёмся на кеше');
      });
    });
  }

  // → Promise<база>; кеш возвращается мгновенно, probe только без кеша
  function _pickBase() {
    if (window.location.protocol !== 'https:') {
      _diag('base:pick', 'локальная разработка → прямой URL');
      return Promise.resolve(SUPA_BASES[1]);
    }
    var cached = null;
    try { cached = localStorage.getItem(BASE_KEY); } catch (e) { /* private mode */ }
    if (cached && SUPA_BASES.indexOf(cached) !== -1) {
      _diag('base:pick', 'cached: ' + cached);
      _recheckBase(cached);
      return Promise.resolve(cached);
    }
    _diag('base:probe', 'кеша нет — обе базы наперегонки');
    return _probeFirst().then(function (winner) {
      if (winner) {
        try { localStorage.setItem(BASE_KEY, winner); } catch (e) { /* private mode */ }
        _diag('base:pick', 'probe: ' + winner);
        return winner;
      }
      _diag('base:pick', 'fallback: обе мертвы → прокси (дефолт), tt_base не пишем');
      return SUPA_BASES[0];
    });
  }

  function _init() {
    _pickBase().then(_start);
  }

  function _start(base) {
    _diag('auth:init', 'createClient, base=' + base);
    _sb = supabase.createClient(base, ANON, {
      auth: { lock: _lockWithTimeout, storageKey: STORAGE_KEY }
    });

    /* Готовность сессии — только по событию INITIAL_SESSION (или SIGNED_IN):
       к этому моменту клиент завершил внутренний _initialize (восстановление
       сессии из storage / refresh) и гарантированно подписывает запросы JWT.
       Сырой getSession() сразу после createClient конкурирует с инициализацией
       и мог отдавать «нет сессии» → запросы уходили с anon-ключом → RLS
       возвращала пустые списки без ошибок («первый заход пустой, F5 чинит»). */
    var _settled = false; // обрабатываем ровно одно событие → auth-ready ровно один раз
    _sb.auth.onAuthStateChange(function (event, session) {
      // Лог каждого события; о сессии — только факт и TTL, без токенов
      var sess = 'no session';
      if (session) {
        var ttl = session.expires_at ? Math.round(session.expires_at - Date.now() / 1000) : null;
        sess = 'has session' + (ttl === null ? '' : ', истекает через ' + ttl + 'с');
      }
      _diag('auth:event', event + ' (' + sess + ')' + (_settled ? ' [settled, игнор]' : ''));
      if (_settled) return;
      if (event !== 'INITIAL_SESSION' && event !== 'SIGNED_IN') return;
      _settled = true;
      // setTimeout(0): колбэк onAuthStateChange выполняется под внутренним локом
      // клиента — запрос tt_users прямо из колбэка привёл бы к дедлоку.
      setTimeout(function () { _checkRole(session); }, 0);
    });
  }

  function signOut() {
    _sb.auth.signOut().then(function () {
      window.location.replace('/login.html');
    });
  }

  window.Auth = {
    isReady: false,
    signOut: signOut,
    getRole: function () { return _user ? _user.role : null; },
    getUser: function () { return _user; },
    getSupabase: function () { return _sb; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
