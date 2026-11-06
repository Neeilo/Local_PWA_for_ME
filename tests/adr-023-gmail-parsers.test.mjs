/**
 * ADR-023 PR-C — Gmail 帳單解析器（D-9、D-10）
 *
 * 為什麼：GMAIL_PARSERS 一直是空物件，4 條規則填了解析器名字卻天天在 logs 留「parser 不認得」，
 * 帳單金額與截止日從來沒進過 gmail_log／每日摘要。
 * 盯的事：
 *   - 4 個解析器對去識別樣本（tests/fixtures/gmail/）拿到正確金額＋西元截止日；ETC 只有合計與帳單月份
 *   - 版面寬鬆：表格的 |、換行、全形字、標籤與值不同行都吃
 *   - 帳號類資訊（中信扣款帳號、兆豐約定帳號）絕不出現在結果裡（D-10）
 *   - 抓不到的欄位留白、不丟例外；抓到的照存（ADR-023 改掉 ADR-016「一半就全清」，Neil 2026-11-03 確認）
 *   - 每日 log 不再出現「parser 不認得」
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gmail');
const sample = (name) => readFileSync(join(FIX, name), 'utf8');

const e = loadCodeGs({ extraFiles: ['line-router.gs'] });
const parse = (name, text) => e.read(`GMAIL_PARSERS[${JSON.stringify(name)}](${JSON.stringify(text)})`);

const EXPECT = {
  bill_cathay: { amount: 1704, due_date: '2026-11-13' },
  bill_ctbc_notice: { amount: 9051, due_date: '2026-09-15', period: '2026-08' },
  bill_mega: { amount: 27466, due_date: '2026-10-28' },
  etag_fetc: { amount: 503, period: '2026-09' }
};

describe('4 個解析器 × 樣本信', () => {
  for (const [name, want] of Object.entries(EXPECT)) {
    for (const file of [name + '.txt', name + '.plain.txt']) {
      test(`${file}：金額與截止日（民國年轉西元）`, () => {
        const got = parse(name, sample(file));
        for (const k of Object.keys(want)) assert.equal(got[k], want[k], k);
      });
    }
  }

  test('ETC 取「實際扣（繳）款金額合計」，不是金額(E)合計、也不自己加', () => {
    assert.equal(parse('etag_fetc', sample('etag_fetc.txt')).amount, 503);
  });

  test('ETC 沒有截止日（已扣款）：due_date 留白', () => {
    assert.equal(parse('etag_fetc', sample('etag_fetc.txt')).due_date || '', '');
  });

  test('兆豐：金額帶 .00 也吃；不會誤抓「最低應繳金額」或約定帳號那行的扣款金額', () => {
    const t = '最低應繳金額 | 1.00 |\n| 本期應繳金額 | 300.00 |\n繳款截止日 115/1/5';
    assert.deepEqual([parse('bill_mega', t).amount, parse('bill_mega', t).due_date], [300, '2026-01-05']);
  });
});

describe('帳號類資訊一律不寫入（D-10）', () => {
  test('解析結果不含帳號、車號字串，只有約定的欄位', () => {
    for (const name of Object.keys(EXPECT)) {
      for (const file of [name + '.txt', name + '.plain.txt']) {
        const got = parse(name, sample(file));
        const json = JSON.stringify(got);
        assert.doesNotMatch(json, /99999|\*{4}|xxxxx|000000000|X-0000|帳號|行庫/, file);
        for (const k of Object.keys(got)) assert.ok(['amount', 'due_date', 'period'].includes(k), file + ' 多了 ' + k);
      }
    }
  });
});

describe('抓不到：留白、不丟例外', () => {
  test('空字串、亂碼、只有金額或只有截止日', () => {
    for (const name of Object.keys(EXPECT)) {
      assert.doesNotThrow(() => parse(name, ''));
      const empty = parse(name, '版面改了 ¯\\_(ツ)_/¯');
      assert.ok(!empty.amount && !empty.due_date, name);
    }
    const onlyDue = parse('bill_cathay', '繳款截止日\n115/11/13');
    assert.equal(onlyDue.due_date, '2026-11-13');
    assert.ok(!onlyDue.amount);
  });

  test('不存在的日期（115/02/30）不硬轉', () => {
    assert.ok(!parse('bill_cathay', '繳款截止日 115/02/30 本期應繳總金額 100').due_date);
  });
});

/* ========================================================================== */
/* 控制員整合：寫進 gmail_log、摘要                                              */
/* ========================================================================== */

const RULES_H = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
  'label', 'save_attachment', 'notify', 'parser', 'note'];
const LOG_H = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount',
  'due_date', 'status', 'attachment_url', 'gmail_link', 'processed_at'];
