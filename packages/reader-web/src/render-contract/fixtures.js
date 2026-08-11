import manifest from '../../test/fixtures/render-contract/manifest.json';

const markdownModules = import.meta.glob(
  '../../test/fixtures/render-contract/*.md',
  { eager: true, query: '?raw', import: 'default' },
);

const markdownByFile = new Map(
  Object.entries(markdownModules).map(([modulePath, content]) => [
    modulePath.split('/').pop(),
    content,
  ]),
);

export const renderContractManifest = manifest;

export function renderContractCase(file) {
  const contractCase = manifest.cases.find((candidate) => candidate.file === file);
  const content = markdownByFile.get(file);
  if (!contractCase || typeof content !== 'string') return null;
  return { ...contractCase, content };
}

export function assertRenderContract(root, contractCase, { terminal = false } = {}) {
  const failures = [];
  const assertions = [
    ['selectorCounts', contractCase.selectorCounts],
    ['selectorMinimums', contractCase.selectorMinimums],
    ...(terminal
      ? [
        ['selectorCounts', contractCase.terminal?.selectorCounts],
        ['selectorMinimums', contractCase.terminal?.selectorMinimums],
      ]
      : []),
  ];

  for (const [kind, selectors] of assertions) {
    for (const [selector, expected] of Object.entries(selectors || {})) {
      const actual = root.querySelectorAll(selector).length;
      if (kind === 'selectorCounts' && actual !== expected) {
        failures.push(`${selector}: expected ${expected}, received ${actual}`);
      }
      if (kind === 'selectorMinimums' && actual < expected) {
        failures.push(`${selector}: expected at least ${expected}, received ${actual}`);
      }
    }
  }

  const visibleText = root.textContent || '';
  for (const text of contractCase.textIncludes || []) {
    if (!visibleText.includes(text)) failures.push(`missing text: ${text}`);
  }

  if (contractCase.codeSources) {
    const sources = [...root.querySelectorAll('.code-block-body')]
      .map((element) => element.textContent);
    contractCase.codeSources.forEach((source, index) => {
      if (sources[index] !== source) {
        failures.push(`code source ${index}: expected ${JSON.stringify(source)}, received ${JSON.stringify(sources[index])}`);
      }
    });
  }

  return failures;
}
