// Shared, side-effect-free list operations (also loaded by the regression tests).
(function (root) {
  function dateRange(start, end) {
    function parse(value, nextDay) {
      if (!value) return 0;
      const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!parts) throw new Error('请输入有效日期');
      const [, y, m, d] = parts.map(Number);
      const date = new Date(y, m - 1, d);
      if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d)
        throw new Error('请输入有效日期');
      if (nextDay) date.setDate(date.getDate() + 1);
      return Math.floor(date.getTime() / 1000) - (nextDay ? 1 : 0);
    }
    const range = { start: parse(start, false), end: parse(end, true) };
    if (range.start && range.end && range.start > range.end)
      throw new Error('开始日期不能晚于结束日期');
    return range;
  }

  function batchIds(items, scope, range, authors) {
    const names = new Set(authors);
    return items.filter(it => {
      if (it.status === 1) return false;
      if (scope === 'author') return names.has(it.author);
      if (scope === 'time') return (!range.start || it.createTime >= range.start)
        && (!range.end || it.createTime <= range.end);
      return scope === 'all';
    }).map(it => it.awemeId);
  }

  function sortItems(items, order) {
    const result = items.slice();
    const text = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true });
    const newest = (a, b) => (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
    result.sort((a, b) => {
      let comparison = 0;
      if (order === 'oldest') comparison = -newest(a, b);
      else if (order === 'author') comparison = text(a.author, b.author) || newest(a, b);
      else if (order === 'title') comparison = text(a.desc, b.desc) || newest(a, b);
      else comparison = newest(a, b);
      return comparison || text(a.awemeId, b.awemeId);
    });
    return result;
  }

  const api = { dateRange, batchIds, sortItems };
  root.MyLikeLibrary = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
