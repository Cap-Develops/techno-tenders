/* Учёт тендеров — словари, форматтеры, обёртки запросов.
   Требует auth.js (window.Auth) на защищённых страницах. */
(function () {

  // ═══ СЛОВАРЬ СТАТУСОВ (код БД → подпись + цвета в палитре конструктора) ═══
  var STATUSES = {
    preparing:     { label: 'Подготовить заявку',      bg: '#FFF3E0', color: '#E65100' }, // жёлтый (в работе)
    submitted:     { label: 'Заявка подана',           bg: '#E3F2FD', color: '#1565C0' }, // синий (активный)
    signing:       { label: 'Подписание контракта',    bg: '#E3F2FD', color: '#0D47A1' }, // синий тёмный (активный)
    won:           { label: 'Контракт заключен',       bg: '#E8F5E9', color: '#2E7D32' }, // зелёный
    lost:          { label: 'Проиграли',               bg: '#FFEBEE', color: '#C62828' }, // красный
    rejected:      { label: 'Отклонили',               bg: '#FFEBEE', color: '#C62828' }, // красный
    declined:      { label: 'Отказались от участия',   bg: '#ECEFF1', color: '#607D8B' }, // серый
    cancelled:     { label: 'Отменён',                 bg: '#ECEFF1', color: '#607D8B' }, // серый
    not_concluded: { label: 'Контракт не заключен',    bg: '#ECEFF1', color: '#546E7A' }  // серый
  };
  var STATUS_ORDER = ['preparing', 'submitted', 'signing', 'won', 'lost', 'rejected', 'declined', 'cancelled', 'not_concluded'];
  var ACTIVE_STATUSES = ['preparing', 'submitted', 'signing'];

  function statusInfo(code) {
    return STATUSES[code] || { label: code || '—', bg: '#ECEFF1', color: '#607D8B' };
  }

  // ═══ ФОРМАТТЕРЫ ═══

  // 1234567.89 → «1 234 567,89 ₽»
  function fmtMoney(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
  }

  // '2026-07-15' → «15.07.2026»
  function fmtDate(iso) {
    if (!iso) return '—';
    var s = String(iso).slice(0, 10).split('-');
    if (s.length !== 3) return String(iso);
    return s[2] + '.' + s[1] + '.' + s[0];
  }

  // Закон по длине номера извещения: 11 цифр → 223, 19 цифр → 44
  function lawByNumber(number) {
    var digits = String(number || '').replace(/\D/g, '');
    if (digits.length === 11) return '223';
    if (digits.length === 19) return '44';
    return 'other';
  }
  function lawLabel(law) {
    if (law === '223') return '223-ФЗ';
    if (law === '44') return '44-ФЗ';
    return '—';
  }

  // ═══ ОТ КАКОЙ КОМПАНИИ ПОДАЁТСЯ ЗАЯВКА (код БД → подписи) ═══
  var BIDDERS = {
    ti:   { label: 'ООО "Техноинтеллект"', short: 'ТИ' },
    ntne: { label: 'ООО "НТНЭ"',           short: 'НТНЭ' }
  };
  // null-safe: null/неизвестный код → '' (старые тендеры без значения)
  function bidderLabel(code) { return (code && BIDDERS[code]) ? BIDDERS[code].label : ''; }
  function bidderShort(code) { return (code && BIDDERS[code]) ? BIDDERS[code].short : ''; }

  // ═══ ДАННЫЕ (все функции бросают Error при ошибке запроса) ═══

  function _sb() {
    if (!window.Auth || !Auth.getSupabase()) throw new Error('Auth не инициализирован');
    return Auth.getSupabase();
  }
  function _diag(step, detail) {
    if (window.TTDiag && window.TTDiag.log) window.TTDiag.log(step, detail);
  }
  function _unwrap(r) {
    if (r.error) {
      _diag('query:error', r.error.message || 'Ошибка запроса');
      throw new Error(r.error.message || 'Ошибка запроса');
    }
    return r.data;
  }

  /* ═══ Hedged-чтение: GET и POST rpc наперегонки ═══
     Оборачиваются: listTenders, listPayments, getBalance, getTender, документы.
     НЕ оборачиваются lookupTender / lookupInn — у них свои ретраи на стороне
     Edge Function. Мутации ходят по своей схеме (см. блок ниже).
     Зачем: у части машин локальный софт (антивирус/расширение) «отравляет»
     запросы к /rest/v1/<таблица> — GET виснет без ответа, а POST проходят.
     Вместо последовательных попыток (GET → таймаут → rpc) оба канала бегут
     наперегонки: GET стартует сразу; если за HEDGE_DELAY_MS не ответил —
     параллельно стартует POST rpc('tt_page_data') (security invoker, тот же
     RLS). Побеждает первый успешный результат; проигравший GET обрывается
     через abortSignal, проигравший rpc игнорируется (общий кэшированный
     промис). Оба упали — reject с внятной ошибкой.
     Память канала: localStorage tt_net_pref='rpc' ставится при ЛЮБОЙ победе
     rpc — проигрыш GET в гонке уже означает, что канал GET медленный или
     мёртвый. При 'rpc' хедж-задержка = 0 (rpc сразу вместе с GET) и мутации
     идут сразу через rpc. GET победил при 'rpc' — ключ удаляется (сеть
     выздоровела). Без UI.
     На здоровой сети GET отвечает за сотни мс — rpc не дёргается вовсе.
     Промис rpc кэшируется на 2с, чтобы параллельные обёртки (тендеры +
     платежи + баланс) дёргали rpc один раз. Всё логируется в TTDiag (тихо). */
  var HEDGE_DELAY_MS = 400;
  var READ_TIMEOUT_MS = 12000; // потолок ожидания одного канала чтения
  var NET_PREF_KEY = 'tt_net_pref';

  function _netPref() { try { return localStorage.getItem(NET_PREF_KEY); } catch (e) { return null; } }
  function _netPrefSet() { try { localStorage.setItem(NET_PREF_KEY, 'rpc'); } catch (e) { /* private mode */ } }
  function _netPrefClear() { try { localStorage.removeItem(NET_PREF_KEY); } catch (e) { /* private mode */ } }

  var RPC_CACHE_MS = 2000;
  var _rpcPromise = null;   // общий промис rpc('tt_page_data') для параллельных обёрток
  var _rpcPromiseAt = 0;
  function _pageDataRpc() {
    var now = Date.now();
    if (_rpcPromise && (now - _rpcPromiseAt) < RPC_CACHE_MS) return _rpcPromise;
    _rpcPromiseAt = now;
    var p = _sb().rpc('tt_page_data').then(_unwrap);
    _rpcPromise = p;
    p.then(null, function () { if (_rpcPromise === p) _rpcPromise = null; }); // ошибка не кэшируется
    return p;
  }
  // Кусок ответа rpc в формате соответствующего GET-запроса
  function _fromPageData(d, rpcKey) {
    if (rpcKey === 'balance') return [{ balance: d ? d.balance : null }]; // как строки view tt_balance
    return (d && d[rpcKey]) || [];
  }

  /* getFactory(signal) → промис данных (reject при ошибке; signal — реальный
     обрыв fetch через .abortSignal supabase-js);
     rpcExtract(pageData) → кусок ответа rpc (throw = канал rpc неудачен). */
  function _hedged(getFactory, rpcExtract, label) {
    return new Promise(function (resolve, reject) {
      var pref = _netPref();
      var delay = pref === 'rpc' ? 0 : HEDGE_DELAY_MS;
      var t0 = Date.now();
      var settled = false;
      var getFailed = false, getErr = null;
      var rpcStarted = false, rpcFailed = false, rpcErr = null;
      var hedgeTimer = null;
      var getCtrl = new AbortController();
      var getTimer = setTimeout(function () { getCtrl.abort(); }, READ_TIMEOUT_MS); // вечно висящий GET → обрыв

      _diag(label + ':start', delay === 0 ? 'GET + rpc сразу (tt_net_pref=rpc)'
        : 'GET; rpc через ' + delay + 'мс, если GET молчит');

      function finishFail() {
        if (settled) return;
        settled = true;
        var gm = getErr ? ((getErr.message) || String(getErr)) : '';
        var rm = rpcErr ? ((rpcErr.message) || String(rpcErr)) : '';
        _diag(label + ':dead', 'оба канала неудачны: GET «' + gm + '», rpc «' + rm + '»');
        // Внятная ошибка: первое содержательное сообщение (не abort/таймаут)
        var meaningful = [rm, gm].filter(function (m) { return m && !/abort|таймаут/i.test(m); })[0];
        reject(new Error(meaningful || 'Сервер не отвечает - проверьте интернет и обновите страницу'));
      }

      function startRpc() {
        if (rpcStarted || settled) return;
        rpcStarted = true;
        _diag(label + ':rpc-start', 'POST rpc tt_page_data');
        var timer = null;
        var timeout = new Promise(function (_res, rej) {
          timer = setTimeout(function () { rej(new Error('Таймаут rpc ' + (READ_TIMEOUT_MS / 1000) + 'с')); }, READ_TIMEOUT_MS);
        });
        Promise.race([_pageDataRpc(), timeout]).then(function (d) {
          clearTimeout(timer);
          return rpcExtract(d); // throw → канал rpc неудачен (catch ниже)
        }).then(function (data) {
          if (settled) return;
          settled = true;
          _diag(label + ':rpc-ok', (Date.now() - t0) + 'мс');
          // Любая победа rpc = канал GET медленный или мёртвый → запоминаем rpc
          _netPrefSet();
          _diag('net:pref', 'rpc выиграл гонку — tt_net_pref=rpc');
          if (!getFailed) getCtrl.abort(); // обрыв проигравшего GET
          resolve(data);
        }).catch(function (err) {
          clearTimeout(timer);
          rpcFailed = true;
          rpcErr = err;
          if (settled) return;
          _diag(label + ':rpc-fail', (err && err.message) || String(err));
          if (getFailed) finishFail(); // иначе ждём GET — его оборвёт собственный таймаут
        });
      }

      Promise.resolve().then(function () { return getFactory(getCtrl.signal); }).then(function (data) {
        clearTimeout(getTimer);
        if (settled) return; // rpc уже победил — результат GET игнорируем
        settled = true;
        if (hedgeTimer) clearTimeout(hedgeTimer); // rpc ещё не стартовал — и не стартует
        if (pref === 'rpc') {
          _netPrefClear();
          _diag('net:pref', 'GET победил при tt_net_pref=rpc — ключ удалён (сеть выздоровела)');
        }
        _diag(label + ':get-ok', (Array.isArray(data) ? data.length + ' строк, ' : '') + (Date.now() - t0) + 'мс');
        resolve(data);
      }, function (err) {
        // AbortError проигравшего GET гасится здесь — до window.unhandledrejection не доходит
        clearTimeout(getTimer);
        getFailed = true;
        getErr = err;
        if (settled) return; // AbortError проигравшего GET — tt_net_pref уже записан выше
        _diag(label + ':get-fail', ((err && err.message) || String(err)) + ', ' + (Date.now() - t0) + 'мс');
        if (!rpcStarted) {
          if (hedgeTimer) clearTimeout(hedgeTimer);
          startRpc(); // GET упал раньше хеджа — rpc немедленно
        } else if (rpcFailed) {
          finishFail();
        }
      });

      if (delay === 0) startRpc();
      else hedgeTimer = setTimeout(startRpc, delay);
    });
  }

  /* ═══ Мутации: тот же обход «отравленного» REST, но без параллельной гонки ═══
     Диагноз общий с чтениями: у части машин запросы к /rest/v1/<таблица>
     виснут без ответа, а POST /rest/v1/rpc/<имя> проходят. У записи, в отличие
     от чтения, оба канала одновременно пускать нельзя — два INSERT задвоят
     строку. Отсюда два режима:

       _mutationPick   — РОВНО один сетевой вызов, канал выбирает память
                         tt_net_pref. Для неидемпотентных INSERT (новый тендер,
                         платёж, строка документа): обрыв fetch не доказывает,
                         что запрос не долетел, поэтому повтора нет вовсе —
                         страницы сверяют факт через confirmAfterTimeout.

       _hedgedMutation — сначала REST; молчит MUT_HEDGE_MS — обрываем его
                         (реальный abort, второго живого запроса нет) и
                         повторяем через rpc. Только для идемпотентных
                         UPDATE/DELETE: даже если оборванный REST успел
                         примениться, rpc даст тот же результат.

     Общий потолок обоих режимов — MUTATION_TIMEOUT_MS; при его исчерпании
     ошибка получает code='timeout' — метка канала, а не отказа: сервер мог
     применить запись, а ответ не дошёл. Страницы по ней перечитывают данные
     (confirmAfterTimeout) вместо красной ошибки.
     Победа rpc в хедже пишет tt_net_pref='rpc' — дальше и чтения, и мутации
     идут через rpc сразу. */
  var MUTATION_TIMEOUT_MS = 12000;
  var MUT_HEDGE_MS = 2000;
  var MUTATION_TIMEOUT_MSG = 'Сервер не ответил за 12 секунд - проверьте интернет и повторите';

  /* Один канал = один сетевой вызов. factory(signal) → билдер supabase-js
     (резолвится {data, error}). ctrl — внешний AbortController, если каналом
     надо управлять снаружи (хедж обрывает REST своим таймером). */
  function _oneShot(factory, label, budgetMs, ctrl) {
    ctrl = ctrl || new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      _diag(label + ':timeout', 'нет ответа за ' + Math.round(budgetMs / 1000) + 'с → abort');
      ctrl.abort();
    }, budgetMs);
    function _err(msg) {
      var final = timedOut ? MUTATION_TIMEOUT_MSG : (msg || 'Ошибка запроса');
      _diag(label + ':fail', final);
      var err = new Error(final);
      if (timedOut) err.code = 'timeout';
      return err;
    }
    return Promise.resolve().then(function () { return factory(ctrl.signal); }).then(function (r) {
      clearTimeout(timer);
      if (r.error) throw _err(r.error.message);
      return r.data;
    }, function (e) {
      clearTimeout(timer);
      throw _err(e && e.message);
    });
  }

  // Неидемпотентная мутация: канал по памяти, ровно один вызов, без повторов
  function _mutationPick(restFactory, rpcFactory, label) {
    var useRpc = _netPref() === 'rpc';
    _diag(label + ':start', useRpc ? 'один вызов: rpc (tt_net_pref=rpc)' : 'один вызов: REST');
    return _oneShot(useRpc ? rpcFactory : restFactory, label, MUTATION_TIMEOUT_MS);
  }

  // Идемпотентная мутация (UPDATE / DELETE): REST → обрыв → rpc
  function _hedgedMutation(restFactory, rpcFactory, label) {
    if (_netPref() === 'rpc') {
      _diag(label + ':start', 'один вызов: rpc (tt_net_pref=rpc)');
      return _oneShot(rpcFactory, label, MUTATION_TIMEOUT_MS);
    }
    var t0 = Date.now();
    var restCtrl = new AbortController();
    _diag(label + ':start', 'REST; rpc через ' + MUT_HEDGE_MS + 'мс, если REST молчит');
    return new Promise(function (resolve, reject) {
      var hedged = false, restDone = false;

      var hedgeTimer = setTimeout(function () {
        if (restDone) return;
        hedged = true;
        _diag(label + ':hedge', 'REST молчит ' + MUT_HEDGE_MS + 'мс → обрыв, повтор через rpc');
        restCtrl.abort(); // реальный обрыв: два запроса одновременно не живут
        _oneShot(rpcFactory, label, MUTATION_TIMEOUT_MS - (Date.now() - t0)).then(function (data) {
          _netPrefSet();
          _diag('net:pref', 'rpc выиграл мутацию — tt_net_pref=rpc');
          _diag(label + ':rpc-ok', (Date.now() - t0) + 'мс');
          resolve(data);
        }, reject);
      }, MUT_HEDGE_MS);

      _oneShot(restFactory, label, MUTATION_TIMEOUT_MS, restCtrl).then(function (data) {
        restDone = true;
        if (hedged) return; // обрыв уже случился — решение за rpc
        clearTimeout(hedgeTimer);
        _diag(label + ':rest-ok', (Date.now() - t0) + 'мс');
        resolve(data);
      }, function (err) {
        restDone = true;
        if (hedged) return; // это AbortError нашего же хеджа — гасим здесь
        clearTimeout(hedgeTimer);
        reject(err);
      });
    });
  }

  /* ═══ Сверка факта после таймаута мутации ═══
     Таймаут - молчание канала, а не отказ сервера: запись могла примениться.
     Страница ждёт CONFIRM_DELAY_MS (реплика/кэш успевают отдать свежее) и
     перечитывает данные через check(). check() → Promise<boolean>; любая
     ошибка перечитывания = «не подтвердилось» (false), промис не реджектится -
     вызывающая сторона обязана разблокировать кнопку ровно один раз. */
  var CONFIRM_DELAY_MS = 1500;

  function isTimeout(e) { return !!(e && e.code === 'timeout'); }

  function confirmAfterTimeout(check) {
    return new Promise(function (res) { setTimeout(res, CONFIRM_DELAY_MS); })
      .then(check)
      .then(function (ok) {
        _diag('confirm:result', ok ? 'изменение применилось' : 'подтвердить не удалось');
        return !!ok;
      }, function (e) {
        _diag('confirm:fail', (e && e.message) || String(e));
        return false;
      });
  }

  function listTenders() {
    return _hedged(function (signal) {
      return _sb().from('tt_tenders').select('*').range(0, 9999).abortSignal(signal).then(_unwrap);
    }, function (d) { return _fromPageData(d, 'tenders'); }, 'tenders');
  }

  function getTender(id) {
    return _hedged(function (signal) {
      return _sb().from('tt_tenders').select('*').eq('id', id).abortSignal(signal).maybeSingle().then(_unwrap)
        .then(function (t) {
          if (!t) throw new Error('Тендер не найден');
          return t;
        });
    }, function (d) {
      // rpc-фолбэк по факту победы rpc: ищем тендер в общем ответе tt_page_data.
      // Ответ свежий (кэш промиса 2с), поэтому отсутствие в списке — валидное
      // «не найдено»; приоритет у GET-результата: throw здесь = канал rpc
      // неудачен, _hedged дождётся GET и отдаст его результат, если тот жив.
      var list = (d && d.tenders) || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
      throw new Error('Тендер не найден');
    }, 'tender');
  }

  /* insert (без id) или update (с id).
     rpc tt_save_tender(p) меняет только пришедшие в p ключи — те же поля, что
     и PATCH, тот же RLS и тот же триггер-guard бухгалтера (security invoker). */
  function saveTender(obj) {
    var rec = Object.assign({}, obj);
    delete rec.total; // total - generated column
    delete rec.created_at;
    delete rec.updated_at;
    function rest(signal) {
      return rec.id
        ? _sb().from('tt_tenders').update(rec).eq('id', rec.id).select().single().abortSignal(signal)
        : _sb().from('tt_tenders').insert(rec).select().single().abortSignal(signal);
    }
    function rpc(signal) {
      return _sb().rpc('tt_save_tender', { p: rec }).abortSignal(signal);
    }
    // UPDATE идемпотентен - хеджируем. INSERT нет: обрыв не доказывает, что
    // запрос не долетел, а повтор создал бы второй тендер.
    return rec.id ? _hedgedMutation(rest, rpc, 'saveTender')
                  : _mutationPick(rest, rpc, 'saveTender');
  }

  /* Удаление тендера. Строки tt_documents уйдут каскадом, а файлы в Storage
     каскад не видит - поэтому сначала снимаем список документов и удаляем их
     файлы из бакета, потом удаляем сам тендер. Список не пришёл (сеть) -
     удаление тендера всё равно выполняем: это явное намерение пользователя. */
  function deleteTender(id) {
    return listDocuments(id).then(function (docs) { return docs || []; }, function (e) {
      _diag('deleteTender:docs-fail', (e && e.message) || String(e));
      return [];
    }).then(function (docs) {
      if (!docs.length) return null;
      var paths = docs.map(function (d) { return d.storage_path; });
      return _storageOp(function () {
        return _sb().storage.from(DOC_BUCKET).remove(paths);
      }, 'deleteTenderFiles', MUTATION_TIMEOUT_MS).catch(function (e) {
        _diag('deleteTender:files-fail', (e && e.message) || String(e));
        return null; // файл-сирота хуже неудалённого тендера не делает
      });
    }).then(function () {
      return _hedgedMutation(function (signal) {
        return _sb().from('tt_tenders').delete().eq('id', id).abortSignal(signal);
      }, function (signal) {
        return _sb().rpc('tt_delete_tender', { p_id: id }).abortSignal(signal);
      }, 'deleteTender');
    });
  }

  // Дашборд: инлайн-смена статуса (owner). Обновляет ТОЛЬКО поле status.
  function updateTenderStatus(id, status) {
    return _hedgedMutation(function (signal) {
      return _sb().from('tt_tenders').update({ status: status }).eq('id', id).select().single().abortSignal(signal);
    }, function (signal) {
      return _sb().rpc('tt_set_status', { p_id: id, p_status: status }).abortSignal(signal);
    }, 'updateStatus');
  }

  function listPayments() {
    return _hedged(function (signal) {
      return _sb().from('tt_payments').select('*').order('paid_at', { ascending: false }).range(0, 9999).abortSignal(signal).then(_unwrap);
    }, function (d) { return _fromPageData(d, 'payments'); }, 'payments'); // rpc отдаёт payments уже в порядке paid_at desc
  }

  // INSERT - без хеджа: повтор задвоил бы платёж (created_by в rpc берётся из auth.uid())
  function addPayment(obj) {
    return _mutationPick(function (signal) {
      return _sb().from('tt_payments').insert(obj).select().single().abortSignal(signal);
    }, function (signal) {
      return _sb().rpc('tt_add_payment', { p: obj }).abortSignal(signal);
    }, 'addPayment');
  }

  // View tt_balance → число (отрицательное = компания должна специалисту)
  function getBalance() {
    return _hedged(function (signal) {
      return _sb().from('tt_balance').select('*').abortSignal(signal).then(_unwrap);
    }, function (d) { return _fromPageData(d, 'balance'); }, 'balance').then(function (rows) {
      var row = rows && rows[0];
      if (!row) return 0;
      if (row.balance !== undefined) return Number(row.balance) || 0;
      // защита от иного имени колонки во view
      for (var k in row) { if (typeof row[k] === 'number' || !isNaN(Number(row[k]))) return Number(row[k]); }
      return 0;
    });
  }

  /**
   * Автозаполнение по номеру извещения через Edge Function (источник - Тендерплан).
   * Принимает строку number ИЛИ объект { id } - прямой запрос карточки по _id
   * Тендерплана (выбор из нескольких совпадений короткого номера).
   * Resolved-ответ надо проверять на data.ok === false (upstream_unavailable).
   * При ошибке бросает Error с русским текстом и свойством .code.
   */
  function lookupTender(numberOrRef) {
    var body = (numberOrRef && typeof numberOrRef === 'object')
      ? { id: String(numberOrRef.id) }
      : { number: String(numberOrRef) };
    return _sb().functions.invoke('tender-lookup', { body: body }).then(function (r) {
      if (!r.error) return r.data;
      var status = r.error.context && r.error.context.status;
      var bodyPromise = Promise.resolve(null);
      if (r.error.context && typeof r.error.context.json === 'function') {
        try {
          bodyPromise = r.error.context.json().catch(function () { return null; });
        } catch (_e) { /* тело уже прочитано / не Response */ }
      }
      return bodyPromise.then(function (body) {
        var code = (body && body.error) || null;
        var msg;
        if (code === 'bad_number') {
          msg = 'Неверный номер: 11/19 цифр или номер площадки (буквы, цифры, дефис)';
        } else if (code === 'unauthorized' || status === 401 || status === 403) {
          msg = 'Сессия истекла - войдите заново';
        } else {
          msg = 'Автопоиск недоступен, заполните вручную';
        }
        var err = new Error(msg);
        err.code = code || status || null;
        throw err;
      });
    });
  }

  /* ═══ ДОКУМЕНТЫ ТЕНДЕРА (приватный бакет Storage `tender-docs`) ═══
     Файл лежит в Storage по ключу <tender_id>/<uuid>.<ext> (без кириллицы и
     пробелов), оригинальное имя - в tt_documents.file_name. Скачивание только
     по signed URL на 300с: бакет приватный, публичных ссылок нет. */
  var DOC_BUCKET = 'tender-docs';
  // Иконка по расширению файла (тип документа в UI больше не выбирается -
  // пользователь пишет название сам, колонка doc_type осталась с default 'other')
  var DOC_EXT_ICONS = {
    pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
    zip: '🗜', rar: '🗜', jpg: '🖼', jpeg: '🖼', png: '🖼', sig: '🔏'
  };
  function docIcon(fileName) {
    return DOC_EXT_ICONS[docExt(fileName)] || '📎';
  }
  /* Расширение → mime. Список 1:1 с allowed_mime_types бакета; .sig (открепленная
     подпись с площадки) идёт как octet-stream. Тип берём ПО РАСШИРЕНИЮ, а не из
     file.type: браузер для .sig даёт пусто, а для .rar - разные варианты, и бакет
     отбил бы такую загрузку. */
  var DOC_EXT_MIME = {
    pdf:  'application/pdf',
    doc:  'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:  'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip:  'application/zip',
    rar:  'application/x-rar-compressed',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
    sig:  'application/octet-stream'
  };
  var DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.jpg,.jpeg,.png,.sig';
  var DOC_MAX_BYTES = 20 * 1024 * 1024;
  var DOC_SIGNED_URL_TTL = 300;  // секунд
  var UPLOAD_TIMEOUT_MS = 60000; // файлы тяжёлые - потолок больше, чем у обычных мутаций

  // 4096 → «4,0 КБ»; 3145728 → «3,0 МБ»
  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  function docExt(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // Ответы Storage приходят по-английски - переводим частые
  function _storageMsg(msg) {
    var s = String(msg || 'Ошибка запроса');
    if (/row-level security|Unauthorized|not authorized|403/i.test(s)) return 'Нет прав на эту операцию с документами';
    if (/maximum allowed size|Payload too large|413/i.test(s)) return 'Файл больше 20 МБ';
    if (/mime type/i.test(s)) return 'Недопустимый тип файла';
    if (/already exists|Duplicate/i.test(s)) return 'Файл с таким именем уже загружен';
    return s;
  }

  /* Storage-запрос с таймаутом. Оборвать соединение нельзя: storage-клиент
     supabase-js не принимает AbortSignal - поэтому только Promise.race, висящий
     запрос отпускаем, пользователю отдаём внятную ошибку. Ретраев нет. */
  function _storageOp(factory, label, timeoutMs) {
    var timer = null;
    var timeout = new Promise(function (_res, rej) {
      timer = setTimeout(function () {
        rej(new Error('Сервер не ответил за ' + Math.round(timeoutMs / 1000) + ' секунд - проверьте интернет и повторите'));
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve().then(factory), timeout]).then(function (r) {
      clearTimeout(timer);
      if (r && r.error) {
        var m = _storageMsg(r.error.message);
        _diag(label + ':fail', m);
        throw new Error(m);
      }
      return r ? r.data : null;
    }, function (e) {
      clearTimeout(timer);
      var msg = _storageMsg((e && e.message) || 'Ошибка запроса');
      _diag(label + ':fail', msg);
      throw new Error(msg);
    });
  }

  // Документы одного тендера (hedged, как остальные чтения)
  function listDocuments(tenderId) {
    return _hedged(function (signal) {
      return _sb().from('tt_documents').select('*').eq('tender_id', tenderId)
        .order('created_at', { ascending: true }).range(0, 999).abortSignal(signal).then(_unwrap);
    }, function (d) {
      return _fromPageData(d, 'documents').filter(function (row) {
        return String(row.tender_id) === String(tenderId);
      });
    }, 'documents');
  }

  // Все документы одним запросом (дашборд: скрепка в строке + список в раскрытии)
  function listDocumentsAll() {
    return _hedged(function (signal) {
      return _sb().from('tt_documents').select('*')
        .order('created_at', { ascending: true }).range(0, 9999).abortSignal(signal).then(_unwrap);
    }, function (d) { return _fromPageData(d, 'documents'); }, 'documentsAll');
  }

  /* Загрузка: валидация → Storage → строка в tt_documents.
     title - необязательное название от пользователя (пусто → null, UI покажет
     file_name); doc_type не передаётся - сработает default 'other'.
     Если INSERT упал - только что загруженный файл удаляем, чтобы не плодить
     сирот в бакете (строки нет - файл никем не виден). */
  function uploadDocument(tenderId, file, title) {
    return Promise.resolve().then(function () {
      if (!tenderId) throw new Error('Сначала сохраните тендер - без него файл прикрепить некуда');
      if (!file) throw new Error('Выберите файл');
      if (!file.size) throw new Error('Файл пустой');
      if (file.size > DOC_MAX_BYTES) {
        throw new Error('Файл ' + fmtSize(file.size) + ' - больше разрешённых 20 МБ');
      }
      var ext = docExt(file.name);
      var mime = DOC_EXT_MIME[ext];
      if (!mime) {
        throw new Error('Недопустимый тип файла' + (ext ? ' «.' + ext + '»' : '') +
          '. Разрешены: ' + DOC_ACCEPT.replace(/\./g, '').toUpperCase().split(',').join(', '));
      }
      var docTitle = String(title == null ? '' : title).trim() || null;
      var path = tenderId + '/' + crypto.randomUUID() + '.' + ext;
      // Тип задаём сами: FormData-часть берёт content-type из Blob, а браузерный
      // file.type для .sig пуст - бакет отбил бы такую загрузку.
      var payload = new Blob([file], { type: mime });
      var user = window.Auth && Auth.getUser();
      _diag('uploadDocument:start', ext + ', ' + fmtSize(file.size));
      return _storageOp(function () {
        return _sb().storage.from(DOC_BUCKET).upload(path, payload, { contentType: mime, upsert: false });
      }, 'uploadDocument', UPLOAD_TIMEOUT_MS).then(function () {
        var row = {
          tender_id: tenderId,
          storage_path: path,
          file_name: String(file.name),
          file_size: file.size,
          mime_type: mime,
          title: docTitle,
          uploaded_by: user ? user.user_id : null
        };
        // INSERT - без хеджа (см. _mutationPick); storage_path UNIQUE, но полагаться на это нельзя
        return _mutationPick(function (signal) {
          return _sb().from('tt_documents').insert(row).select().single().abortSignal(signal);
        }, function (signal) {
          return _sb().rpc('tt_add_document', { p: row }).abortSignal(signal);
        }, 'insertDocument').catch(function (err) {
          _diag('uploadDocument:rollback', path);
          return _sb().storage.from(DOC_BUCKET).remove([path]).then(
            function () { throw err; },
            function () { throw err; }
          );
        });
      });
    });
  }

  // Временная ссылка на скачивание (бакет приватный, публичных ссылок нет)
  function getDocumentUrl(storagePath) {
    return _storageOp(function () {
      return _sb().storage.from(DOC_BUCKET).createSignedUrl(storagePath, DOC_SIGNED_URL_TTL);
    }, 'signDocument', MUTATION_TIMEOUT_MS).then(function (d) {
      if (!d || !d.signedUrl) throw new Error('Не удалось получить ссылку на файл');
      return d.signedUrl;
    });
  }

  // Удаление: сначала файл, потом строка. Файла уже нет - строку всё равно чистим.
  function deleteDocument(doc) {
    return _storageOp(function () {
      return _sb().storage.from(DOC_BUCKET).remove([doc.storage_path]);
    }, 'deleteDocumentFile', MUTATION_TIMEOUT_MS).catch(function (e) {
      if (/not.?found|does not exist|404/i.test((e && e.message) || '')) return null;
      throw e;
    }).then(function () {
      return _hedgedMutation(function (signal) {
        return _sb().from('tt_documents').delete().eq('id', doc.id).abortSignal(signal);
      }, function (signal) {
        return _sb().rpc('tt_delete_document', { p_id: doc.id }).abortSignal(signal);
      }, 'deleteDocumentRow');
    });
  }

  window.Common = {
    STATUSES: STATUSES,
    STATUS_ORDER: STATUS_ORDER,
    ACTIVE_STATUSES: ACTIVE_STATUSES,
    statusInfo: statusInfo,
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    lawByNumber: lawByNumber,
    lawLabel: lawLabel,
    BIDDERS: BIDDERS,
    bidderLabel: bidderLabel,
    bidderShort: bidderShort,
    isTimeout: isTimeout,
    confirmAfterTimeout: confirmAfterTimeout,
    listTenders: listTenders,
    getTender: getTender,
    saveTender: saveTender,
    deleteTender: deleteTender,
    updateTenderStatus: updateTenderStatus,
    listPayments: listPayments,
    addPayment: addPayment,
    getBalance: getBalance,
    lookupTender: lookupTender,
    docIcon: docIcon,
    DOC_ACCEPT: DOC_ACCEPT,
    DOC_MAX_BYTES: DOC_MAX_BYTES,
    fmtSize: fmtSize,
    listDocuments: listDocuments,
    listDocumentsAll: listDocumentsAll,
    uploadDocument: uploadDocument,
    getDocumentUrl: getDocumentUrl,
    deleteDocument: deleteDocument
  };
})();

/* ═══ Фаза 4: дополнения (tender.html / balance.html) ═══ */
(function () {

  // Экранирование HTML (для innerHTML-рендера пользовательских данных)
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // «1 234,56» / «1234.56» → 1234.56; пустая строка → null; мусор → NaN
  function parseDecimal(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).trim();
    if (!t) return null;
    return Number(t.replace(/\s/g, '').replace(',', '.'));
  }

  /* ═══ Площадка → https-URL сайта ЭТП (null = неизвестная, ссылки нет) ═══
     Сопоставление по нормализованной подстроке: нижний регистр, без пробелов,
     дефисов и точек. Порядок важен: специфичные алиасы раньше коротких
     («заказрф» раньше «рад»), чтобы не ловить ложные вхождения. */
  var PLATFORM_ALIASES = [
    ['sberbankast', 'https://www.sberbank-ast.ru'],
    ['сбербанкаст', 'https://www.sberbank-ast.ru'],
    ['roseltorg',   'https://www.roseltorg.ru'],
    ['росэлторг',   'https://www.roseltorg.ru'],
    ['еэтп',        'https://www.roseltorg.ru'],
    ['tenderpro',   'https://www.tenderpro.ru'],
    ['тендерпро',   'https://www.tenderpro.ru'],
    ['lotonline',   'https://catalog.lot-online.ru'],
    ['zakazrf',     'https://etp.zakazrf.ru'],
    ['заказрф',     'https://etp.zakazrf.ru'],
    ['fabrikant',   'https://www.fabrikant.ru'],
    ['фабрикант',   'https://www.fabrikant.ru'],
    ['tektorg',     'https://www.tektorg.ru'],
    ['текторг',     'https://www.tektorg.ru'],
    ['тэкторг',     'https://www.tektorg.ru'],
    ['тэктон',      'https://www.tektorg.ru'],
    ['zakupkimos',  'https://zakupki.mos.ru'],
    ['закупкимос',  'https://zakupki.mos.ru'],
    ['газпромбанк', 'https://etpgpb.ru'],
    ['etpgpb',      'https://etpgpb.ru'],
    ['гпб',         'https://etpgpb.ru'],
    ['bidzaar',     'https://bidzaar.com'],
    ['ртс',         'https://www.rts-tender.ru'],
    ['rts',         'https://www.rts-tender.ru'],
    ['b2b',         'https://www.b2b-center.ru'],
    ['б2б',         'https://www.b2b-center.ru'],
    ['рад',         'https://catalog.lot-online.ru']
  ];

  // Произвольный текст поля platform → https-URL площадки или null
  function platformUrl(platform) {
    var s = String(platform == null ? '' : platform).trim();
    if (!s) return null;
    // Уже URL/домен: без пробелов, начинается с латинского хоста ([a-z0-9-]+\.[a-z]{2,})
    if (!/\s/.test(s) && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([\/?#]|$)/i.test(s)) {
      return /^https?:\/\//i.test(s) ? s : 'https://' + s;
    }
    var norm = s.toLowerCase().replace(/[\s.\-]/g, '');
    for (var i = 0; i < PLATFORM_ALIASES.length; i++) {
      if (norm.indexOf(PLATFORM_ALIASES[i][0]) !== -1) return PLATFORM_ALIASES[i][1];
    }
    return null;
  }

  window.Common.esc = esc;
  window.Common.parseDecimal = parseDecimal;
  window.Common.platformUrl = platformUrl;
})();

/* ═══ Автозаполнение реквизитов заказчика по ИНН (Edge Function inn-lookup / DaData) ═══ */
(function () {
  function _innMsg(code, status) {
    if (code === 'bad_inn') return 'Неверный ИНН или ОГРН (10-15 цифр)';
    if (code === 'no_api_key') return 'Автозаполнение по ИНН не настроено (нужен ключ DaData)';
    if (code === 'unauthorized' || status === 401 || status === 403) return 'Сессия истекла - войдите заново';
    return 'Сервис реквизитов недоступен';
  }

  /**
   * Реквизиты организации по ИНН. Резолвится только с {ok:true, found, data};
   * любой ok:false (включая 200 no_api_key / upstream_unavailable) ->
   * Error с русским текстом и свойством .code. Паттерн - как у lookupTender.
   */
  function lookupInn(inn) {
    if (!window.Auth || !Auth.getSupabase()) return Promise.reject(new Error('Auth не инициализирован'));
    return Auth.getSupabase().functions.invoke('inn-lookup', { body: { inn: String(inn) } }).then(function (r) {
      if (!r.error) {
        var d = r.data;
        if (d && d.ok === false) {
          var errResolved = new Error(_innMsg(d.error, null));
          errResolved.code = d.error || null;
          throw errResolved;
        }
        return d;
      }
      var status = r.error.context && r.error.context.status;
      var bodyPromise = Promise.resolve(null);
      if (r.error.context && typeof r.error.context.json === 'function') {
        try {
          bodyPromise = r.error.context.json().catch(function () { return null; });
        } catch (_e) { /* тело уже прочитано / не Response */ }
      }
      return bodyPromise.then(function (body) {
        var code = (body && body.error) || null;
        var err = new Error(_innMsg(code, status));
        err.code = code || status || null;
        throw err;
      });
    });
  }
  window.Common.lookupInn = lookupInn;
})();
