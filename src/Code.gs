/**
 * LINE公式アカウント 予約受付・自動応答 Bot（実演サンプル / 再利用エンジン）
 *
 * 何をする:
 *   LINE Messaging API の Webhook を GAS の doPost(e) で受け、
 *   (1) キーワード自動応答（営業時間・アクセス・メニュー・料金 等。「よくある質問」シートが正）
 *   (2) トーク内予約フロー（候補ボタンで日付→開始時刻 → 空き確認 → 確定 → 台帳記録 → カレンダー登録）
 *   (3) トーク内キャンセル（自分の予約一覧 → 確認 → 取り消し。取り消した枠は自動で開放される）
 *   (4) AI自動応答（キーワードに当たらない自由質問を生成AIで応答／答えられなければ有人・フォーム案内）
 *   を返す。予約は「予約台帳」シートに記録し、二重予約は台帳上の時間帯の重なりで弾く。
 *   店舗情報・よくある質問・メニューは「設定」「よくある質問」「メニュー」シートが正で、
 *   店舗の担当者がスプレッドシート上で書き換えられる。
 *
 * 機能の範囲:
 *   上の (1)〜(4) は常に動く。
 *   前日リマインドだけは CONFIG.ADDONS.REMINDER が true のときだけ動く（既定 false）。
 *   予約の重さ（メニューの所要時間・人数・担当）は、
 *   「メニュー」シートと CONFIG.BUSINESS（askPartySize / STAFF / capacityPerSlot）で店舗ごとに決める。
 *
 * デモモード:
 *   DEMO_MODE=true では LINE Platform へ実送信せず、
 *   Bot が返す応答メッセージ・台帳更新・リマインド文面を Logger に出力する（実LINE不要で動きを見せる）。
 *   店舗「サンプルサロン」やメニュー・料金・担当者はデモ用のサンプルで、実在しない。
 *
 * LINE Messaging API（一次確認 2026-07-15 / developers.line.biz）:
 *   応答:   POST https://api.line.me/v2/bot/message/reply
 *           header: Authorization: Bearer {channelAccessToken}
 *           body:   { replyToken, messages:[...] }  ※ messages は最大5件
 *   プッシュ: POST https://api.line.me/v2/bot/message/push   body: { to:userId, messages:[...] }
 *   Webhook: メッセージイベント { type:'message', replyToken, source.userId, message.type/text }
 *            ポストバック    { type:'postback', replyToken, postback.data }
 *   ポストバックアクション: { type:'postback', data, displayText }
 *   クイックリプライ: どのメッセージにも quickReply.items[] を添えられる。items は最大13件
 *   テンプレート: buttons の actions は最大4件 / confirm は2件 / carousel は10列×各3アクション
 *   ※ 予約日時は「日付を選ぶ → その日の空き開始時刻を選ぶ」の2段（クイックリプライ＋ポストバック）で受ける。
 *      LINEの日時選択UIは最小値・最大値・初期値しか指定できず、埋まっている時刻だけを選べなくすることができない。
 *      空いている候補だけをボタンで出す方式なら、押せる時点で必ず空いている状態になる。
 *      フローの状態は postback data（action=…&menu=…&date=…&time=…）で持ち回るので、Bot 側は状態を保持しない。
 *   署名: X-Line-Signature = base64( HMAC-SHA256(channelSecret, requestBody) )
 *   ※ GASのWebアプリはリクエストヘッダを取得できないため、GAS単体では署名検証ができない
 *      （verifySignature_ は用意しているが、ヘッダを取得できる別の実行環境でのみ使える）。
 */

// ==== 設定（本番はここを差し替える。トークン類はスクリプトプロパティへ）====
var CONFIG = {
  DEMO_MODE: true,     // true: 実送信せずログ出力 / false: 実LINEへ送信
  TIMEZONE: 'Asia/Tokyo',
  LEDGER_SHEET: '予約台帳',

  // 店舗情報。シート初期化用の既定値（「設定」シートが無いときに初回だけ書き込む値）。
  // 運用中はここを直接見ず、「設定」シートが正（シート上で書き換えられる）。
  STORE: {
    name: 'サンプルサロン',
    hours: '10:00〜19:00',
    closed: '毎週火曜',
    access: 'サンプル駅 東口から徒歩5分',
    menu: 'カット ¥4,400 / カラー ¥7,700〜 / パーマ ¥8,800〜',
    tel: '000-0000-0000',
    coupon: '友だち追加限定：初回カット20%OFF'
  },

  // 予約の受付ルール（本番は店舗の営業条件へ）
  BUSINESS: {
    openHour: 10,                 // 受付開始（時）
    closeHour: 19,                // 受付終了（時・この時刻までに終わる予約だけ受ける）
    closedWeekday: 2,             // 定休日 0=日 1=月 2=火 …（火曜定休）
    capacityPerSlot: 1,           // 同じ時間帯に重ねて受けられる人数（席数）。担当を取る運用では使わない
    slotMinutes: 30,              // 候補として出す開始時刻の刻み
    defaultDurationMinutes: 60,   // 「メニュー」シートが空のとき（メニューを聞かない店舗）の所要時間
    askPartySize: false,          // 人数を聞くか（飲食店など。サロンのデモでは聞かない）
    STAFF: []                     // 担当リスト [{id:'sato', name:'佐藤'}, …]。空なら担当選択なし
  },

  // メニュー（予約フローの選択肢。所要時間がそのまま枠の長さになる）。
  // シート初期化用の既定値（「メニュー」シートが無いときに初回だけ書き込む値）。運用中は「メニュー」シートが正。
  MENUS: [
    { id: 'cut',   name: 'カット', minutes: 60,  price: '¥4,400' },
    { id: 'color', name: 'カラー', minutes: 120, price: '¥7,700〜' },
    { id: 'perm',  name: 'パーマ', minutes: 120, price: '¥8,800〜' }
  ],

  // 追加オプション。使うものだけを true にする。
  ADDONS: {
    REMINDER: false   // 前日リマインドの自動配信。true のときだけ sendReminders が送る
  },

  REMINDER: { daysBefore: 1 },  // 何日前に送るか（ADDONS.REMINDER が true のときだけ使う）

  // AI応答用。PROVIDER: 'gemini' | 'claude'。
  // MODEL は提供元に合わせる（例: gemini-flash-latest / claude-sonnet-5）。
  // APIキーはスクリプトプロパティ AI_API_KEY に置く（コードに直書きしない）。
  AI: { PROVIDER: 'gemini', MODEL: 'gemini-flash-latest', MAX_TOKENS: 512 }
};

// 「よくある質問」シートの初期値（シートが無いときに初回だけ書き込む既定値）。運用中はシートが正。
// 返信文は {店舗名}{営業時間}{定休日}{アクセス}{メニュー一覧}{電話}{クーポン} のプレースホルダを使え、
// faqList_() が「設定」シートの値へ置換する。
var FAQ_DEFAULTS = [
  { keys: ['営業時間', '何時', '開いて', '定休'],
    answer: '{店舗名}の営業時間は {営業時間}（{定休日}定休）です。' },
  { keys: ['アクセス', '場所', 'どこ', '地図', '住所', '行き方'],
    answer: 'アクセス：{アクセス}。地図は下部メニューの「地図」からご確認いただけます。' },
  { keys: ['メニュー', '料金', '値段', 'いくら', '価格', 'カット', 'カラー', 'パーマ'],
    answer: '主なメニューと料金：{メニュー一覧}（税込）。詳しくはお気軽にお尋ねください。' },
  { keys: ['クーポン', '割引', '初回'],
    answer: '{クーポン} をご用意しています。ご来店時にこのトーク画面をお見せください。' },
  { keys: ['電話', 'でんわ', '連絡'],
    answer: 'お電話は {電話} へどうぞ。トークからのご予約は「予約」と送るか、下部メニューの「予約する」からお進みください。' }
];