const NOW = new Date('2026-11-03T01:00:00Z');
const RULES = [
  { rule_id: 1, is_active: 'TRUE', source_name: '國泰世華', mail_type: 'bill', from: 'cathaybk.com.tw', parser: 'bill_cathay', notify: 'TRUE' },
  { rule_id: 2, is_active: 'TRUE', source_name: '中信', mail_type: 'bill', from: 'ctbcbank.com', parser: 'bill_ctbc_notice', notify: 'TRUE' },
  { rule_id: 3, is_active: 'TRUE', source_name: '兆豐', mail_type: 'bill', from: 'megabank.com.tw', parser: 'bill_mega', notify: 'TRUE' },
  { rule_id: 4, is_active: 'TRUE', source_name: 'ETC', mail_type: 'etag', from: 'fetc.net.tw', subject_kw: 'ETC 報帳報表', parser: 'etag_fetc', notify: 'TRUE' }
];
const row = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));

function controller(bodies) {
  const msgs = [['m1', 'service@pxbillrc01.cathaybk.com.tw', '國泰世華銀行信用卡2026年10月電子帳單'],
    ['m2', 'bank.csc@inib.ctbcbank.com', '信用卡帳單繳款通知'],
    ['m3', 'billhunter@billhunter.megabank.com.tw', '兆豐銀行_信用卡對帳單115年10月12日'],
    ['m4', 'FETCService@fetc.net.tw', '【ETC儲值帳戶報帳報表】車號：**X-0000報表(含PDF檔)']];
  const threads = msgs.map(([id, from, subject], i) => ({
    getId: () => 't' + (i + 1),
    getPermalink: () => 'https://mail.google.com/mail/u/0/#all/t' + (i + 1),
    addLabel: () => {},
    getMessages: () => [{
      getId: () => id, getFrom: () => from, getSubject: () => subject,
      getDate: () => new Date(NOW.getTime() - 3600e3), getPlainBody: () => bodies[i], getAttachments: () => []
    }]
  }));
  const env = loadCodeGs({
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    sheets: {
      gmail_rules: new FakeSheet('gmail_rules', [RULES_H].concat(RULES.map((r) => row(RULES_H, r)))),
      gmail_log: new FakeSheet('gmail_log', [LOG_H]),
      line_groups: new FakeSheet('line_groups', [['group_id', 'name', 'is_active', 'left_at', 'notify_gmail'], ['Cg', 'g', 'TRUE', '', 'TRUE']])
    },
    overrides: {
      GmailApp: {
        search: (q) => threads.filter((t, i) => q.indexOf(RULES[i].from) !== -1),
        getUserLabelByName: () => ({}), createLabel: () => ({})
      }
    }
  });
  env.call('runGmailController_', NOW);
  return env;
}

describe('控制員：金額＋截止日進 gmail_log 與摘要', () => {
  const files = ['bill_cathay.txt', 'bill_ctbc_notice.txt', 'bill_mega.txt', 'etag_fetc.txt'];

  test('4 封都 ✅ 已解析（ETC 沒有截止日也算）；log 不再出現「parser 不認得」', () => {
    const env = controller(files.map(sample));
    const rows = env.sheets.gmail_log.toRecords();
    assert.deepEqual(rows.map((r) => [r.msg_id, r.status, r.amount, r.due_date]), [
      ['m1', '✅ 已解析', 1704, '2026-11-13'], ['m2', '✅ 已解析', 9051, '2026-09-15'],
      ['m3', '✅ 已解析', 27466, '2026-10-28'], ['m4', '✅ 已解析', 503, '']]);
    assert.ok(!env.transactions.some((t) => /不認得/.test(String(t[4]))));
    const text = env.pushes[0].text;
    assert.match(text, /・國泰世華｜NT\$1,704｜11\/13 截止/);
    assert.match(text, /・兆豐｜NT\$27,466｜10\/28 截止/);
    assert.match(text, /📄 知道就好 1 封｜留在收件匣\n・ETC｜NT\$503/);   // ADR-026：改依 bucket 分組、逐封列
    assert.doesNotMatch(JSON.stringify(rows) + text, /99999|xxxxx/);
  });

  test('只抓到金額：金額照存、截止日留白、⚠️ 待確認，摘要註記「截止日解析不到」', () => {
    const env = controller(['本期應繳總金額\n1,704', sample(files[1]), sample(files[2]), sample(files[3])]);
    const r = env.sheets.gmail_log.toRecords()[0];
    assert.deepEqual([r.status, r.amount, r.due_date], ['⚠️ 待確認', 1704, '']);
    assert.match(env.pushes[0].text, /・國泰世華｜NT\$1,704｜截止日解析不到/);
  });

  test('什麼都抓不到：兩欄留白、⚠️ 待確認，摘要註記「金額解析不到」，其他封照常', () => {
    const env = controller(['改版了', sample(files[1]), sample(files[2]), sample(files[3])]);
    const rows = env.sheets.gmail_log.toRecords();
    assert.deepEqual([rows[0].status, rows[0].amount, rows[0].due_date], ['⚠️ 待確認', '', '']);
    assert.equal(rows[1].status, '✅ 已解析');
    assert.match(env.pushes[0].text, /・國泰世華｜金額解析不到｜截止日解析不到/);
  });
});
