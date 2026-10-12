/**
 * run-tests.js: 実LINE不要のローカル検証ハーネス（Node.js）
 *
 * 目的:
 *   GAS用の Code.gs を Node で読み込み、GASのグローバル（SpreadsheetApp / Logger /
 *   PropertiesService / UrlFetchApp / ContentService 等）をモックして、
 *   LINE Webhook イベントJSON を入力に Bot の応答・予約台帳・二重予約防止（時間帯の重なり）・
 *   前日リマインド（追加オプション）を検証する。実 channelAccessToken もスプレッドシートも不要。
 *
 * 機能の範囲（2026-08-08 改訂）:
 *   メニュー選択・カレンダー登録・トーク内キャンセル・AI自動応答は既定の構成で常に動く。
 *   前日リマインドだけが追加オプションで、CONFIG.ADDONS.REMINDER でのみ制御される。
 *   以前あった構成ごとの機能の切り替えが戻っていないことも検証する（検証h）。
 *
 * 日付の扱い:
 *   検証日は実行日からの相対で作る（openDate / closedDate）。
 *   固定日をハードコードすると、その日が過去になった瞬間に isPast_ で全滅する（2026-07-30 に実際に起きた）。
 *
 * 実行:  npm test（node test/run-tests.js）
 * 期待:  すべて [PASS] で終了コード 0。1つでも失敗すると終了コード 1。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- GASグローバルのモック --------------------------------------------------

const logs = [];
const Logger = {
  log(fmt) {
    const args = Array.prototype.slice.call(arguments, 1);
    let i = 0;
    const s = String(fmt).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s'));
    logs.push(s);
  }
};

function makeSpreadsheetApp() {
  const sheets = new Map();
  function makeSheet(name) {
    const data = []; // 行の配列（各行はセルの配列）
    const sheet = {
      getName() { return name; },
      getLastRow() { return data.length; },
      getLastColumn() { return data.reduce((m, r) => Math.max(m, r.length), 0); },
      appendRow(arr) { data.push(arr.slice()); },
      setFrozenRows() { return this; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                const rr = data[r - 1 + i];
                row.push(rr && rr[c - 1 + j] !== undefined ? rr[c - 1 + j] : '');
              }
              out.push(row);
            }
            return out;
          },
          setValues(vals) {
            for (let i = 0; i < vals.length; i++) {
              const rowIdx = r - 1 + i;
              while (data.length <= rowIdx) data.push([]);
              for (let j = 0; j < vals[i].length; j++) data[rowIdx][c - 1 + j] = vals[i][j];
            }
            return this;
          },
          setValue(v) {
            const rowIdx = r - 1;
            while (data.length <= rowIdx) data.push([]);
            data[rowIdx][c - 1] = v;
            return this;
          },
          setFontWeight() { return this; }
        };
      },
      getDataRange() { return this.getRange(1, 1, Math.max(data.length, 1), this.getLastColumn() || 1); }
    };
    return sheet;
  }
  const ss = {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) { const s = makeSheet(name); sheets.set(name, s); return s; },
    deleteSheet(sheet) { for (const [k, v] of sheets) if (v === sheet) sheets.delete(k); }
  };
  return { getActiveSpreadsheet() { return ss; } };
}

const sandbox = {
  Logger,
  SpreadsheetApp: makeSpreadsheetApp(),
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  UrlFetchApp: { fetch() { throw new Error('UrlFetchApp.fetch がDEMO_MODEで呼ばれました（実送信は起きてはいけません）'); } },
  CalendarApp: { getDefaultCalendar() { throw new Error('CalendarApp がDEMO_MODEで呼ばれました'); } },
  Utilities: { computeHmacSha256Signature: () => [], base64Encode: () => '' },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput(s) { return { _s: s, setMimeType() { return this; }, getContent() { return this._s; } }; }
  },
  console
};

// ---- Code.gs をロード -------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'Code.gs' });

// ---- 検証ユーティリティ -----------------------------------------------------

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('[PASS] ' + label); }
  else { fail++; console.log('[FAIL] ' + label); }
}
function replyText(replies) {
  return (replies || []).filter(m => m.type === 'text').map(m => m.text).join('\n');
}
function hasTemplate(replies, altText) {
  return (replies || []).some(m => m.type === 'template' && m.altText === altText);
}
function quickActions(replies) {
  const out = [];
  (replies || []).forEach(m => { if (m.quickReply) m.quickReply.items.forEach(it => out.push(it.action)); });
  return out;
}
const quickLabels = r => quickActions(r).map(a => a.label);
const quickDatas = r => quickActions(r).map(a => a.data);
const hasQuick = r => quickActions(r).length > 0;

// handleEvent_ を直接叩くヘルパ
const H = sandbox.handleEvent_;
const msg = (u, t) => H({ type: 'message', source: { userId: u }, message: { type: 'text', text: t } });
const pb = (u, data) => H({ type: 'postback', source: { userId: u }, postback: { data: data } });

/** 'action=reserve_time&menu=cut&date=…&time=14:00' を組み立ててポストバックを投げる。 */
function flow(u, action, p) {
  let s = 'action=' + action;
  ['menu', 'staff', 'size', 'date', 'time'].forEach(k => { if (p && p[k]) s += '&' + k + '=' + p[k]; });
  return pb(u, s);
}

