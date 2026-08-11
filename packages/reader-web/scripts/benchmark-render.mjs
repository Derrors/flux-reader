import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/app/flux-reader/',
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  DOMParser: dom.window.DOMParser,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});

const [{ createMarkdownSnapshot }, parserModule] = await Promise.all([
  import('../src/markdown/pipeline.js'),
  import('html-react-parser'),
]);
const parseReact = parserModule.default;

const SHAPES = {
  prose: [
    '# Long document',
    '',
    'A deterministic paragraph with **bold**, _emphasis_, and [a link](https://example.com).',
    '',
  ].join('\n'),
  dense: [
    '## Dense section',
    '',
    '- item one',
    '- item two',
    '- item three',
    '',
  ].join('\n'),
  code: [
    '### Code sample',
    '',
    '```javascript',
    'export function value(input) { return input + 1; }',
    '```',
    '',
  ].join('\n'),
  mixed: [
    '## Mixed section',
    '',
    '| name | value |',
    '| --- | ---: |',
    '| alpha | 1 |',
    '',
    'Inline math $x^2 + y^2$ and ordinary prose.',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
  ].join('\n'),
};

function requestedSizes() {
  const value = process.env.FLUX_READER_BENCHMARK_MIB || '0.1,1';
  const sizes = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 10);
  if (sizes.length === 0) {
    throw new Error('FLUX_READER_BENCHMARK_MIB must contain values between 0 and 10');
  }
  return sizes;
}

function generateMarkdown(shape, mib) {
  const unit = SHAPES[shape];
  const targetBytes = Math.floor(mib * 1024 * 1024);
  const repeats = Math.max(1, Math.ceil(targetBytes / Buffer.byteLength(unit)));
  return unit.repeat(repeats);
}

function measure(callback) {
  const started = performance.now();
  const value = callback();
  return { value, milliseconds: performance.now() - started };
}

const results = [];
for (const mib of requestedSizes()) {
  for (const shape of Object.keys(SHAPES)) {
    globalThis.gc?.();
    const content = generateMarkdown(shape, mib);
    const rssBefore = process.memoryUsage().rss;
    const snapshot = measure(() => createMarkdownSnapshot(content));
    const reactParsed = measure(() => parseReact(snapshot.value.safeHtml));
    const domParsed = measure(
      () => new DOMParser().parseFromString(snapshot.value.safeHtml, 'text/html'),
    );
    const nodeCount = domParsed.value.body.querySelectorAll('*').length;
    const rssAfter = process.memoryUsage().rss;

    results.push({
      shape,
      requestedMiB: mib,
      sourceBytes: Buffer.byteLength(content),
      htmlBytes: Buffer.byteLength(snapshot.value.safeHtml),
      tocItems: snapshot.value.toc.length,
      domNodes: nodeCount,
      timingsMs: {
        sharedSnapshot: Number(snapshot.milliseconds.toFixed(2)),
        htmlToReact: Number(reactParsed.milliseconds.toFixed(2)),
        htmlToDom: Number(domParsed.milliseconds.toFixed(2)),
      },
      rssDeltaBytes: rssAfter - rssBefore,
    });

    void reactParsed.value;
    dom.window.document.body.replaceChildren();
  }
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  results,
}, null, 2)}\n`);