// ======================= シート外出し（設定・よくある質問・メニュー）=======================

/**
 * 「設定」「よくある質問」「メニュー」シートは、予約台帳と同じく「無ければ作成し、初期値を書き込む」方式。
 * スプレッドシート上でいつでも書き換えられる。
 *
 * 読み込みはイベント処理1回につき定数回に収めるため、_sheetCache に1イベント分だけキャッシュする
 * （候補ボタンの走査は日付14件×時刻13件まで回るので、走査のたびにシートを読み直すと重くなる）。
 * handleEvent_ / sendReminders の先頭で clearSheetCache_() を呼び、次のイベントでは必ず読み直す。
 */
var _sheetCache = {};
function clearSheetCache_() { _sheetCache = {}; }

/** 「設定」シートの行定義。A列=項目名（この label）・B列=値。 */
var STORE_FIELDS = [
  { key: 'name',   label: '店舗名' },
  { key: 'hours',  label: '営業時間' },
  { key: 'closed', label: '定休日' },
  { key: 'access', label: 'アクセス' },
  { key: 'menu',   label: 'メニュー一覧' },
  { key: 'tel',    label: '電話' },
  { key: 'coupon', label: 'クーポン' }
];

/** よくある質問の返信文で使えるプレースホルダ → storeInfo_() のキー。 */
var FAQ_PLACEHOLDERS = {
  '{店舗名}': 'name', '{営業時間}': 'hours', '{定休日}': 'closed',
  '{アクセス}': 'access', '{メニュー一覧}': 'menu', '{電話}': 'tel', '{クーポン}': 'coupon'
};

function storeSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('設定');
  if (!sh) {
    sh = ss.insertSheet('設定');
    sh.getRange(1, 1, 1, 2).setValues([['項目', '値']]);
    var rows = STORE_FIELDS.map(function (f) { return [f.label, CONFIG.STORE[f.key]]; });
    sh.getRange(2, 1, rows.length, 2).setValues(rows);
  }
  return sh;
}

/** 「設定」シートから店舗情報を読む。実行時の店舗情報参照はすべてここ経由にする。 */
function storeInfo_() {
  if (_sheetCache.store) return _sheetCache.store;
  var sh = storeSheet_();
  var last = sh.getLastRow();
  var map = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    vals.forEach(function (row) {
      var f = STORE_FIELDS.filter(function (x) { return x.label === row[0]; })[0];
      if (f) map[f.key] = row[1];
    });
  }
  var out = {};
  STORE_FIELDS.forEach(function (f) {
    out[f.key] = (map[f.key] !== undefined && map[f.key] !== '') ? map[f.key] : CONFIG.STORE[f.key];
  });
  _sheetCache.store = out;
  return out;
}

function faqSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('よくある質問');
  if (!sh) {
    sh = ss.insertSheet('よくある質問');
    sh.getRange(1, 1, 1, 2).setValues([['キーワード（カンマ区切り）', '返信文']]);
    var rows = FAQ_DEFAULTS.map(function (f) { return [f.keys.join(','), f.answer]; });
    sh.getRange(2, 1, rows.length, 2).setValues(rows);
  }
  return sh;
}

/** 「よくある質問」シートを [{keys:[...], answer:'置換済み文字列'}] にして返す。matchFaq_ が使う。 */
function faqList_() {
  if (_sheetCache.faq) return _sheetCache.faq;
  var sh = faqSheet_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var store = storeInfo_();
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    vals.forEach(function (row) {
      var keysRaw = String(row[0] || '').trim();
      if (!keysRaw) return;
      var keys = keysRaw.split(',').map(function (k) { return k.trim(); }).filter(function (k) { return !!k; });
      out.push({ keys: keys, answer: applyFaqPlaceholders_(String(row[1] || ''), store) });
    });
  }
  _sheetCache.faq = out;
  return out;
}

function applyFaqPlaceholders_(text, store) {
  return text.replace(/\{(店舗名|営業時間|定休日|アクセス|メニュー一覧|電話|クーポン)\}/g, function (m) {
    return String(store[FAQ_PLACEHOLDERS[m]]);
  });
}

function menuSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('メニュー');
  if (!sh) {
    sh = ss.insertSheet('メニュー');
    sh.getRange(1, 1, 1, 4).setValues([['ID', 'メニュー名', '所要時間(分)', '料金表示']]);
    var rows = CONFIG.MENUS.map(function (m) { return [m.id, m.name, m.minutes, m.price]; });
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  return sh;
}

/** 「メニュー」シートを [{id, name, minutes, price}] にして返す。findMenu_ 等が使う。 */
function menuList_() {
  if (_sheetCache.menus) return _sheetCache.menus;
  var sh = menuSheet_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 4).getValues();
    vals.forEach(function (row) {
      if (!row[0]) return;
      out.push({ id: String(row[0]), name: String(row[1]), minutes: Number(row[2]) || 0, price: String(row[3]) });
    });
  }
  _sheetCache.menus = out;
  return out;
}

// ======================= Webhook エントリ =======================

/** LINE Platform からの Webhook を受ける本番エントリ。 */
function doPost(e) {
  var body = (e && e.postData && e.postData.contents) || '{}';

  // 署名検証は本番で必須だが、GASのWebアプリは X-Line-Signature ヘッダを取得できない。
  // 厳密な署名検証が要件なら、ヘッダを取得できる別の実行環境で verifySignature_ を使う。

  var data;
  try { data = JSON.parse(body); } catch (err) { return jsonOut_({ ok: false, error: 'bad json' }); }

  (data.events || []).forEach(function (ev) {
    var messages = handleEvent_(ev);
    if (messages && messages.length && ev.replyToken) {
      replyMessage_(ev.replyToken, messages);
    }
  });
  return jsonOut_({ ok: true });
}

/**
 * 1イベントを処理して、返信メッセージ配列（LINEメッセージJSON）を返す純ロジック。
 * ここが応答分岐の中心。実送信は doPost / replyMessage_ が担当するので、
 * この関数はテスト・デモから直接呼んで戻り値を検証できる。
 */
function handleEvent_(ev) {
  clearSheetCache_(); // 1イベント＝1回だけシートを読み直す（設定・よくある質問・メニュー）
  if (!ev) return [];
  var userId = (ev.source && ev.source.userId) || 'unknown';
  if (ev.type === 'follow') return [welcomeMessage_()];
  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    return handleText_(String(ev.message.text || '').trim(), userId);
  }
  if (ev.type === 'postback') {
    return handlePostback_(ev.postback || {}, userId);
  }
  return []; // 画像・スタンプ等はこのサンプルでは無応答（本番で必要なら拡張）
}

// ======================= テキスト（キーワード / AI）=======================

