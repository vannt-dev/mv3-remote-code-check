import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRemoteCode, locateRemoteCode, stripRemoteCode } from '../src/index.ts';

test('finds the address the Chrome Web Store quoted when it rejected a package (jsPDF PDFObject)', () => {
  const code = 'e.src="https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js"';
  assert.deepEqual(findRemoteCode(code), ['https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js']);
});

test('an address on a script CDN counts whatever its ending, also without a scheme', () => {
  assert.deepEqual(findRemoteCode('workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@v"+v'), [
    'https://cdn.jsdelivr.net/npm/tesseract.js@v',
  ]);
  assert.deepEqual(findRemoteCode('x = "//unpkg.com/lib"'), ['//unpkg.com/lib']);
  assert.deepEqual(findRemoteCode('import("https://esm.sh/preact")'), ['https://esm.sh/preact']);
});

test('a script or wasm file on any host counts, with or without a query', () => {
  assert.deepEqual(findRemoteCode('importScripts("https://example.com/a/worker.js?v=2")'), ['https://example.com/a/worker.js?v=2']);
  assert.deepEqual(findRemoteCode('fetch("https://example.com/core.wasm")'), ['https://example.com/core.wasm']);
  assert.deepEqual(findRemoteCode('s.src = "//example.org/lib.mjs"'), ['//example.org/lib.mjs']);
});

test('script tags naming another host, or built at run time', () => {
  const [tag] = locateRemoteCode('<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>');
  assert.equal(tag?.rule, 'script-tag');
  const [built] = locateRemoteCode("w.document.write('<script src=\"' + url + '\"></script>')");
  assert.equal(built?.rule, 'script-tag-built');
});

test('leaves alone what is not code on another host', () => {
  const clean = [
    'fetch("https://api.example.com/v1/items")',
    '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">',
    '<a href="https://example.com/docs">docs</a>',
    'const worker = new Worker("./worker.js")',
    '<script src="popup.js"></script>',
    '// see https://github.com/jquery/jquery/blob/master/src/event.js',
    'https://example.com/file.json',
  ];
  for (const code of clean) assert.deepEqual(findRemoteCode(code), [], code);
});

test('reports line and column', () => {
  const [found] = locateRemoteCode('a\nbb\n  x="https://unpkg.com/x"');
  assert.deepEqual([found?.line, found?.column], [3, 6]);
});

test('stripRemoteCode removes CDN addresses and refuses jsPDF pdfobjectnewwindow', () => {
  const jspdf =
    'switch(t){case "pdfobjectnewwindow":var s="https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js";w.write(s);' +
    'case "pdfjsnewwindow":return 1}';
  const out = stripRemoteCode(jspdf);
  assert.match(out, /throw new Error\("The option pdfobjectnewwindow is not part of this build\."\)/);
  assert.match(out, /case "pdfjsnewwindow"/);
  assert.deepEqual(findRemoteCode(out), []);

  const tess = 'corePath:"https://cdn.jsdelivr.net/npm/tesseract.js-core@v"+e';
  assert.equal(stripRemoteCode(tess), 'corePath:""+e');
  assert.equal(stripRemoteCode(jspdf, { jspdf: false }).includes('pdfobjectnewwindow":var s=""'), true);
});
