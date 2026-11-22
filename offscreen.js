// Documento "offscreen": o service worker não consegue criar link de download (URL.createObjectURL),
// então ele manda o arquivo para cá, daqui sai um blob: URL que o chrome.downloads sabe baixar.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;
  if (message.action === "BLOB_URL") {
    try {
      const bin = atob(message.base64 || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: message.mime || "application/octet-stream" }));
      sendResponse({ ok: true, url });
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
    return false;
  }
  if (message.action === "REVOKE") {
    try { URL.revokeObjectURL(message.url); } catch (_) { /* já revogado */ }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
