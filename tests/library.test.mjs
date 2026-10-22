/**
 * 案例库检索引擎测试：node --test tests/library.test.mjs
 * 重点验证需求里的硬约束：搜索结果不受当前分类筛选状态影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES, CASE_CATEGORIES, casesOfCategory, getCase, getCategory } from '../kb/cases.js';
import {
  normalize, searchableFields, searchCases, casesByCategory, filterCases,
  sortByDateDesc, paginate, categoryStats, formatDate,
} from '../engine/library.js';

const ALL = Object.values(CASES);

test('案例库结构完整：10 个分类、每类至少 1 例、字段齐全', () => {
  assert.ok(CASE_CATEGORIES.length >= 6, '需求要求至少覆盖刷单/公检法/投资/客服/贷款/杀猪盘');
  const ids = new Set(CASE_CATEGORIES.map((c) => c.id));
  for (const c of ALL) {
    assert.ok(ids.has(c.catId), `${c.id} 的 catId 不在分类表中：${c.catId}`);
    for (const f of ['title', 'summary', 'date', 'severity']) {
      assert.ok(c[f] && String(c[f]).trim(), `${c.id} 缺字段 ${f}`);
    }
    for (const f of ['method', 'say', 'cracks', 'action']) {
      assert.ok(Array.isArray(c[f]) && c[f].length > 0, `${c.id} 的 ${f} 应为非空数组`);
    }
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/, `${c.id} 日期格式应为 YYYY-MM-DD`);
  }
});

test('需求点名的分类均存在', () => {
  const names = CASE_CATEGORIES.map((c) => c.name);
  for (const n of ['刷单返利', '冒充公检法', '虚假投资理财', '虚假购物客服', '网络贷款', '杀猪盘']) {
    assert.ok(names.includes(n), `缺少分类：${n}`);
  }
});

test('案例库不含真实可用的敏感信息（全部话术须可脱敏）', () => {
  // 复用互动模式的知识库脱敏函数，保证两处口径一致
  return import('../kb/scenarios.js').then(({ sanitize }) => {
    for (const c of ALL) {
      for (const line of c.say) {
        assert.equal(sanitize(line), line, `${c.id} 话术含可识别敏感串：${line}`);
      }
    }
  });
});

test('normalize 折叠空白而非删除（多关键词分词依赖空格）', () => {
  assert.equal(normalize('  Hello   World '), 'hello world');
  assert.equal(normalize('安全账户 转账'), '安全账户 转账', '空格必须保留，否则多关键词搜索失效');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});

test('searchableFields 覆盖标题/摘要/分类/标签/正文', () => {
  const c = CASES.c004;
  const f = searchableFields(c);
  assert.ok(f.some((x) => x.includes('安全账户')), '应包含话术');
  assert.ok(f.some((x) => x.includes('公检法')), '应包含分类名');
  assert.ok(f.some((x) => x.includes('保密')), '应包含破绽段落');
  assert.ok(f.some((x) => x.includes('资金清查')), '应包含标题');
});

test('searchCases 空关键词返回全量', () => {
  assert.equal(searchCases('').length, ALL.length);
  assert.equal(searchCases('   ').length, ALL.length);
  assert.equal(searchCases(null).length, ALL.length);
});

test('★ 搜索不受当前分类筛选状态影响（核心约束）', () => {
  // 需求原文：搜索时在全部案例范围内匹配，无需考虑案例是否在当前界面中显示。
  // 1) 结构约束：searchCases 的签名与实现里根本没有分类参数，从类型层面无法限定范围。
  assert.equal(searchCases.length, 2, 'searchCases 应为 (keyword, pool?) 两个参数');
  assert.equal(searchCases.toString().match(/\bcatId\b/g), null, 'searchCases 实现中不应出现 catId');

  // 2) 行为约束：用跨分类关键词搜索，无论当前停在哪个分类，结果都覆盖全库
  const kw = '验证码'; // 出现在 shopping / police / pig 等多个分类
  const hits = searchCases(kw);
  const hitCats = new Set(hits.map((c) => c.catId));
  assert.ok(hitCats.size >= 2, `「${kw}」应命中多个分类，实际 ${[...hitCats].join(',')}`);
  for (const current of hitCats) {
    const outside = hits.filter((c) => c.catId !== current);
    assert.ok(outside.length > 0, `当前停在 ${current} 时，搜索结果仍应包含其它分类的案例`);
  }
  // 与分类内搜索形成对照：filterCases 才会被分类限定，两者语义必须不同
  assert.deepEqual(filterCases('crypto', kw), [], '分类内搜索确实受分类限定');
  assert.ok(searchCases(kw).length > 0, '全局搜索不受分类限定');
});

test('多关键词为 AND 关系', () => {
  const r = searchCases('安全账户 转账');
  assert.ok(r.length > 0);
  for (const c of r) {
    const hay = searchableFields(c).join(' ');
    assert.ok(hay.includes('安全账户') && hay.includes('转账'), `${c.id} 不该命中 AND 查询`);
  }
  assert.equal(searchCases('安全账户 不可能存在的词xyz').length, 0);
});

test('搜索可命中正文深处的内容（不只是标题）', () => {
  // 「屏幕共享」只出现在 c010 的 method 与 action 里，不在标题也不在 say
  assert.ok(!CASES.c010.title.includes('屏幕共享'));
  assert.ok(!CASES.c010.say.some((s) => s.includes('屏幕共享')));
  const r = searchCases('屏幕共享');
  assert.ok(r.length > 0);
  assert.ok(r.some((c) => c.id === 'c010'));
});

test('casesByCategory 与索引一致，all 返回全量', () => {
  assert.equal(casesByCategory('all').length, ALL.length);
  assert.equal(casesByCategory(null).length, ALL.length);
  assert.deepEqual(casesByCategory('pig').map((c) => c.id), casesOfCategory('pig').map((c) => c.id));
  assert.deepEqual(casesByCategory('不存在的类'), []);
});

test('filterCases 在分类内搜索（分类页语义）', () => {
  const r = filterCases('police', '安全账户');
  assert.ok(r.length > 0);
  assert.ok(r.every((c) => c.catId === 'police'), '分类内搜索不应混入其它分类');
  // 与全局搜索对比：全局能查到别处的同关键词
  assert.ok(searchCases('安全账户').length >= r.length);
});

test('sortByDateDesc 倒序且稳定', () => {
  const s = sortByDateDesc(ALL);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].date >= s[i].date);
  const a = sortByDateDesc([CASES.c004, CASES.c004]);
  assert.equal(a[0].id, a[1].id, '同日应保持稳定顺序');
});

test('paginate 基本分页', () => {
  const list = Array.from({ length: 15 }, (_, i) => ({ id: i }));
  const p1 = paginate(list, 1, 7);
  assert.equal(p1.items.length, 7);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.total, 15);
  assert.equal(p1.page, 1);
  const p3 = paginate(list, 3, 7);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.page, 3);
});

test('paginate 越界与空集不抛错', () => {
  assert.equal(paginate([], 1, 6).totalPages, 1, '空集仍应有一页');
  assert.equal(paginate([], 1, 6).items.length, 0);
  assert.equal(paginate(ALL, 999, 6).page, paginate(ALL, 999, 6).totalPages, '超界应夹到最后一页');
  assert.equal(paginate(ALL, -5, 6).page, 1, '负数页码夹到 1');
  assert.equal(paginate(ALL, 1, 0).pageSize, 1, 'pageSize 至少为 1');
});

test('categoryStats 计数与实际一致', () => {
  const s = categoryStats();
  assert.equal(s.length, CASE_CATEGORIES.length);
  assert.equal(s.reduce((a, b) => a + b.count, 0), ALL.length);
  for (const x of s) assert.ok(x.count > 0, `${x.name} 计数为 0`);
});

test('getCase / getCategory 与非法输入', () => {
  assert.equal(getCase('c001').id, 'c001');
  assert.equal(getCase('不存在'), null);
  assert.equal(getCategory('pig').name, '杀猪盘');
  assert.equal(getCategory('不存在'), null);
});

test('formatDate 输出可读中文日期', () => {
  assert.equal(formatDate('2026-03-14'), '2026年03月14日');
  assert.equal(formatDate('乱码'), '乱码');
});