function handleText_(text, userId) {
  // キャンセル・変更・予約確認は、予約の起動ワード判定より先に見る。
  // 「予約キャンセル」「予約を確認」等が /予約|よやく/ に食われて予約フローへ入ってしまわないようにするため。
  if (/キャンセル|取り消し|取消|変更/.test(text)) return cancelListFlow_(userId);
  if (/予約確認|予約の確認|予約を確認/.test(text)) return cancelListFlow_(userId);

  // 予約の起動ワード
  if (/予約|よやく/.test(text)) return reserveFlow_({});

  // キーワード自動応答
  var hit = matchFaq_(text);
  if (hit) return [textMsg_(hit)];

  // AI自動応答（キーワードに当たらない自由質問）。答えられなければ有人・フォーム案内に倒す。
  var ai = aiAnswer_(text, userId);
  if (ai && ai.answered && ai.text) return [textMsg_(ai.text)];
  return [textMsg_(fallbackText_())];
}

/** テキストが「よくある質問」シートのいずれかのキーワードを含めば、その回答文字列を返す。無ければ null。 */
function matchFaq_(text) {
  var list = faqList_();
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    for (var j = 0; j < f.keys.length; j++) {
      if (f.keys[j] && text.indexOf(f.keys[j]) >= 0) return f.answer;
    }
  }
  return null;
}

function fallbackText_() {
  return 'お問い合わせありがとうございます。その内容はスタッフが確認いたします。' +
    'お急ぎの場合はお電話（' + storeInfo_().tel + '）、またはご予約は「予約」と送信してお進みください。';
}

// ======================= 予約フロー（ポストバック）=======================

/**
 * 予約のポストバックはすべてここへ。data から取り出したパラメータ（メニュー・担当・人数・日付・時刻）を
 * 見て、まだ決まっていない項目を順に聞く。Bot 側に途中状態を持たないので、
 * ユーザーが古いボタンを押し直しても矛盾しない。
 */
function handlePostback_(pb, userId) {
  var p = parseData_(pb.data);
  if (p.action === 'reserve_confirm') return confirmReservation_(p, userId);
  if (p.action === 'cancel_pick') return cancelPickMessage_(p, userId);
  if (p.action === 'cancel_confirm') return cancelConfirm_(p, userId);
  if (p.action === 'cancel_abort') return [textMsg_('ご予約はそのままにしています。')];
  if (String(p.action || '').indexOf('reserve_') === 0) return reserveFlow_(p);
  return [];
}

/** 予約フローの本体。次に聞くべき1問だけを返す。 */
function reserveFlow_(p) {
  // 1) メニュー（「メニュー」シートが空なら聞かない。所要時間は BUSINESS.defaultDurationMinutes）
  if (menuList_().length && !p.menu) return [menuStepMessage_(p)];

  // 2) 担当（STAFF が空なら飛ばす）
  if (staffEnabled_() && !p.staff) return [staffStepMessage_(p)];

  // 3) 人数（askPartySize が false なら飛ばす）
  if (askSize_() && !p.size) return [sizeStepMessage_(p)];

  // 4) 来店日（空きが1つでもある日だけを出す）
  if (!p.date) return dateStepMessages_(p);

  // 5) 開始時刻（その日の空き開始時刻だけを出す）
  if (!p.time) return timeStepMessages_(p);

  // 6) 確認。候補を出してから押されるまでの間に埋まる可能性があるので、ここでも空きを見る
  var req = buildRequest_(p);
  if (!req) return [textMsg_('予約情報を取得できませんでした。お手数ですが最初からやり直してください。')];
  var check = checkRequest_(req);
  if (!check.ok) return [textMsg_(check.reason)].concat(dateStepMessages_(withoutDateTime_(p)));
  return [reserveConfirmMessage_(req, p)];
}

/**
 * 確定処理。ほぼ同時の「確定する」で二重に入らないよう直列化し、
 * 直前にもう一度空きを見てから台帳へ書く。
 */
function confirmReservation_(p, userId) {
  // ほぼ同時の「確定する」が重ならないよう直列化（GAS実行時のみ。ハーネスでは素通し）
  var lock = (typeof LockService !== 'undefined') ? LockService.getScriptLock() : null;
  if (lock) {
    try { lock.waitLock(5000); }
    catch (e) { return [textMsg_('ただいま混み合っています。お手数ですがもう一度「確定する」を押してください。')]; }
  }
  try {
    var req = buildRequest_(p);
    if (!req) return [textMsg_('予約情報を取得できませんでした。お手数ですが最初からやり直してください。')];

    var check = checkRequest_(req); // 確定直前にもう一度空きを確認（二重予約の競合ガード）
    if (!check.ok) {
      // 「別の日時はいかがでしょうか」と言う以上、実際に選べる日を一緒に出す
      return [textMsg_(check.reason)].concat(dateStepMessages_(withoutDateTime_(p)));
    }

    var rec = {
      id: nextReservationId_(),
      userId: userId,
      date: req.date,
      start: req.start,
      end: req.end,
      menuId: req.menuId,
      size: req.size,
      staffId: req.staffId,
      status: '確定',
      createdAt: fmtDateTime_(new Date()),
      reminded: '',
      calId: ''
    };
    // カレンダーは台帳の写し。登録に失敗しても予約は残す（台帳が正）
    rec.calId = registerCalendar_(req, userId, rec.id);
    appendReservation_(rec);
    return [confirmedMessage_(req, p)];
  } finally {
    if (lock) lock.releaseLock();
  }
}

// ======================= トーク内キャンセル =======================

/**
 * 「キャンセル」「予約確認」の入口。自分の確定予約を一覧で出し、選ばせてから取り消す。
 */
function cancelListFlow_(userId) {
  var list = myUpcomingReservations_(userId);
  if (!list.length) return [textMsg_('現在、確定済みのご予約はありません。ご予約は「予約」と送ってください。')];

  var items = list.map(function (r) {
    var label = cancelPickLabel_(r);
    return quickItem_(label, 'action=cancel_pick&id=' + r.id, label);
  });
  return [quickMsg_('取り消し・変更をご希望のご予約をお選びください。', items)];
}

/** 自分（userId一致）の、今日以降・状態「確定」の予約を、来店日時の昇順で最大10件。 */
function myUpcomingReservations_(userId) {
  var todayStr = fmtDate_(new Date());
  var rows = ledgerRows_().filter(function (r) {
    return r.userId === userId && r.status === '確定' && r.date >= todayStr;
  });
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0);
  });
  return rows.slice(0, 10);
}

/** クイックリプライのラベル用「7/20(月) 14:00」（ラベルは20文字上限のため日付短縮形＋開始時刻に留める）。 */
function cancelPickLabel_(r) {
  return dateShort_(dateObj_(r.date)) + ' ' + r.start;
}

/** cancel_pick: 該当の予約を確認し、取り消しの confirm テンプレートを返す。 */
function cancelPickMessage_(p, userId) {
  var r = findReservationById_(p.id);
  // postback の data は端末側で書き換えて送れるため、ここでも本人の予約かを必ず確認する（他人のIDでは中身も見せない）。
  if (!r || r.userId !== userId) {
    return [textMsg_('予約情報を確認できませんでした。恐れ入りますが「予約確認」からやり直してください。')];
  }
  if (r.status !== '確定') return [textMsg_('このご予約はすでに取り消し済みです。')];
  return [cancelConfirmMessage_(r)];
}

