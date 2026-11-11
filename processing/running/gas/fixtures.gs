// Test actor only. The synchronizer never calls these scenario functions.
function miSpec(key, variant) {
  if (key === 'control') return miConfig().control[variant === 'open' ? 'open' : 'closed'];
  const source = miConfig().sources.find(s => s.key === key); miAssert(source, 'UNKNOWN_SOURCE_KEY'); return source;
}
function miCheckExpected(files, stage) {
  const keys = Object.values(files).map(f => f.appProperties.key).sort();
  miAssert(JSON.stringify(keys) === JSON.stringify([...stage.active].sort()), 'FIXTURE_INVENTORY_MISMATCH');
  for (const f of Object.values(files)) {
    const spec = miSpec(f.appProperties.key, stage.variant);
    miAssert(Number(f.size) === spec.size && f.md5Checksum === spec.md5, 'FIXTURE_CONTENT_MISMATCH');
  }
}
function miMutateFixture(stage) {
  if (stage.action === 'none') return;
  miOwned(miMeta(mi.root.raw), 'folder', mi.root.folder); miOwned(miMeta(mi.root.parked), 'folder', mi.root.folder);
  const key = stage.key, id = miAllocate('fixture-' + key), source = miSpec(key, stage.variant);
  let meta = miMeta(id, true);
  if (stage.action === 'add') {
    if (!meta) {
      const metadata = miMetadata(id, key + '.csv', 'fixture', mi.root.raw, { key });
      if (key === 'control') meta = miCreate(metadata, MP_SYNC.controlCsv(false));
      else {
        const original = miMeta(source.id);
        const config = miConfig(), diagnosis = MP_SYNC.originalSourceDiagnostics(original, source, config.sourceFolder, config.sources.indexOf(source), miSourceAncestor);
        if (!diagnosis.passesOriginalGuard) {
          const error = Error('ORIGINAL_SOURCE_CHANGED'); error.sourceDiagnostics = diagnosis; throw error;
        }
        meta = miApi('files/' + miId(source.id) + '/copy?ignoreDefaultVisibility=true&fields=' + encodeURIComponent(MI_FIELDS), 'post', metadata);
      }
    }
    miOwned(meta, 'fixture', mi.root.raw);
    miAssert(meta.md5Checksum === source.md5 && Number(meta.size) === source.size, 'FIXTURE_COPY_MISMATCH'); return;
  }
  miOwned(meta, 'fixture', null, true);
  miAssert(meta.parents?.length === 1 && [mi.root.raw, mi.root.parked].includes(meta.parents[0]) && meta.appProperties.key === key, 'FIXTURE_PARENT_CHANGED');
  const path = 'files/' + id, fields = '&fields=' + encodeURIComponent(MI_FIELDS);
  if (stage.action === 'edit') {
    const content = MP_SYNC.controlCsv(true);
    if (meta.md5Checksum !== source.md5) meta = miApi(path + '?uploadType=media' + fields, 'patch', content, true);
    miAssert(meta.md5Checksum === source.md5, 'FIXTURE_EDIT_MISMATCH');
  } else if (stage.action === 'rename') {
    if (meta.name !== 'renamed-source.csv') miApi(path + '?fields=' + encodeURIComponent(MI_FIELDS), 'patch', { name: 'renamed-source.csv' });
  } else if (stage.action === 'move_out' || stage.action === 'move_back') {
    const target = stage.action === 'move_out' ? mi.root.parked : mi.root.raw;
    if (meta.parents[0] !== target) miApi(path + '?addParents=' + target + '&removeParents=' + meta.parents[0] + fields, 'patch', {});
  } else if (stage.action === 'trash' || stage.action === 'restore') {
    const trashed = stage.action === 'trash';
    if (!!meta.trashed !== trashed) miApi(path + '?fields=' + encodeURIComponent(MI_FIELDS), 'patch', { trashed });
  } else throw Error('UNKNOWN_FIXTURE_ACTION');
}