// ---- 日付ユーティリティ（実行日からの相対で作る）----------------------------

const fmt = sandbox.fmtDate_;

/** offset 日後。定休日に当たったら翌日へずらす。 */
function openDate(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  while (d.getDay() === sandbox.CONFIG.BUSINESS.closedWeekday) d.setDate(d.getDate() + 1);
  return fmt(d);
}
/** 明日以降で最初の定休日。 */
function closedDate() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== sandbox.CONFIG.BUSINESS.closedWeekday) d.setDate(d.getDate() + 1);
  return fmt(d);
}
/** その日の前日。 */
function eve(ds) {
  const d = sandbox.dateObj_(ds);
  d.setDate(d.getDate() - 1);
  return fmt(d);
}
/** '2026年8月3日(月)' 形式のラベル。 */
const labelOf = ds => sandbox.dateLabel_(sandbox.dateObj_(ds));

// ---- CONFIG の切り替え（各ブロック先頭で明示・終わりに restoreConfig）-------
// 受付ルール（BUSINESS）は店舗ごとの条件、ADDONS は有効にした追加オプション。

const C = sandbox.CONFIG;
const BASE = {
  BUSINESS: JSON.parse(JSON.stringify(C.BUSINESS)),
  ADDONS: JSON.parse(JSON.stringify(C.ADDONS))
};
const DEFAULT_REMINDER_ADDON = C.ADDONS.REMINDER; // 出荷時の既定値（false のはず）を検証hで見る

function setConfig(businessPatch) {
  Object.keys(BASE.BUSINESS).forEach(k => { C.BUSINESS[k] = JSON.parse(JSON.stringify(BASE.BUSINESS[k])); });
  Object.keys(BASE.ADDONS).forEach(k => { C.ADDONS[k] = BASE.ADDONS[k]; });
  if (businessPatch) Object.keys(businessPatch).forEach(k => { C.BUSINESS[k] = businessPatch[k]; });
}
function restoreConfig() { setConfig(null); }

const U1 = 'Utaro', U2 = 'Uhanako';
const D = openDate(3);   // 検証1〜6・a〜e で使う営業日
const D2 = openDate(5);  // 型変換回帰で使う営業日

// ============================================================================
// 検証1: キーワード応答と、候補ボタン2段フローでの予約成立（出荷時の既定構成）
// ============================================================================
setConfig(null);
sandbox.resetLedgerForDemo_();

ok(/営業時間/.test(replyText(msg(U1, '営業時間は？'))) && /10:00〜19:00/.test(replyText(msg(U1, '営業時間は？'))),
  '検証1a キーワード「営業時間」→ 時間を含む応答');
ok(/4,400|7,700/.test(replyText(msg(U1, 'カラーの料金は？'))),
  '検証1b キーワード「料金」→ メニュー料金の応答');

const startReply = msg(U1, '予約したい');
ok(quickLabels(startReply).indexOf('カット（60分）') >= 0 && /メニュー/.test(replyText(startReply)),
  '検証1c 「予約」→ メニュー選択のクイックリプライ（所要時間つき）');

const dateReply = flow(U1, 'reserve_menu', { menu: 'cut' });
ok(hasQuick(dateReply) && quickDatas(dateReply).every(d => d.indexOf('action=reserve_date') === 0) &&
   quickDatas(dateReply).some(d => d.indexOf('date=' + D) >= 0),
  '検証1d メニュー選択 → 空きのある来店日の候補（' + D + ' を含む）');