function findReservationById_(id) {
  var rows = ledgerRows_();
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

/** 取り消し確認（confirm テンプレート。actions は2件まで）。 */
function cancelConfirmMessage_(r) {
  var summary = reservationSummary_(r);
  return {
    type: 'template',
    altText: '予約の取り消し確認',
    template: {
      type: 'confirm',
      text: dateLabel_(dateObj_(r.date)) + ' ' + r.start + '〜' + r.end +
        (summary ? '（' + summary + '）' : '') + ' のご予約を取り消します。よろしいですか？',
      actions: [
        { type: 'postback', label: '取り消す', data: 'action=cancel_confirm&id=' + r.id, displayText: '取り消す' },
        { type: 'postback', label: 'やめる', data: 'action=cancel_abort', displayText: 'やめる' }
      ]
    }
  };
}

/** 予約1件の内容の短い説明（例: カラー／担当 佐藤／2名）。無ければ空文字。selectionNote_ の台帳行版。 */
function reservationSummary_(r) {
  var parts = [];
  var m = findMenu_(r.menuId);
  if (m) parts.push(m.name);
  var st = findStaff_(r.staffId);
  if (staffEnabled_() && st) parts.push('担当 ' + st.name);
  if (askSize_() && r.size) parts.push(r.size + '名');
  return parts.join('／');
}

/**
 * トーク内キャンセルの確定。確定処理（confirmReservation_）と同様に LockService で直列化する。
 * postback の data は端末側で書き換えて送れるため、ここでも本人の予約か（userId一致）を必ず確認してから
 * 台帳を書き換える（他人のIDを直接投げても取り消せない）。
 */
function cancelConfirm_(p, userId) {
  var lock = (typeof LockService !== 'undefined') ? LockService.getScriptLock() : null;
  if (lock) {
    try { lock.waitLock(5000); }
    catch (e) { return [textMsg_('ただいま混み合っています。お手数ですがもう一度お試しください。')]; }
  }
  try {
    var sh = ledgerSheet_();
    var rows = ledgerRows_();
    var idx = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === p.id) { idx = i; break; }
    if (idx < 0 || rows[idx].userId !== userId) {
      return [textMsg_('予約情報を確認できませんでした。恐れ入りますが「予約確認」からやり直してください。')];
    }
    var r = rows[idx];
    if (r.status !== '確定') return [textMsg_('このご予約はすでに取り消し済みです。')];

    // 行削除はしない（履歴を残す）。状態だけ「キャンセル」にすれば、空き判定(bookedSize_)は
    // 状態「確定」だけを数えるので、この枠は自動的に開放される。
    sh.getRange(idx + 2, ledgerCol_('状態')).setValue('キャンセル');
    cancelCalendarEvent_(r.calId);

    var summary = reservationSummary_(r);
    return [textMsg_(
      'ご予約を取り消しました。\n■ ' + dateLabel_(dateObj_(r.date)) + ' ' + r.start + '〜' + r.end +
      (summary ? '（' + summary + '）' : '') + '\n' +
      'またのご予約をお待ちしています。ご予約は「予約」と送ってください。')];
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** カレンダー予定の削除。台帳が正・カレンダーは写しなので、失敗しても台帳のキャンセルは成立させる。 */
function cancelCalendarEvent_(calId) {
  if (!calId) return;
  if (CONFIG.DEMO_MODE) { Logger.log('[demo][calendar] 予定を削除（想定）: %s', calId); return; }
  try { CalendarApp.getEventById(calId).deleteEvent(); }
  catch (e) { Logger.log('カレンダー削除に失敗しました（台帳のキャンセルは成立済み）: %s', e); }
}

// ======================= 空き判定（区間の重なり）=======================

/**
 * 受付ルールと空きの判定。{ok:true} か {ok:false, reason:'…'}。
 * rows を渡すと台帳の再読み込みを省ける（候補を大量に走査するときに使う）。
 */
function checkRequest_(req, rows) {
  var b = CONFIG.BUSINESS;

  if (req.dateObj.getDay() === b.closedWeekday) {
    return { ok: false, reason: '申し訳ありません、' + dateLabel_(req.dateObj) + ' は定休日（' + storeInfo_().closed + '）です。' };
  }
  var s = toMin_(req.start), e = toMin_(req.end);
  if (s < b.openHour * 60 || e > b.closeHour * 60) {
    return { ok: false, reason: '申し訳ありません、受付時間は ' + storeInfo_().hours + ' です。時間内で終わる時刻をお選びください。' };
  }
  if (isPast_(req.dateObj)) {
    return { ok: false, reason: '過去の日時は選べません。これからの日時をお選びください。' };
  }
  if (bookedSize_(req, rows || ledgerRows_()) + req.size > capacityFor_()) {
    return { ok: false, reason: '申し訳ありません、' + reqLabel_(req) + ' は満席です。別の日時はいかがでしょうか。' };
  }
  return { ok: true };
}

/**
 * 同じ時間帯に既に入っている人数の合計（＝二重予約防止の核）。
 * 完全一致ではなく区間 [開始, 終了) の重なりで見るので、
 * 14:00〜15:00 が埋まっていれば 14:30 開始も弾ける。
 */
function bookedSize_(req, rows) {
  var s = toMin_(req.start), e = toMin_(req.end);
  var byStaff = staffEnabled_();
  var sum = 0;
  rows.forEach(function (r) {
    if (r.status !== '確定') return;
    if (r.date !== req.date) return;
    if (byStaff && String(r.staffId) !== String(req.staffId)) return; // 担当運用では担当ごとに数える
    var rs = toMin_(r.start), re = toMin_(r.end);
    if (isNaN(rs) || isNaN(re)) return;
    if (!overlaps_(s, e, rs, re)) return;
    sum += Number(r.size) || 1;
  });
  return sum;
}

/** 区間 [aS,aE) と [bS,bE) が重なるか。 */
function overlaps_(aS, aE, bS, bE) { return aS < bE && bS < aE; }

/** その枠に受けられる上限。担当を取る運用ではスタッフ1人につき同時1件。 */
function capacityFor_() {
  return staffEnabled_() ? 1 : CONFIG.BUSINESS.capacityPerSlot;
}

/** 担当選択をフローに入れるか。BUSINESS.STAFF が登録されているとき。 */
function staffEnabled_() {
  return !!(CONFIG.BUSINESS.STAFF && CONFIG.BUSINESS.STAFF.length);
}

/** 人数選択をフローに入れるか。BUSINESS.askPartySize が true のとき。 */
function askSize_() {
  return !!CONFIG.BUSINESS.askPartySize;
}

/** 予約1件の所要時間（分）。メニューが選ばれていればその所要時間、無ければ既定値。 */
function durationFor_(menuId) {
  var m = findMenu_(menuId);
  if (m) return m.minutes;
  return CONFIG.BUSINESS.defaultDurationMinutes;
}

function partySize_(p) {
  if (!askSize_()) return 1;
  var n = Number(p.size);
  return n >= 1 ? n : 1;
}

/** postback のパラメータ → 予約リクエスト {date,start,end,menuId,size,staffId,minutes,dateObj}。不正なら null。 */
function buildRequest_(p) {
  if (!p.date || !p.time) return null;
  var d = dateTimeObj_(p.date, p.time);
  if (!d) return null;
  var dur = durationFor_(p.menu);
  return {
    date: p.date,
    start: p.time,
    end: minToHM_(toMin_(p.time) + dur),
    menuId: p.menu || '',
    size: partySize_(p),
    staffId: staffEnabled_() ? (p.staff || '') : '',
    minutes: dur,
    dateObj: d
  };
}

// ======================= 候補の組み立て =======================

/**
 * 来店日の候補。明日から14日先までを見て、定休日を除き、
 * その日に空き開始時刻が1つでもある日だけを最大10件返す。
 * （当日は当日枠の締切・準備時間の扱いが店ごとに違うので、このサンプルでは翌日から）
 */
function dateCandidates_(p) {
  var rows = ledgerRows_();
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var out = [];
  for (var i = 1; i <= 14; i++) {
    if (out.length >= 10) break;
    var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    if (d.getDay() === CONFIG.BUSINESS.closedWeekday) continue;
    var ds = fmtDate_(d);
    if (timeCandidates_(p, ds, rows).length === 0) continue; // 空きゼロの日は出さない
    out.push({ date: ds, dateObj: d, label: dateShort_(d) });
  }
  return out;
}

/**
 * その日の空き開始時刻。営業時間内を slotMinutes 刻みで走査し、
 * 所要時間ぶんが営業時間に収まり・過去でなく・容量を超えないものだけを最大13件（クイックリプライの上限）返す。
 * 候補の判定と確定直前のガードで同じ checkRequest_ を通しているので、出した候補と受けられる枠がずれない。
 */
function timeCandidates_(p, date, rows) {
  var b = CONFIG.BUSINESS;
  var dur = durationFor_(p.menu);
  var openM = b.openHour * 60, closeM = b.closeHour * 60;
  var step = b.slotMinutes || 30;
  rows = rows || ledgerRows_();
  var out = [];
  for (var t = openM; t + dur <= closeM; t += step) {
    if (out.length >= 13) break;
    var req = buildRequest_(merge_(p, { date: date, time: minToHM_(t) }));
    if (req && checkRequest_(req, rows).ok) out.push(req.start);
  }
  return out;
}

// ======================= 予約台帳（Google スプレッドシート）=======================

var LEDGER_HEADERS = ['予約ID', 'ユーザーID', '予約日', '開始', '終了', 'メニュー', '人数', '担当', '状態', '受付日時', 'リマインド', 'カレンダーID'];

/** 見出し名から列番号（1始まり）。列を足したときに書き換え漏れが出ないようにする。 */
function ledgerCol_(name) { return LEDGER_HEADERS.indexOf(name) + 1; }

function ledgerSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.LEDGER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.LEDGER_SHEET);
    sh.getRange(1, 1, 1, LEDGER_HEADERS.length).setValues([LEDGER_HEADERS]);
  }
  return sh;
}

