export async function writeClipboardText(text) {
  const nativeHandler = globalThis.webkit?.messageHandlers?.copyText;
  if (typeof nativeHandler?.postMessage === 'function') {
    nativeHandler.postMessage(text);
    return;
  }

  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (typeof writeText !== 'function') {
    throw new Error('Clipboard API is unavailable');
  }
  await writeText.call(globalThis.navigator.clipboard, text);
}