const timeReply = flow(U1, 'reserve_date', { menu: 'cut', date: D });
ok(quickLabels(timeReply).indexOf('14:00') >= 0 && quickDatas(timeReply).every(d => d.indexOf('action=reserve_time') === 0),
  '検証1e 来店日選択 → その日の空き開始時刻の候補（14:00 を含む）');

const confReply = flow(U1, 'reserve_time', { menu: 'cut', date: D, time: '14:00' });
ok(hasTemplate(confReply, '予約内容の確認'),
  '検証1f 開始時刻選択 → 確認テンプレートを提示');

const doneReply = flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '14:00' });
ok(/ご予約を確定/.test(replyText(doneReply)) &&
   replyText(doneReply).indexOf(labelOf(D) + ' 14:00〜15:00') >= 0,
  '検証1g 確定 → 予約確定メッセージ（日付・曜日・開始〜終了）');

const rows1 = sandbox.ledgerRows_();
ok(rows1.length === 1 && rows1[0].start === '14:00' && rows1[0].end === '15:00' &&
   rows1[0].menuId === 'cut' && rows1[0].size === 1 && rows1[0].calId === 'demo-cal-' + rows1[0].id,
  '検証1h 台帳に1件（開始/終了/メニュー/人数/カレンダーIDつき）');

// ============================================================================
// 検証2: 二重予約防止（区間の重なり）と確定直前ガード
// ============================================================================
const dbl = flow(U2, 'reserve_time', { menu: 'cut', date: D, time: '14:00' });
ok(/満席/.test(replyText(dbl)),
  '検証2a 別ユーザーが同一枠 14:00 を選択 → 満席で弾く');
ok(sandbox.ledgerRows_().filter(r => r.date === D && r.start === '14:00').length === 1,
  '検証2b 台帳の 14:00 枠は1件のまま（二重登録なし）');

const guard = flow(U2, 'reserve_confirm', { menu: 'cut', date: D, time: '14:00' });
ok(/満席/.test(replyText(guard)) && hasQuick(guard),
  '検証2c 確定直前ガード：埋まった枠のconfirmを満席で弾き、選べる日付候補を出し直す');

ok(hasTemplate(flow(U2, 'reserve_time', { menu: 'cut', date: D, time: '15:00' }), '予約内容の確認'),
  '検証2d 重ならない 15:00 は空きあり');
flow(U2, 'reserve_confirm', { menu: 'cut', date: D, time: '15:00' });
ok(sandbox.ledgerRows_().length === 2, '検証2e 別枠の確定で台帳2件');

// ============================================================================
// 検証3: 受付ルール（定休日・営業時間）
// ============================================================================
const CD = closedDate();
ok(/定休日/.test(replyText(flow(U1, 'reserve_time', { menu: 'cut', date: CD, time: '11:00' }))),
  '検証3a 定休日(火) ' + CD + ' → 受付不可');
ok(quickDatas(flow(U1, 'reserve_menu', { menu: 'cut' })).every(d => d.indexOf('date=' + CD) < 0),
  '検証3b 定休日は来店日の候補に出てこない');
ok(/受付時間/.test(replyText(flow(U1, 'reserve_time', { menu: 'cut', date: D, time: '18:30' }))),
  '検証3c 18:30開始（60分＝19:30終了）は営業時間をはみ出すので受付不可');

// ============================================================================
// 検証4: AI応答（DEMO_MODE では demoAi_ の固定応答）
// ============================================================================
ok(/コインパーキング/.test(replyText(msg(U1, '駐車場はありますか？'))),
  '検証4a AI応答：店舗情報の範囲（駐車場）に回答');
ok(/スタッフが確認|お電話/.test(replyText(msg(U1, '近くにおすすめのランチある？'))),
  '検証4b AI応答：答えられない質問は有人・フォームへ案内(fallback)');

// ============================================================================
// 検証5: 前日リマインド（追加オプション。CONFIG.ADDONS.REMINDER でのみ制御）
//   ここまでで D の確定予約は2件（検証1の14:00・検証2の15:00）。
// ============================================================================
C.ADDONS.REMINDER = false;
logs.length = 0;
ok(sandbox.sendReminders(eve(D)) === 0,
  '検証5a 前日リマインドが OFF（ADDONS.REMINDER=false）なら1件も送らない');
ok(!/プラン/.test(logs.join('\n')),
  '検証5b 無効時のログに「含まれません」のような区分前提の文言が出ない');