/** 台帳の全行。メニュー・担当は ID で持つ（表示名は「メニュー」シート/menuList_() / BUSINESS.STAFF から引く）。 */
function ledgerRows_() {
  var sh = ledgerSheet_();
  if (sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, LEDGER_HEADERS.length).getValues();
  return vals.map(function (r) {
    return { id: r[0], userId: r[1], date: cellDate_(r[2]), start: cellTime_(r[3]), end: cellTime_(r[4]),
             menuId: r[5], size: Number(r[6]) || 1, staffId: r[7], status: r[8], createdAt: r[9],
             reminded: r[10], calId: r[11] };
  });
}

/**
 * セル値 → 'YYYY-MM-DD' 文字列に正規化。
 * appendRow で書いた '2026-07-17' 等の文字列を Sheets が日付型セルへ自動変換するため、
 * 読み戻し時に型を吸収する（2026-07-16 実機検証で発覚：型変換で日時の照合が外れ、
 * 二重予約防止と前日リマインドの対象日判定が働かなかった）。
 */
function cellDate_(v) {
  return isDateLike_(v) ? fmtDate_(v) : String(v);
}

/** セル値 → 'HH:MM' 文字列に正規化（時刻型セル対応。上と同じ実機バグ対策。開始・終了の両方に効かせる）。 */
function cellTime_(v) {
  if (isDateLike_(v)) return pad2_(v.getHours()) + ':' + pad2_(v.getMinutes());
  var m = String(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? pad2_(+m[1]) + ':' + m[2] : String(v);
}

/** Date型（相当）か。instanceof は実行環境をまたぐと外れるためメソッドの有無で判定。 */
function isDateLike_(v) {
  return !!v && typeof v.getFullYear === 'function' && typeof v.getHours === 'function';
}

function appendReservation_(rec) {
  ledgerSheet_().appendRow([rec.id, rec.userId, rec.date, rec.start, rec.end, rec.menuId, rec.size,
                            rec.staffId, rec.status, rec.createdAt, rec.reminded, rec.calId]);
}

function nextReservationId_() {
  var n = ledgerRows_().length + 1;
  return 'R' + ('0000' + n).slice(-4);
}

// ======================= 前日リマインド（追加オプション・時間トリガー）=======================

/**
 * 前日リマインドを送る。時間トリガーで毎日呼ぶ想定。
 * 追加オプションなので CONFIG.ADDONS.REMINDER が true のときだけ送る（既定は false で何もしない）。
 * refDate（'YYYY-MM-DD'）はデモ専用の基準日上書き。本番は無指定で当日基準。
 */
function sendReminders(refDate) {
  clearSheetCache_(); // 1回の実行につき1回だけシートを読み直す
  if (!CONFIG.ADDONS.REMINDER) {
    Logger.log('前日リマインドは無効です（CONFIG.ADDONS.REMINDER = false）。送信しません。');
    return 0;
  }
  var today = (refDate ? dateObj_(refDate) : null) || new Date();
  var target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + CONFIG.REMINDER.daysBefore);
  var targetStr = fmtDate_(target);

  var sh = ledgerSheet_();
  var rows = ledgerRows_();
  var col = ledgerCol_('リマインド');
  var sent = 0;
  rows.forEach(function (r, i) {
    if (r.status === '確定' && r.date === targetStr && r.reminded !== '済') {
      pushMessage_(r.userId, [textMsg_(reminderText_(r))]);
      sh.getRange(i + 2, col).setValue('済'); // リマインド列を「済」に（重複送信防止）
      sent++;
    }
  });
  Logger.log('リマインド送信: %s 件（対象日=%s）', sent, targetStr);
  return sent;
}

function reminderText_(r) {
  return '【ご予約前日のお知らせ】' + storeInfo_().name + ' です。\n' +
    '明日 ' + r.date + ' ' + r.start + ' にご予約を承っております。\n' +
    'ご来店をお待ちしております。変更・キャンセルはこのトークからご連絡ください。';
}

// ======================= Google カレンダー登録 =======================

/** 所要時間ぶんの枠でカレンダーに登録し、イベントIDを返す（台帳の「カレンダーID」列に入る）。 */
function registerCalendar_(req, userId, reservationId) {
  if (CONFIG.DEMO_MODE) {
    var demoId = 'demo-cal-' + reservationId;
    Logger.log('[demo][calendar] 予定を登録（想定）: %s %s〜%s / %s（%s）→ %s',
      req.date, req.start, req.end, storeInfo_().name, userId, demoId);
    return demoId;
  }
  // 本番: 既定カレンダーへ所要時間ぶんで登録。
  // カレンダー側が落ちても予約自体は台帳に残す（台帳が正・カレンダーは写し）。
  try {
    var start = req.dateObj;
    var end = new Date(start.getTime() + req.minutes * 60 * 1000);
    var ev = CalendarApp.getDefaultCalendar().createEvent(
      storeInfo_().name + ' 予約（' + userId + '）', start, end);
    return ev.getId();
  } catch (e) {
    Logger.log('カレンダー登録に失敗しました（予約は台帳に記録済み）: %s', e);
    return '';
  }
}

