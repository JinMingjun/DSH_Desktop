const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
let plugin;
const storage = new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/dsh-attachments/lib/client.js'), 'utf8'), {
  window: {
    __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})); } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  },
  File, Uint8Array, atob,
});

function fixture({ draft = '请分析', saved = [] } = {}) {
  storage.clear();
  storage.set('dsa:draft:test', JSON.stringify(saved));
  let state = { draft, draftRev: 0, occurrences: [], imageIds: [], phase: 'plain' };
  const notices = [], edits = [], registry = new Map();
  let sequence = 0;
  const input = {
    state: { getSnapshot: () => state },
    notify: (level, text) => notices.push(text),
    insertReference(ref, span) {
      assert.equal(span.draftRev, state.draftRev);
      const clipboardOffset = at => at + state.occurrences.filter(o => plugin.detectOffset(state, o.offset) < at).reduce((sum, o) => sum + o.length - 1, 0);
      const start = clipboardOffset(span.start), end = clipboardOffset(span.end);
      const text = ref.clipboardText + ' ';
      for (const occurrence of state.occurrences) if (occurrence.offset >= end) occurrence.offset += text.length - (end - start);
      state.occurrences.push({ ...ref, occurrenceId: ++sequence, offset: start, length: ref.clipboardText.length });
      state.occurrences.sort((a, b) => a.offset - b.offset);
      state.draft = state.draft.slice(0, start) + text + state.draft.slice(end);
      state.draftRev++;
      return true;
    },
    addImages(ids) { state.imageIds.push(...ids); return true; },
  };
  const conversation = {
    input: { for: () => input }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) },
    createDraftImages(files) { return files.map(file => { const image = { id: ++sequence, file }; registry.set(image.id, image); return image; }); },
    draftImages: ids => ids.map(id => registry.get(id)),
    releaseDraftImages: images => images.forEach(i => registry.delete(i.id)),
  };
  const actx = { get: () => conversation, bail(event, request) {
    edits.push(request);
    if (request.text === ' ') { state.draft += ' '; state.draftRev++; }
    return true;
  } };
  let limits;
  const binding = { session: { getSnapshot: () => ({}), projections: { faceOf: () => ({ getSnapshot: () => limits }) } } };
  let activeBinding = binding;
  const ctx = { conversation, sessions: { scope: () => actx, binding: () => activeBinding } };
  return { api: plugin.createSessionApi(ctx, 'test'), state, notices, edits, registry,
    setLimits: value => { limits = value; }, replaceBinding: () => { activeBinding = {}; } };
}
const documentFile = (name = '报告 你好.pdf') => ({ name, path: `D:\\资料\\${name}`, size: 1024 });
test('Windows, Chinese, whitespace, UNC and invalid path grammar', () => {
  assert.equal(plugin.mention('D:\\资料\\a.pdf'), '@D:\\资料\\a.pdf');
  assert.equal(plugin.mention('D:\\资料\\a b.pdf'), '@"D:\\资料\\a b.pdf"');
  assert.equal(plugin.mention('\\\\server\\share\\a.txt'), '@\\\\server\\share\\a.txt');
  for (const invalid of ['relative.txt', 'C:\\a"b', 'D:\\a\nb']) assert.throws(() => plugin.mention(invalid));
});
test('multi-select preserves text, separates references and deduplicates Windows paths', () => {
  const f = fixture();
  f.api.addFiles([documentFile(), documentFile('two.md'), documentFile()]);
  f.api.addFiles([{ name: 'two.md', path: 'd:/资料/TWO.md', size: 1024 }]);
  assert.equal(f.state.occurrences.length, 2);
  assert.ok(f.state.draft.startsWith('请分析 @"D:'));
  assert.equal(f.notices.length, 0);
  assert.equal(f.state.occurrences[0].source, 'dsh-attachments');
});
test('card-only attachments serialize into real DSH file mentions', async () => {
  const f = fixture();
  f.api.addFiles([documentFile()]);
  const ref = f.state.occurrences[0].ref;
  assert.equal(await plugin.attachmentCodec.serialize(ref), '@"D:\\资料\\报告 你好.pdf"');
  assert.equal(plugin.attachmentCodec.clipboardText(ref), '@"D:\\资料\\报告 你好.pdf"');
  assert.deepEqual(JSON.parse(ref), { path: 'D:\\资料\\报告 你好.pdf', name: '报告 你好.pdf', size: 1024 });
  await assert.rejects(plugin.attachmentCodec.serialize('{bad'));
});
test('restored drafts rebuild attachment cards, preserve surrounding text and do not convert manual mentions', () => {
  const first = documentFile(), second = documentFile('two.md');
  const ref = plugin.mention(first.path), other = plugin.mention(second.path);
  const f = fixture({ draft: `开头 ${ref} 中间 ${other} 结尾`, saved: [first, second, { path: 'bad', name: 'bad', size: 0 }] });
  f.api.syncDraft();
  assert.equal(f.state.occurrences.length, 2);
  assert.ok(f.state.draft.startsWith('开头 '));
  assert.ok(f.state.draft.endsWith(' 结尾'));
  assert.equal(JSON.parse(storage.get('dsa:draft:test')).length, 2);
  f.state.draft += ` ${ref}`; // Manually typed matching reference remains ordinary text.
  f.api.syncDraft();
  assert.equal(f.state.occurrences.length, 2);
  f.state.draft = ''; f.state.occurrences = [];
  f.api.syncDraft();
  assert.equal(storage.has('dsa:draft:test'), false);
});
test('delayed draft restoration retains saved attachments until the draft arrives', () => {
  const file = documentFile();
  const f = fixture({ draft: '', saved: [file] });
  f.api.syncDraft();
  assert.equal(JSON.parse(storage.get('dsa:draft:test')).length, 1);
  f.state.draft = plugin.mention(file.path);
  f.api.syncDraft();
  assert.equal(f.state.occurrences.length, 1);
});
test('remove targets the selected chip after previous chips, without replacing the draft', () => {
  const f = fixture();
  f.api.addFiles([documentFile(), documentFile('two.md')]);
  f.api.remove(f.state.occurrences[1].occurrenceId);
  const edit = f.edits.at(-1);
  assert.equal(edit.text, '');
  assert.equal(edit.span.start, '请分析 '.length + 2);
  assert.equal(edit.span.end, edit.span.start + 1);
  assert.equal(edit.span.draftRev, f.state.draftRev);
});
test('pictures become real browser image attachments and are deduplicated', () => {
  const f = fixture();
  const picture = { name: 'image.png', path: 'D:\\image.png', data: 'AQID', mediaType: 'image/png' };
  f.api.addFiles([picture, picture]);
  assert.equal(f.state.imageIds.length, 1);
  assert.equal(f.registry.values().next().value.file.type, 'image/png');
  assert.equal(f.state.occurrences.length, 0);
});
test('model image limits reject images while keeping valid documents', () => {
  const f = fixture();
  f.setLimits({ mediaTypes: ['image/png'], maxImageBytes: 2, maxImagesPerMessage: 1, maxMessageImageBytes: 2 });
  f.api.addFiles([{ name: 'image.png', path: 'D:\\image.png', data: 'AQID', mediaType: 'image/png' }, documentFile()]);
  assert.equal(f.state.imageIds.length, 0);
  assert.equal(f.state.occurrences.length, 1);
  assert.match(f.notices[0], /image.png/);
});
test('cancelled selection is empty; submission and released sessions refuse additions', () => {
  const f = fixture();
  f.api.addFiles([]);
  assert.equal(f.state.draft, '请分析');
  f.state.phase = 'submitting';
  assert.throws(() => f.api.addFiles([documentFile()]));
  f.state.phase = 'plain';
  f.replaceBinding();
  assert.throws(() => f.api.addFiles([documentFile()]));
});
test('desktop manifest adds separate client batches without duplicate profile plugins', () => {
  const window = {}; window.top = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/desktop-bootstrap.js'), 'utf8').replace('__DSH_ORIGIN__', 'http://127.0.0.1:3080'), { window, location: { origin: 'http://127.0.0.1:3080' } });
  window.__DSH_BOOT__ = { rev: 'original', entries: [{ id: 'core' }, { id: 'dsh-wallpaper' }], batches: [{ phase: 'application', entries: ['core', 'dsh-wallpaper'] }] };
  const graph = window.__DSH_BOOT__;
  assert.equal(graph.entries.length, 5);
  assert.equal(graph.entries.filter(e => e.id.includes('wallpaper')).length, 1);
  assert.equal(graph.batches.filter(b => b.entries.includes('dsh-desktop-attachments')).length, 1);
  assert.equal(graph.batches.filter(b => b.entries.includes('dsh-desktop-balance')).length, 1);
  assert.equal(graph.batches.filter(b => b.entries.includes('dsh-desktop-stats-surface')).length, 1);
});