const confNoReminder = replyText(flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '16:00' }));
ok(/ご予約を確定/.test(confNoReminder) && !/前日/.test(confNoReminder),
  '検証5c 前日リマインドが OFF なら確定メッセージでリマインドを約束しない');

C.ADDONS.REMINDER = true;
const confWithReminder = replyText(flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '17:00' }));
ok(/前日にこのトークでリマインド/.test(confWithReminder),
  '検証5d オプション有効なら確定メッセージで前日リマインドを案内する');

ok(sandbox.sendReminders(eve(D)) === 4,
  '検証5e オプション有効：' + D + ' の確定4件（14:00/15:00/16:00/17:00）に送信');
ok(sandbox.sendReminders(eve(D)) === 0,
  '検証5f 再実行しても「済」で重複送信しない');
C.ADDONS.REMINDER = false;

// ============================================================================
// 検証6: doPost（Webエントリの全経路）。DEMO_MODEで実送信せずログ出力
// ============================================================================
logs.length = 0;
const out = sandbox.doPost({ postData: { contents: JSON.stringify({ events: [
  { type: 'message', replyToken: 'tk', source: { userId: U1 }, message: { type: 'text', text: '営業時間は？' } }
] }) } });
ok(/\[demo\]\[reply\]/.test(logs.join('\n')) && /"ok":true/.test(out.getContent()),
  '検証6 doPost：Webhook JSON を受けて reply をログ出力し 200相当を返す');

// ============================================================================
// 検証7: Sheets の型自動変換への耐性（2026-07-16 実機で発覚したバグの回帰テスト）
//   appendRow で書いた 'YYYY-MM-DD' / 'HH:MM' を Sheets が日付型・時刻型セルへ自動変換すると、
//   素朴な String() 読み戻しでは照合が外れ、二重予約防止・リマインド対象日判定が壊れる。
//   新スキーマでは 予約日・開始・終了 の3列すべてに効かせる必要がある。
// ============================================================================
sandbox.resetLedgerForDemo_();
flow(U1, 'reserve_confirm', { menu: 'cut', date: D2, time: '14:00' });
const sh = sandbox.ledgerSheet_();
const d2 = sandbox.dateObj_(D2);
sh.getRange(2, 3).setValue(new Date(d2.getFullYear(), d2.getMonth(), d2.getDate())); // 予約日が日付型セルに
sh.getRange(2, 4).setValue(new Date(1899, 11, 30, 14, 0));                           // 開始が時刻型セルに
sh.getRange(2, 5).setValue(new Date(1899, 11, 30, 15, 0));                           // 終了が時刻型セルに
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { menu: 'cut', date: D2, time: '14:30' }))),
  '検証7a 型変換後も重なる 14:30 を満席で弾く（予約日・開始・終了の3列を吸収）');
C.ADDONS.REMINDER = true;
ok(sandbox.sendReminders(eve(D2)) === 1,
  '検証7b 型変換後も前日リマインドの対象日照合が一致する');
restoreConfig();

// ============================================================================
// 検証a: 「メニュー」シートが空の店舗（メニュー選択を出さず既定所要時間60分で受ける）
//   メニューを持たない業態向けの構成。シートの中身で決まる。
// ============================================================================
setConfig({ capacityPerSlot: 1, defaultDurationMinutes: 60, askPartySize: false, STAFF: [] });
sandbox.resetLedgerForDemo_();
sandbox.clearSheetCache_();
const menuShEmpty = sandbox.menuSheet_();
const ORIG_MENU_IDS = [];
for (let r = 2; r <= menuShEmpty.getLastRow(); r++) {
  ORIG_MENU_IDS.push(menuShEmpty.getRange(r, 1).getValues()[0][0]);
  menuShEmpty.getRange(r, 1).setValue(''); // ID列を空にすると menuList_ が拾わない＝メニュー未登録の店舗
}
sandbox.clearSheetCache_();

const noMenuStart = msg(U1, '予約したい');
ok(quickDatas(noMenuStart).length > 0 && quickDatas(noMenuStart).every(d => d.indexOf('action=reserve_date') === 0),
  '検証a1 メニュー未登録ならメニュー選択を飛ばして来店日の候補から始まる');