// ======================= AI応答 =======================

function aiAnswer_(text, userId) {
  if (CONFIG.DEMO_MODE) return demoAi_(text);
  return callAi_(text);
}

/**
 * デモ用の疑似AI。店舗情報の範囲で答え、範囲外は answered:false（→ 有人・フォーム案内へ倒す）。
 * ※ 本番は callAi_ が生成AIの実出力を返す。これは動作見本。
 */
function demoAi_(text) {
  if (/駐車|パーキング|車で|車は/.test(text))
    return { answered: true, text: '専用駐車場はございませんが、店舗となりのコインパーキング（30分200円）をご利用いただけます。' };
  if (/子供|子ども|こども|キッズ|子連れ/.test(text))
    return { answered: true, text: 'お子さま連れのご来店も歓迎です。ベビーカーのまま入れる席をご案内します。' };
  if (/支払|カード|クレジット|PayPay|ペイペイ|決済|現金/i.test(text))
    return { answered: true, text: 'お支払いは現金・各種クレジットカード・PayPay がご利用いただけます。' };
  if (/駐輪|自転車/.test(text))
    return { answered: true, text: '店舗前に駐輪スペースがございます。ご自由にお使いください。' };
  return { answered: false }; // 分からない → fallback
}

/**
 * 本番のAI呼び出し。提供元は CONFIG.AI.PROVIDER で切り替える（新しい提供元も同じ形で足せる）。
 * どの提供元でも、店舗情報だけを根拠に回答し、答えられなければ answered:false を返す契約は同じ。
 */
function callAi_(text) {
  var key = PropertiesService.getScriptProperties().getProperty('AI_API_KEY');
  if (!key) { Logger.log('AI: AI_API_KEY 未設定'); return { answered: false }; }
  if (CONFIG.AI.PROVIDER === 'gemini') return callGemini_(text, key);
  if (CONFIG.AI.PROVIDER === 'claude') return callClaude_(text, key);
  Logger.log('AI: 未対応の提供元 %s', CONFIG.AI.PROVIDER);
  return { answered: false };
}

/** 店舗情報（「設定」シートが正）を根拠にした共通プロンプト。 */
function aiPrompt_(text) {
  var s = storeInfo_();
  var context =
    '店舗名: ' + s.name + '\n営業時間: ' + s.hours + '（' + s.closed + '定休）\n' +
    'アクセス: ' + s.access + '\nメニュー/料金: ' + s.menu + '\n電話: ' + s.tel + '\nクーポン: ' + s.coupon;
  return 'あなたは' + s.name + 'のLINE窓口です。次の【店舗情報】だけを根拠に、来店者の質問へ丁寧に日本語で答えてください。\n' +
    '情報に無いこと・不確実なことは推測で答えず、answered を false にしてください。\n\n' +
    '【店舗情報】\n' + context + '\n\n【質問】\n"""' + text + '"""';
}

/** Gemini（generateContent）。responseSchema でJSON出力を強制し {answered, text} を受け取る。 */
function callGemini_(text, key) {
  var payload = {
    contents: [{ role: 'user', parts: [{ text: aiPrompt_(text) }] }],
    generationConfig: {
      maxOutputTokens: CONFIG.AI.MAX_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { answered: { type: 'BOOLEAN' }, text: { type: 'STRING' } },
        required: ['answered', 'text']
      }
    }
  };
  // キーはURLに載せずヘッダで渡す（URLはログに残りやすいため）
  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.AI.MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload)
  });
  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch (e) { Logger.log('AI: JSON解析失敗 %s', res.getContentText()); return { answered: false }; }
  if (json.error) { Logger.log('AIエラー: %s', JSON.stringify(json.error)); return { answered: false }; }
  var parts = (((json.candidates || [])[0] || {}).content || {}).parts;
  var t = parts && parts[0] && parts[0].text;
  if (!t) return { answered: false };
  try { return JSON.parse(t); } catch (e) { return { answered: false }; }
}

/** Claude（Messages API）。output_config の json_schema でJSON出力を強制。 */
function callClaude_(text, key) {
  var payload = {
    model: CONFIG.AI.MODEL,
    max_tokens: CONFIG.AI.MAX_TOKENS,
    messages: [{ role: 'user', content: aiPrompt_(text) }],
    output_config: { format: { type: 'json_schema', schema: {
      type: 'object',
      properties: { answered: { type: 'boolean' }, text: { type: 'string' } },
      required: ['answered', 'text'], additionalProperties: false
    } } }
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload)
  });
  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch (e) { Logger.log('AI: JSON解析失敗 %s', res.getContentText()); return { answered: false }; }
  if (json.error) { Logger.log('AIエラー: %s', JSON.stringify(json.error)); return { answered: false }; }
  var block = (json.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) return { answered: false };
  try { return JSON.parse(block.text); } catch (e) { return { answered: false }; }
}

// ======================= 送信（reply / push）=======================

function replyMessage_(replyToken, messages) {
  if (CONFIG.DEMO_MODE) { Logger.log('[demo][reply] %s', JSON.stringify(messages)); return; }
  linePost_('https://api.line.me/v2/bot/message/reply', { replyToken: replyToken, messages: messages });
}

function pushMessage_(to, messages) {
  if (CONFIG.DEMO_MODE) { Logger.log('[demo][push -> %s] %s', to, JSON.stringify(messages)); return; }
  linePost_('https://api.line.me/v2/bot/message/push', { to: to, messages: messages });
}

function linePost_(url, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) { Logger.log('LINE: LINE_CHANNEL_ACCESS_TOKEN 未設定'); return; }
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(payload)
  });
  if (res.getResponseCode() >= 300) Logger.log('LINE送信エラー %s: %s', res.getResponseCode(), res.getContentText());
}

/**
 * 署名検証ユーティリティ（ヘッダを取得できる別の実行環境用）。
 * GASのWebアプリは X-Line-Signature を取得できないため、GAS版では使えない。
 */
function verifySignature_(body, signatureHeader) {
  var secret = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_SECRET');
  if (!secret) return false;
  var raw = Utilities.computeHmacSha256Signature(body, secret);
  var expected = Utilities.base64Encode(raw);
  return expected === signatureHeader;
}

// ======================= メッセージビルダー =======================

function textMsg_(t) { return { type: 'text', text: t }; }

/** クイックリプライ付きのテキスト。items は最大13件（LINEの上限）。 */
function quickMsg_(text, items) {
  return { type: 'text', text: text, quickReply: { items: items.slice(0, 13) } };
}

function quickItem_(label, data, displayText) {
  return { type: 'action', action: { type: 'postback', label: label, data: data, displayText: displayText || label } };
}

function welcomeMessage_() {
  return textMsg_(
    '友だち追加ありがとうございます！' + storeInfo_().name + 'です。\n' +
    'ご予約は「予約」と送るか、下部メニューの「予約する」から。\n' +
    '営業時間・アクセス・メニュー・クーポンもこのトークでご案内します。');
}

/** メニュー選択。所要時間がそのまま枠の長さになるので、分数も出す。 */
function menuStepMessage_(p) {
  var items = menuList_().map(function (m) {
    return quickItem_(m.name + '（' + m.minutes + '分）', flowData_('reserve_menu', merge_(p, { menu: m.id })), m.name);
  });
  return quickMsg_('ご希望のメニューをお選びください。（' + storeInfo_().menu + '／税込）', items);
}

