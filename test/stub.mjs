const suites = [
  {id: 1, title: 'Root A', parent_id: null},
  {id: 2, title: '[SETUP]', parent_id: 1},
  {id: 3, title: '[TEARDOWN]', parent_id: 1},
  {id: 4, title: 'Root B', parent_id: null},
  {id: 5, title: '[SETUP]', parent_id: 4},
  {id: 6, title: 'Deep', parent_id: 5},
  {id: 7, title: 'Deeper', parent_id: 6},
];
const cases = [
  {id: 100, title: 'Setup namespace', suite_id: 2},
  {id: 101, title: 'Delete cluster', suite_id: 3},
  {id: 102, title: 'Get credential', suite_id: 2},
  {id: 103, title: 'Shared title', suite_id: 5},
  {id: 104, title: 'Ambiguous one', suite_id: 2},
  {id: 105, title: 'Ambiguous one', suite_id: 2},
  {id: 106, title: 'Orphan case', suite_id: 3},
  {id: 107, title: 'Dup target', suite_id: 2},
  {id: 108, title: 'Renamed in qase', suite_id: 2},
  {id: 110, title: 'Common', suite_id: 1},
  {id: 111, title: 'Common', suite_id: 2},
  {id: 112, title: 'Common', suite_id: 4},
  {id: 113, title: 'Common', suite_id: 5},
  {id: 114, title: 'Common', suite_id: 6},
  {id: 115, title: 'Common', suite_id: 7},
  {id: 117, title: 'EQ-117: Prefixed on the Qase side', suite_id: 2},
];
// 250 fillers: forces qaseFetchAll past its 100-per-page limit.
for (let i = 0; i < 250; i += 1) cases.push({id: 1000 + i, title: `Filler ${i}`, suite_id: 7});

globalThis.fetch = async (url) => {
  const {pathname, searchParams} = new URL(url);
  const all = pathname.includes('/suite/') ? suites : cases;
  const offset = Number(searchParams.get('offset'));
  const limit = Number(searchParams.get('limit'));
  return {
    ok: true,
    json: async () => ({status: true, result: {total: all.length, entities: all.slice(offset, offset + limit)}}),
  };
};