const noMenuDone = replyText(flow(U1, 'reserve_confirm', { date: D, time: '14:00' }));
ok(noMenuDone.indexOf(labelOf(D) + ' 14:00〜15:00') >= 0,
  '検証a2 既定所要時間60分で 14:00〜15:00 として確定する');
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { date: D, time: '14:30' }))),
  '検証a3 重なる 14:30 開始は満席で弾く（完全一致ではなく区間判定）');
const noMenuTimes = quickLabels(flow(U2, 'reserve_date', { date: D }));
ok(noMenuTimes.indexOf('14:30') < 0 && noMenuTimes.indexOf('14:00') < 0 && noMenuTimes.indexOf('10:00') >= 0,
  '検証a4 14:00/14:30 は時刻候補に出てこない（空いている時刻だけを出す）');

for (let i = 0; i < ORIG_MENU_IDS.length; i++) menuShEmpty.getRange(i + 2, 1).setValue(ORIG_MENU_IDS[i]); // 元に戻す
sandbox.clearSheetCache_();
restoreConfig();

// ============================================================================
// 検証b: カラー120分。埋まる長さがメニューで変わる
// ============================================================================
setConfig({ capacityPerSlot: 1, askPartySize: false, STAFF: [] });
sandbox.resetLedgerForDemo_();
flow(U1, 'reserve_confirm', { menu: 'color', date: D, time: '14:00' });
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { menu: 'color', date: D, time: '15:00' }))),
  '検証b1 カラー(120分) 14:00確定後、15:00 開始は満席');
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { menu: 'color', date: D, time: '15:30' }))),
  '検証b2 同上、15:30 開始も満席');
ok(hasTemplate(flow(U2, 'reserve_time', { menu: 'color', date: D, time: '16:00' }), '予約内容の確認'),
  '検証b3 16:00 開始（16:00〜18:00）は重ならないので通る');
restoreConfig();

// ============================================================================
// 検証c: 担当ごとに枠を数える（スタッフ単位・capacity1）
// ============================================================================
setConfig({ STAFF: [{ id: 'sato', name: '佐藤' }, { id: 'suzuki', name: '鈴木' }] });
sandbox.resetLedgerForDemo_();
ok(quickLabels(flow(U1, 'reserve_menu', { menu: 'cut' })).join('/') === '佐藤/鈴木',
  '検証c1 担当が登録されていればメニューの次に担当選択が入る');
flow(U1, 'reserve_confirm', { menu: 'cut', staff: 'sato', date: D, time: '14:00' });
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { menu: 'cut', staff: 'sato', date: D, time: '14:00' }))),
  '検証c2 佐藤 14:00 確定後、佐藤の同じ枠は満席');
ok(hasTemplate(flow(U2, 'reserve_time', { menu: 'cut', staff: 'suzuki', date: D, time: '14:00' }), '予約内容の確認'),
  '検証c3 同じ時刻でも鈴木は空いているので通る');
restoreConfig();

// ============================================================================
// 検証d: 人数で埋まり方が変わる（askPartySize + capacity4）
// ============================================================================
setConfig({ askPartySize: true, capacityPerSlot: 4, STAFF: [] });
sandbox.resetLedgerForDemo_();
flow(U1, 'reserve_confirm', { menu: 'cut', size: 2, date: D, time: '14:00' });
ok(/満席/.test(replyText(flow(U2, 'reserve_time', { menu: 'cut', size: 3, date: D, time: '14:30' }))),
  '検証d1 2名確定済みの枠に重なる 3名（合計5>4）は満席');
ok(hasTemplate(flow(U2, 'reserve_time', { menu: 'cut', size: 2, date: D, time: '14:30' }), '予約内容の確認'),
  '検証d2 同じ枠でも 2名（合計4=定員）なら通る');
restoreConfig();

// ============================================================================
// 検証e: 主な機能が既定の構成のままで全部動く
// ============================================================================
setConfig(null);
sandbox.resetLedgerForDemo_();

const e1Start = msg(U1, '予約したい');
ok(quickDatas(e1Start).length > 0 && quickDatas(e1Start).every(d => d.indexOf('action=reserve_menu') === 0),
  '検証e1 メニュー選択（可変の所要時間）が既定で入口に出る');

const e2Done = flow(U1, 'reserve_confirm', { menu: 'color', date: D, time: '14:00' });
const e2Row = sandbox.ledgerRows_()[0];
ok(/ご予約を確定/.test(replyText(e2Done)) && e2Row.start === '14:00' && e2Row.end === '16:00',
  '検証e2 メニューの所要時間（カラー120分）がそのまま枠の長さになる');