/**
 * 担当選択。デモでは指名を必須にしていて「指名なし」は置いていない。
 * 指名なしを受けるなら、空いている担当をどう割り当てるか（自動割当・先着・持ち回り）を先に決める必要がある。
 */
function staffStepMessage_(p) {
  var items = (CONFIG.BUSINESS.STAFF || []).map(function (st) {
    return quickItem_(st.name, flowData_('reserve_staff', merge_(p, { staff: st.id })), st.name + 'を指名');
  });
  return quickMsg_('ご希望の担当者をお選びください。', items);
}

/** 人数選択（askPartySize が true のとき）。1〜4名。 */
function sizeStepMessage_(p) {
  var items = [];
  for (var n = 1; n <= 4; n++) {
    items.push(quickItem_(n + '名', flowData_('reserve_size', merge_(p, { size: n })), n + '名'));
  }
  return quickMsg_('ご利用人数をお選びください。', items);
}

/** 来店日の候補。空きのある日が1つも無ければ電話へ案内する。 */
function dateStepMessages_(p) {
  var cands = dateCandidates_(p);
  if (!cands.length) {
    return [textMsg_('申し訳ありません、2週間先までに空きがございません。お手数ですがお電話（' + storeInfo_().tel + '）でご相談ください。')];
  }
  var items = cands.map(function (c) {
    return quickItem_(c.label, flowData_('reserve_date', merge_(p, { date: c.date })), c.label);
  });
  return [quickMsg_('ご希望の来店日をお選びください。' + selectionNote_(p), items)];
}

/** その日の空き開始時刻。押された後に埋まっていた場合は日付から選び直してもらう。 */
function timeStepMessages_(p) {
  var d = dateObj_(p.date);
  if (!d) return [textMsg_('日付が取得できませんでした。もう一度お試しください。')].concat(dateStepMessages_(withoutDateTime_(p)));

  var times = timeCandidates_(p, p.date);
  if (!times.length) {
    return [textMsg_('申し訳ありません、' + dateLabel_(d) + ' は空きがございません。別の日はいかがでしょうか。')]
      .concat(dateStepMessages_(withoutDateTime_(p)));
  }
  var items = times.map(function (t) {
    return quickItem_(t, flowData_('reserve_time', merge_(p, { time: t })), t);
  });
  return [quickMsg_(dateLabel_(d) + ' の空き時間です。ご希望の開始時刻をお選びください。', items)];
}

/** 選択内容の確認（confirm テンプレート。actions は2件まで）。 */
function reserveConfirmMessage_(req, p) {
  return {
    type: 'template',
    altText: '予約内容の確認',
    template: {
      type: 'confirm',
      text: reqLabel_(req) + selectionNote_(p) + ' でご予約を承ります。よろしいですか？',
      actions: [
        { type: 'postback', label: '確定する', data: flowData_('reserve_confirm', p), displayText: '確定する' },
        { type: 'postback', label: '選び直す', data: flowData_('reserve_start', withoutDateTime_(p)), displayText: '選び直す' }
      ]
    }
  };
}

function confirmedMessage_(req, p) {
  return textMsg_(
    'ご予約を確定しました。\n■ ' + storeInfo_().name + '\n■ ' + reqLabel_(req) + selectionNote_(p) + '\n' +
    (CONFIG.ADDONS.REMINDER ? '前日にこのトークでリマインドをお送りします。' : '') +
    '変更・キャンセルはトークからご連絡ください。');
}

/** 「（カラー／担当 佐藤／2名）」のような補足。選んでいない項目は出さない。 */
function selectionNote_(p) {
  var parts = [];
  var m = findMenu_(p.menu);
  if (m) parts.push(m.name);
  var st = findStaff_(p.staff);
  if (staffEnabled_() && st) parts.push('担当 ' + st.name);
  if (askSize_() && p.size) parts.push(p.size + '名');
  return parts.length ? '（' + parts.join('／') + '）' : '';
}

function findMenu_(id) {
  var list = menuList_();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function findStaff_(id) {
  var list = CONFIG.BUSINESS.STAFF || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

// ======================= リッチメニュー定義（本番の一度きり設定用）=======================

/**
 * リッチメニュー本体。本番は Messaging API で1回だけ登録する（README参照）。
 * 画像は 2500x1686 を6分割（3列×2行）想定。areas の bounds はその座標系。
 */
function richMenuJson_() {
  var s = storeInfo_();
  return {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: s.name + ' メニュー',
    chatBarText: 'メニュー',
    areas: [
      { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'postback', data: 'action=reserve_start', displayText: '予約する' } },
      { bounds: { x: 833,  y: 0,   width: 834, height: 843 }, action: { type: 'message', text: 'メニュー' } },
      { bounds: { x: 1667, y: 0,   width: 833, height: 843 }, action: { type: 'message', text: 'クーポン' } },
      { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'message', text: '営業時間' } },
      { bounds: { x: 833,  y: 843, width: 834, height: 843 }, action: { type: 'message', text: 'アクセス' } },
      { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: 'uri', uri: 'tel:' + String(s.tel).replace(/-/g, '') } }
    ]
  };
}

// ======================= フロー状態（postback data）=======================

var FLOW_KEYS = ['menu', 'staff', 'size', 'date', 'time'];

/** 選択済みの項目を引き継ぎつつ、patch の分だけ上書きしたパラメータを作る。 */
function merge_(p, patch) {
  var o = {}, i, k;
  for (i = 0; i < FLOW_KEYS.length; i++) { k = FLOW_KEYS[i]; o[k] = p[k]; }
  for (i = 0; i < FLOW_KEYS.length; i++) { k = FLOW_KEYS[i]; if (patch && patch[k] !== undefined) o[k] = patch[k]; }
  return o;
}

/** 日付・時刻だけ外す（メニュー・担当・人数は引き継いで選び直してもらう）。 */
function withoutDateTime_(p) { return merge_(p, { date: '', time: '' }); }

/** ボタンに載せる postback data を組み立てる。空の項目は載せない。 */
function flowData_(action, p) {
  var s = 'action=' + action;
  for (var i = 0; i < FLOW_KEYS.length; i++) {
    var k = FLOW_KEYS[i];
    if (p[k]) s += '&' + k + '=' + p[k];
  }
  return s;
}

