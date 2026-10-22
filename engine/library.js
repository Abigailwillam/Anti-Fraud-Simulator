/**
 * 案例库检索引擎 · 纯函数集合（可单测，无副作用）
 *
 * 一条硬性设计约束（对应需求「搜索结果不受当前分类筛选状态影响」）：
 *   searchCases() 的输入只有「关键词」，完全不接收分类参数。
 *   也就是说，搜索永远在全量案例范围内匹配 —— 这不是靠调用方自觉，
 *   而是靠函数签名从类型层面就不允许传入分类。
 */
import { CASES, CASE_CATEGORIES, CATEGORY_INDEX } from '../kb/cases.js';

/**
 * 归一化：转小写 + 把连续空白折叠为单个空格。
 * 注意不能删掉空白——多关键词搜索靠空格分词，全删会让「安全账户 转账」
 * 变成一个不存在的词，导致多关键词搜索整体失效。
 */
export function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 单条案例的可搜索文本（标题/摘要/分类/标签/正文各处）。
 * 用一个数组而不是长串拼接，是为了在测试里能直接断言某个词来自哪个字段。
 */
export function searchableFields(c) {
  const cat = CASE_CATEGORIES.find((x) => x.id === c.catId);
  return [
    c.title,
    c.summary,
    cat ? cat.name : '',
    (c.tags || []).join(' '),
    (c.method || []).join(' '),
    (c.say || []).join(' '),
    (c.cracks || []).join(' '),
    (c.action || []).join(' '),
  ].map(normalize);
}

/**
 * 关键词搜索。全量匹配，不受任何分类筛选影响。
 * 支持空格分隔多关键词（AND 关系）。
 * @param {string} keyword
 * @param {any[]} [pool] 仅测试用；产品代码不要传，避免误把搜索限定到某个子集
 * @returns {any[]}
 */
export function searchCases(keyword, pool) {
  const source = pool || Object.values(CASES);
  const keys = normalize(keyword).split(' ').filter(Boolean);
  if (keys.length === 0) return source.slice();
  return source.filter((c) => {
    const hay = searchableFields(c).join(' ');
    return keys.every((k) => hay.includes(k));
  });
}

/**
 * 按分类取案例。catId 为 null/'all' 时返回全部。
 * @param {string|null} catId
 */
export function casesByCategory(catId) {
  if (!catId || catId === 'all') return Object.values(CASES);
  return (CATEGORY_INDEX[catId] || []).map((id) => CASES[id]);
}

/**
 * 组合筛选：分类 + 关键词。此处关键词仍然作用于「该分类的子集」，
 * 这是分类页内的正常语义；跨分类的全局搜索请用 searchCases()。
 * @param {string|null} catId
 * @param {string} keyword
 */
export function filterCases(catId, keyword) {
  return searchCases(keyword, casesByCategory(catId));
}

/** 排序：按日期倒序（同日按 id 稳定排序，保证可复现） */
export function sortByDateDesc(list) {
  return list.slice().sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1));
}

/**
 * 分页切片。纯计算，越界时返回空数组而非抛错。
 * @param {any[]} list
 * @param {number} page 从 1 开始
 * @param {number} pageSize
 */
export function paginate(list, page = 1, pageSize = 6) {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (p - 1) * size;
  return { items: list.slice(start, start + size), page: p, totalPages, total, pageSize: size };
}

/**
 * 分类统计：案例数、危险度分布。用于分类网格上的角标。
 * @returns {{id:string,name:string,count:number,high:number}[]
 */
export function categoryStats() {
  return CASE_CATEGORIES.map((c) => {
    const list = (CATEGORY_INDEX[c.id] || []).map((id) => CASES[id]);
    return {
      id: c.id,
      name: c.name,
      count: list.length,
      high: list.filter((x) => x.severity === '高危').length,
    };
  });
}

/** 格式化为 YYYY-MM-DD */
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[1]}年${m[2]}月${m[3]}日` : String(iso || '');
}