ok(e2Row.calId === 'demo-cal-' + e2Row.id,
  '検証e3 Googleカレンダー登録が既定で動く（台帳にカレンダーIDが入る）');

const e4Cancel = msg(U1, '予約キャンセル');
ok(quickActions(e4Cancel).length === 1 && quickActions(e4Cancel)[0].data.indexOf('action=cancel_pick&id=') === 0,
  '検証e4 トーク内キャンセルが既定で動く（自分の予約一覧が出る）');

ok(/コインパーキング/.test(replyText(msg(U1, '駐車場はありますか？'))),
  '検証e5 AI自動応答が既定で動く（キーワード外の自由質問に回答）');

logs.length = 0;
ok(sandbox.sendReminders(eve(D)) === 0 && !/プラン/.test(logs.join('\n')),
  '検証e6 前日リマインドは既定で無効（区分前提の文言も出さない）');
restoreConfig();

// ============================================================================
// 検証f1〜f6: トーク内キャンセル（全構成共通。有人案内に落とさない）
// ============================================================================

// f1: 「予約キャンセル」→ 自分の確定予約一覧（cancel_pick の quick reply）。
//     「予約」の予約フローに食われず、キャンセル導線に入ることの検証を兼ねる。
setConfig(null);
sandbox.resetLedgerForDemo_();
flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '14:00' });
const cancelListReply = msg(U1, '予約キャンセル');
const cancelActions = quickActions(cancelListReply);
ok(cancelActions.length === 1 && cancelActions[0].data.indexOf('action=cancel_pick&id=') === 0,
  '検証f1 「予約キャンセル」→ 自分の確定予約一覧（cancel_pickのquick reply）。予約フローに食われない');
const cancelId1 = cancelActions[0].data.split('id=')[1];

// f2: cancel_pick → 取り消し確認の confirm テンプレート
const pickReply = pb(U1, 'action=cancel_pick&id=' + cancelId1);
ok(hasTemplate(pickReply, '予約の取り消し確認'),
  '検証f2 cancel_pick → 取り消し確認のconfirmテンプレートが返る');

// f3: cancel_confirm → 台帳の状態が「キャンセル」に、カレンダー削除のログが出る
logs.length = 0;
const confirmCancelReply = pb(U1, 'action=cancel_confirm&id=' + cancelId1);
ok(/ご予約を取り消しました/.test(replyText(confirmCancelReply)),
  '検証f3a cancel_confirm → 取り消し完了メッセージが返る');
const cancelledRow = sandbox.ledgerRows_().filter(r => r.id === cancelId1)[0];
ok(!!cancelledRow && cancelledRow.status === 'キャンセル',
  '検証f3b 台帳の該当行の状態が「キャンセル」になる（行削除はしない）');
ok(/\[demo\]\[calendar\] 予定を削除（想定）: demo-cal-/.test(logs.join('\n')),
  '検証f3c カレンダー削除のログ（demo-cal-…）が出る');

// f4: キャンセル後、同じ枠を別ユーザーが予約できる（枠の開放）
ok(hasTemplate(flow(U2, 'reserve_time', { menu: 'cut', date: D, time: '14:00' }), '予約内容の確認'),
  '検証f4 キャンセル後、同じ枠(' + D + ' 14:00)を別ユーザーが予約できる（枠の開放）');

// f5: 他人の予約IDで cancel_confirm を投げても取り消されない
sandbox.resetLedgerForDemo_();
flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '14:00' });
const victim = sandbox.ledgerRows_()[0];
const spoofReply = pb(U2, 'action=cancel_confirm&id=' + victim.id);
ok(!/ご予約を取り消しました/.test(replyText(spoofReply)),
  '検証f5a 他人の予約IDへの cancel_confirm は取り消し完了にならない（postback dataは端末側で偽装可能という前提）');
ok(sandbox.ledgerRows_().filter(r => r.id === victim.id)[0].status === '確定',
  '検証f5b 該当予約の状態は「確定」のまま');

// f6: 確定予約が無い人には「ご予約はありません」を返す（有人対応への案内には落とさない）
sandbox.resetLedgerForDemo_();
const emptyCancelReply = msg(U1, 'キャンセルしたいです');
ok(/確定済みのご予約はありません/.test(replyText(emptyCancelReply)) &&
   !/スタッフが確認/.test(replyText(emptyCancelReply)),
  '検証f6 確定予約が無ければ「ご予約はありません」。有人対応の案内には落とさない');