/** 'action=x&date=y' → {action:'x', date:'y'} */
function parseData_(data) {
  var o = {};
  String(data || '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i < 0) { o[kv] = ''; return; }
    o[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return o;
}

// ======================= 日時ユーティリティ =======================

var WEEK_JP = ['日', '月', '火', '水', '木', '金', '土'];

/** 'YYYY-MM-DD' → Date（0時）。不正なら null。 */
function dateObj_(date) {
  var m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/** 'YYYY-MM-DD' + 'HH:MM' → Date。不正なら null。 */
function dateTimeObj_(date, time) {
  var d = dateObj_(date), t = toMin_(time);
  if (!d || isNaN(t)) return null;
  d.setHours(Math.floor(t / 60), t % 60, 0, 0);
  return d;
}

/** 'HH:MM' → 0時からの分。不正なら NaN。 */
function toMin_(hm) {
  var m = String(hm).match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}

/** 0時からの分 → 'HH:MM'。 */
function minToHM_(n) { return pad2_(Math.floor(n / 60)) + ':' + pad2_(n % 60); }

/** '2026年7月20日(月)' */
function dateLabel_(d) {
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日(' + WEEK_JP[d.getDay()] + ')';
}

/** ボタン用の短い日付 '7/20(月)'（クイックリプライのラベルは20文字まで）。 */
function dateShort_(d) {
  return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEK_JP[d.getDay()] + ')';
}

/** '2026年7月20日(月) 14:00〜15:00' */
function reqLabel_(req) {
  return dateLabel_(req.dateObj) + ' ' + req.start + '〜' + req.end;
}

function isPast_(d) { return d.getTime() < Date.now(); }

function fmtDate_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}
function fmtDateTime_(d) {
  return fmtDate_(d) + ' ' + pad2_(d.getHours()) + ':' + pad2_(d.getMinutes());
}
function pad2_(n) { return ('0' + n).slice(-2); }

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ======================= デモ（実LINE不要・GASエディタから実行）=======================

/**
 * runDemo: サンプルの Webhook イベント列を handleEvent_ に与え、
 * 応答・台帳・リマインドの一連の挙動を Logger に出力する（実LINE不要）。
 * GASエディタで実行 → 実行ログで確認。戻り値の transcript はテスト用。
 *
 * 予約フローは「返ってきた選択肢の1つ目を押す」形で進める。
 * 候補は実行した日から作られるので、日付を書き足さなくてもいつ実行しても通る。
 */
function runDemo() {
  resetLedgerForDemo_();
  var U1 = 'Udemo-taro', U2 = 'Udemo-hanako';
  var transcript = [];

  function step(title, ev) {
    var replies = handleEvent_(ev);
    transcript.push({ title: title, event: ev, replies: replies, ledger: ledgerRows_() });
    Logger.log('── %s', title);
    Logger.log('入力: %s', JSON.stringify(ev));
    Logger.log('応答: %s', JSON.stringify(replies));
    return replies;
  }

  step('友だち追加', { type: 'follow', source: { userId: U1 } });
  step('キーワード「営業時間は？」', msgEvent_(U1, '営業時間は？'));
  step('キーワード「カラーの料金は？」', msgEvent_(U1, 'カラーの料金は？'));

  var r = step('予約開始（「予約したい」）', msgEvent_(U1, '予約したい'));
  while (firstChoice_(r)) {          // メニュー → 日付 → 時刻 と、候補が出る限り1つ目を押していく
    r = step('候補から選ぶ: ' + firstChoiceLabel_(r), pbEvent_(U1, firstChoice_(r)));
  }
  var confirmData = confirmChoice_(r);
  step('内容を確定', pbEvent_(U1, confirmData));

  step('別のお客さまが同じ枠を確定しようとする（重なりで満席になるはず）', pbEvent_(U2, confirmData));

  // 先客が入った日をもう一度たどって、埋まった時刻が候補から消えていることを見る
  var booked = ledgerRows_()[0];
  var r2 = step('別のお客さまが予約開始', msgEvent_(U2, '予約したい'));
  while (firstChoice_(r2) && firstChoice_(r2).indexOf('reserve_date') < 0) {
    r2 = step('候補から選ぶ: ' + firstChoiceLabel_(r2), pbEvent_(U2, firstChoice_(r2)));
  }
  if (booked) {
    var dayData = choiceByData_(r2, 'date=' + booked.date);
    if (dayData) step('先客がいる ' + booked.date + ' を選ぶ（' + booked.start + ' が候補から消えているはず）', pbEvent_(U2, dayData));
  }

  step('AI応答「駐車場はありますか？」', msgEvent_(U1, '駐車場はありますか？'));
  step('AI応答 答えられない質問「近くにおすすめランチある？」', msgEvent_(U1, '近くにおすすめのランチある？'));

  // 前日リマインドは追加オプション。既定は無効なので、ここだけ一時的に有効にして動きを見せる。
  var sent = 0;
  if (booked) {
    var eve = dateObj_(booked.date);
    eve.setDate(eve.getDate() - CONFIG.REMINDER.daysBefore);
    var prevReminder = CONFIG.ADDONS.REMINDER;
    CONFIG.ADDONS.REMINDER = true;
    Logger.log('── 前日リマインド（追加オプション。基準日 %s → 対象 %s）', fmtDate_(eve), booked.date);
    sent = sendReminders(fmtDate_(eve));
    CONFIG.ADDONS.REMINDER = prevReminder;
  }
  transcript.push({ title: 'reminders', sent: sent, ledger: ledgerRows_() });

  // トーク内キャンセル: 一覧 → 選択 → 取り消し → 枠が開く
  var cancelList = step('トーク内キャンセル：「予約キャンセル」', msgEvent_(U1, '予約キャンセル'));
  var pickData = firstChoice_(cancelList);
  if (pickData) {
    step('キャンセルする予約を選ぶ: ' + firstChoiceLabel_(cancelList), pbEvent_(U1, pickData));
    var cancelId = pickData.split('id=')[1];
    step('取り消しを確定', pbEvent_(U1, 'action=cancel_confirm&id=' + cancelId));
    step('キャンセルで空いた枠へ、別のお客さまが予約を開始できることを確認', msgEvent_(U2, '予約したい'));
  }

  return transcript;
}

function msgEvent_(userId, text) {
  return { type: 'message', replyToken: 'demoReply', source: { userId: userId }, message: { type: 'text', id: '1', text: text } };
}
function pbEvent_(userId, data) {
  return { type: 'postback', replyToken: 'demoReply', source: { userId: userId }, postback: { data: data } };
}

/** 応答に入っているクイックリプライの1つ目の postback data（デモ進行用）。 */
function firstChoice_(replies) {
  for (var i = 0; i < (replies || []).length; i++) {
    var q = replies[i].quickReply;
    if (q && q.items && q.items.length) return q.items[0].action.data;
  }
  return '';
}

/** 同じく1つ目のラベル（ログ表示用）。 */
function firstChoiceLabel_(replies) {
  for (var i = 0; i < (replies || []).length; i++) {
    var q = replies[i].quickReply;
    if (q && q.items && q.items.length) return q.items[0].action.label;
  }
  return '';
}

/** クイックリプライの中から needle を含む postback data を探す（デモ進行用）。 */
function choiceByData_(replies, needle) {
  for (var i = 0; i < (replies || []).length; i++) {
    var q = replies[i].quickReply;
    if (!q || !q.items) continue;
    for (var j = 0; j < q.items.length; j++) {
      if (String(q.items[j].action.data || '').indexOf(needle) >= 0) return q.items[j].action.data;
    }
  }
  return '';
}

/** 確認テンプレートの「確定する」の postback data（デモ進行用）。 */
function confirmChoice_(replies) {
  for (var i = 0; i < (replies || []).length; i++) {
    var t = replies[i].template;
    if (!t || !t.actions) continue;
    for (var j = 0; j < t.actions.length; j++) {
      if (String(t.actions[j].data || '').indexOf('action=reserve_confirm') === 0) return t.actions[j].data;
    }
  }
  return '';
}

/** デモ用に予約台帳を空にする（見出しだけ残す）。本番運用では呼ばない。 */
function resetLedgerForDemo_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.LEDGER_SHEET);
  if (sh) { ss.deleteSheet(sh); }
  ledgerSheet_();
}
