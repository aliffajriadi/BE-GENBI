export function paging(q: Record<string, unknown>) {
  const page = Math.max(1, Number(q.page) || 1);
  const take = Math.min(100, Math.max(1, Number(q.limit) || 20));
  return { page, take, skip: (page - 1) * take };
}