restoreConfig();

// ============================================================================
// 検証g1〜g3: 設定・よくある質問・メニューのシート外出し
//   シートを書き換えるテストは、確認後に必ず初期値へ戻す。
// ============================================================================

// g1: 「よくある質問」シートの返信文を書き換える → 応答がその内容に変わる（プレースホルダ置換込み）
setConfig(null);
sandbox.clearSheetCache_();
const curStoreForG1 = sandbox.storeInfo_();
const faqSh = sandbox.faqSheet_();
const ORIG_FAQ_ANSWER = faqSh.getRange(2, 2).getValues()[0][0]; // 「営業時間」行の返信文
faqSh.getRange(2, 2).setValue('ただいま{店舗名}は{営業時間}で営業中です（テスト文言）。');
sandbox.clearSheetCache_();
const faqResp = replyText(msg(U1, '営業時間は？'));
ok(faqResp.indexOf('テスト文言') >= 0 && faqResp.indexOf(curStoreForG1.name) >= 0 && faqResp.indexOf(curStoreForG1.hours) >= 0,
  '検証g1 「よくある質問」シートの返信文を書き換えると応答がその内容に変わる（プレースホルダ置換込み）');
faqSh.getRange(2, 2).setValue(ORIG_FAQ_ANSWER); // 元に戻す
sandbox.clearSheetCache_();

// g2: 「設定」シートの店舗名を書き換える → 応答（あいさつ）に新店舗名が反映される
const storeSh = sandbox.storeSheet_();
const ORIG_STORE_NAME = storeSh.getRange(2, 2).getValues()[0][0]; // 「店舗名」行の値
storeSh.getRange(2, 2).setValue('テスト新サロン');
sandbox.clearSheetCache_();
const greetReply = H({ type: 'follow', source: { userId: U1 } });
ok(/テスト新サロン/.test(replyText(greetReply)),
  '検証g2 「設定」シートの店舗名を書き換えるとあいさつ文に新店舗名が反映される');
storeSh.getRange(2, 2).setValue(ORIG_STORE_NAME); // 元に戻す
sandbox.clearSheetCache_();

// g3: 「メニュー」シートの所要時間を書き換える（カット60→90分）→ 確定メッセージの終了時刻が変わる
sandbox.resetLedgerForDemo_();
sandbox.clearSheetCache_();
const menuSh = sandbox.menuSheet_();
const ORIG_CUT_MINUTES = menuSh.getRange(2, 3).getValues()[0][0]; // 「カット」行の所要時間(分)
menuSh.getRange(2, 3).setValue(90);
sandbox.clearSheetCache_();
const g3Reply = flow(U1, 'reserve_confirm', { menu: 'cut', date: D, time: '14:00' });
ok(/ご予約を確定/.test(replyText(g3Reply)) && replyText(g3Reply).indexOf('14:00〜15:30') >= 0,
  '検証g3 「メニュー」シートの所要時間を書き換えると確定メッセージの終了時刻が変わる（カット60→90分・14:00開始→15:30終了）');
menuSh.getRange(2, 3).setValue(ORIG_CUT_MINUTES); // 元に戻す
sandbox.clearSheetCache_();
restoreConfig();

// ============================================================================
// 検証h: 以前あった構成ごとの機能の切り替えが戻っていないこと（2026-08-08 の変更の回帰テスト）
//   ソースとグローバルの両方で見張る。
// ============================================================================
ok(!/PLAN_FEATURES|planHas_/.test(src) && !/CONFIG\.PLAN\b/.test(src) &&
   typeof sandbox.planHas_ === 'undefined' && typeof sandbox.PLAN_FEATURES === 'undefined' &&
   C.PLAN === undefined,
  '検証h1 古い機能区分の仕組み（PLAN_FEATURES / planHas_ / CONFIG.PLAN）がコードに残っていない');
ok(DEFAULT_REMINDER_ADDON === false && typeof C.ADDONS === 'object',
  '検証h2 前日リマインドは独立したスイッチ（CONFIG.ADDONS.REMINDER・既定false）');

// ---- 参考出力（runDemo の一連トランスクリプト）------------------------------
console.log('\n========== runDemo() トランスクリプト（抜粋）==========');
sandbox.runDemo();
console.log(logs.slice(-4).join('\n'));

console.log('\n==========================================');
console.log('結果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
